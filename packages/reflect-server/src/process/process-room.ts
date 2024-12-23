// Processes zero or more mutations against a room, returning necessary pokes

import type {LogContext} from '@rocicorp/logger';
import type {Poke} from 'reflect-protocol';
import type {Env} from 'reflect-shared/src/types.js';
import {must} from 'shared/src/must.js';
import {fastForwardRoom} from '../ff/fast-forward.js';
import type {ClientDeleteHandler} from '../server/client-delete-handler.js';
import type {ClientDisconnectHandler} from '../server/client-disconnect-handler.js';
import type {DurableStorage} from '../storage/durable-storage.js';
import {EntryCache} from '../storage/entry-cache.js';
import type {ClientPoke} from '../types/client-poke.js';
import {
  IncludeDeleted,
  getClientRecord,
  putClientRecord,
} from '../types/client-record.js';
import type {ClientID, ClientMap} from '../types/client-state.js';
import {getConnectedClients} from '../types/connected-clients.js';
import type {PendingMutation} from '../types/mutation.js';
import {getVersion, putVersion} from '../types/version.js';
import {addPresence} from './add-presence.js';
import {processFrame} from './process-frame.js';
import type {MutatorMap} from './process-mutation.js';

export const FRAME_LENGTH_MS = 1000 / 60;
const FLUSH_SIZE_THRESHOLD_FOR_LOG_FLUSH = 500;

export async function processRoom(
  lc: LogContext,
  env: Env,
  clients: ClientMap,
  pendingMutations: PendingMutation[],
  numPendingMutationsToProcess: number,
  mutators: MutatorMap,
  clientDisconnectHandler: ClientDisconnectHandler,
  clientDeleteHandler: ClientDeleteHandler,
  storage: DurableStorage,
  shouldGCClients: (now: number) => boolean,
): Promise<Map<ClientID, Poke[]>> {
  const cache = new EntryCache(storage);
  const clientIDs = [...clients.keys()];
  lc.debug?.('processing room');

  const previousConnectedClients = await getConnectedClients(storage);

  // Before running any mutations, fast forward connected clients to
  // current state.
  let currentVersion = await getVersion(cache);
  if (currentVersion === undefined) {
    currentVersion = 0;
    await putVersion(currentVersion, cache);
  }
  lc.debug?.('currentVersion', currentVersion);
  const clientPokes: ClientPoke[] = await fastForwardRoom(
    lc,
    clientIDs,
    currentVersion,
    storage,
  );
  lc.debug?.(
    'clients with pokes from fastforward',
    clientPokes.map(clientPoke => clientPoke.clientID),
  );

  for (const ffClientPoke of clientPokes) {
    const cr = must(
      await getClientRecord(
        ffClientPoke.clientID,
        IncludeDeleted.Exclude,
        cache,
      ),
      `Client record not found: ${ffClientPoke.clientID}`,
    );
    cr.baseCookie = ffClientPoke.poke.cookie;
    await putClientRecord(ffClientPoke.clientID, cr, cache);
  }

  clientPokes.push(
    ...(await processFrame(
      lc,
      env,
      pendingMutations,
      numPendingMutationsToProcess,
      mutators,
      clientDisconnectHandler,
      clientDeleteHandler,
      clients,
      cache,
      shouldGCClients,
    )),
  );

  const pokesByClientID = groupByClientID(clientPokes);
  const nextConnectedClients = await getConnectedClients(cache);

  await addPresence(
    clients,
    pokesByClientID,
    cache,
    previousConnectedClients,
    nextConnectedClients,
  );

  const startCacheFlush = Date.now();
  const pendingCounts = cache.pendingCounts();
  lc = lc.withContext('cacheFlushDelCount', pendingCounts.delCount);
  lc = lc.withContext('cacheFlushPutCount', pendingCounts.putCount);
  lc.debug?.('Starting cache flush.', pendingCounts);
  // In case this "large" flush causes the DO to be reset because of:
  // "Durable Object storage operation exceeded timeout which caused object to
  // be reset", flush the logs for debugging.
  if (
    pendingCounts.delCount + pendingCounts.putCount >
    FLUSH_SIZE_THRESHOLD_FOR_LOG_FLUSH
  ) {
    lc.info?.('Starting large cache flush.', pendingCounts);
    void lc.flush();
  }
  await cache.flush();
  const cacheFlushLatencyMs = Date.now() - startCacheFlush;
  lc = lc.withContext('cacheFlushTiming', cacheFlushLatencyMs);
  lc.info?.(
    `Finished cache flush in ${cacheFlushLatencyMs} ms.`,
    pendingCounts,
  );
  return pokesByClientID;
}

function groupByClientID(clientPokes: ClientPoke[]): Map<ClientID, Poke[]> {
  const pokesByClientID = new Map<ClientID, Poke[]>();
  for (const clientPoke of clientPokes) {
    let pokes = pokesByClientID.get(clientPoke.clientID);
    if (!pokes) {
      pokes = [];
      pokesByClientID.set(clientPoke.clientID, pokes);
    }
    pokes.push(clientPoke.poke);
  }
  return pokesByClientID;
}
