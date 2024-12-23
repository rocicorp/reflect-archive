import type {LogContext} from '@rocicorp/logger';
import type {Env} from 'reflect-shared/src/types.js';
import type {RoomStartHandler} from '../server/room-start.js';
import {EntryCache} from '../storage/entry-cache.js';
import {
  NOOP_MUTATION_ID,
  ReplicacheTransaction,
} from '../storage/replicache-transaction.js';
import type {Storage} from '../storage/storage.js';
import {getVersion, putVersion} from '../types/version.js';

// Processes the onRoomStart. Errors in starting the room are logged
// and thrown for the caller to handle appropriately (i.e. consider the room
// to be in an invalid state).
export async function processRoomStart(
  lc: LogContext,
  env: Env,
  onRoomStart: RoomStartHandler,
  storage: Storage,
  roomID: string,
): Promise<void> {
  lc.debug?.('processing room start');

  const cache = new EntryCache(storage);
  const startVersion = (await getVersion(cache)) ?? 0;
  const nextVersion = startVersion + 1;

  const tx = new ReplicacheTransaction(
    cache,
    '', // clientID,
    NOOP_MUTATION_ID,
    nextVersion,
    undefined,
    env,
  );
  try {
    await onRoomStart(tx, roomID);
    if (!cache.isDirty()) {
      lc.debug?.('noop onRoomStart');
      return;
    }
    await putVersion(nextVersion, cache);
    await cache.flush();
    lc.debug?.(`finished onRoomStart (${startVersion} => ${nextVersion})`);
  } catch (e) {
    lc.info?.('onRoomStart failed', e);
    throw e;
  }
}
