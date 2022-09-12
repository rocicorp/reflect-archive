import type {LogContext} from '@rocicorp/logger';
import {assertHash, Hash, hashOf} from '../hash';
import * as btree from '../btree/mod';
import * as dag from '../dag/mod';
import * as db from '../db/mod';
import type * as sync from '../sync/mod';
import type {ReadonlyJSONValue} from '../json';
import {
  assert,
  assertNotUndefined,
  assertNumber,
  assertObject,
  assertString,
} from '../asserts';
import {hasOwn} from '../has-own';
import {uuid as makeUuid} from '../uuid';
import {
  assertSnapshotCommitDD31,
  compareCookies,
  CreateIndexDefinition,
  getRefs,
  newSnapshotCommitData,
  newSnapshotCommitDataDD31,
} from '../db/commit';
import type {ClientID} from '../sync/ids';
import {Branch, getBranch, mutatorNamesEqual, setBranch} from './branches';
import {IndexDefinitions, indexDefinitionsEqual} from '../index-defs';
import {CastReason, InternalValue, safeCastToJSON} from '../internal-value.js';
import {createIndexBTree} from '../db/write.js';
import type {MaybePromise} from '../replicache.js';

export type ClientMap = ReadonlyMap<sync.ClientID, ClientSDD | ClientDD31>;

export type ClientSDD = {
  /**
   * A UNIX timestamp in milliseconds updated by the client once a minute
   * while it is active and every time the client persists its state to
   * the perdag.
   * Should only be updated by the client represented by this structure.
   */
  readonly heartbeatTimestampMs: number;
  /**
   * The hash of the commit in the perdag this client last persisted.
   * Should only be updated by the client represented by this structure.
   */
  readonly headHash: Hash;
  /**
   * The mutationID of the commit at headHash (mutationID if it is a
   * local commit, lastMutationID if it is an index change or snapshot commit).
   * Should only be updated by the client represented by this structure.
   * Read by other clients to determine if there are unacknowledged pending
   * mutations for them to push on behalf of the client represented by this
   * structure.
   * This is redundant with information in the commit graph at headHash,
   * but allows other clients to determine if there are unacknowledged pending
   * mutations without having to load the commit graph at headHash.
   */
  readonly mutationID: number;
  /**
   * The highest lastMutationID received from the server for this client.
   *
   * Should be updated by the client represented by this structure whenever
   * it persists its state to the perdag.
   * Read by other clients to determine if there are unacknowledged pending
   * mutations for them to push on behalf of the client represented by this
   * structure, and *updated* by other clients upon successfully pushing
   * pending mutations to avoid redundant pushes of those mutations.
   *
   * Note: This will be the same as the lastMutationID of the base snapshot of
   * the commit graph at headHash when written by the client represented by this
   * structure.  However, when written by another client pushing pending
   * mutations on this client's behalf it will be different.  This is because
   * the other client does not update the commit graph (it is unsafe to update
   * another client's commit graph).
   */
  readonly lastServerAckdMutationID: number;
};

export type ClientDD31 = {
  readonly heartbeatTimestampMs: number;
  readonly headHash: Hash;

  // TODO(arv, DD31): We should not use undefined here. Use required null instead?
  /**
   * The hash of a commit we are in the middle of refreshing into this client's
   * memdag.
   */
  readonly tempRefreshHash?: Hash;

  /**
   * ID of this client's perdag branch. This needs to be sent in pull request
   * (to enable syncing all last mutation ids in the branch).
   */
  readonly branchID: sync.BranchID;
};

export type Client = ClientSDD | ClientDD31;

export function isClientDD31(client: Client): client is ClientDD31 {
  return DD31 && (client as ClientDD31).branchID !== undefined;
}

export function isClientSDD(client: Client): client is ClientSDD {
  return !DD31 || (client as ClientSDD).lastServerAckdMutationID !== undefined;
}

export const CLIENTS_HEAD_NAME = 'clients';

function assertClient(value: unknown): asserts value is Client {
  assertClientBase(value);

  if (typeof value.mutationID === 'number') {
    assertNumber(value.lastServerAckdMutationID);
  } else {
    const {tempRefreshHash} = value;
    if (tempRefreshHash) {
      assertHash(tempRefreshHash);
    }
    assertString(value.branchID);
  }
}

function assertClientBase(value: unknown): asserts value is {
  heartbeatTimestampMs: number;
  headHash: Hash;
  [key: string]: unknown;
} {
  assertObject(value);
  const {heartbeatTimestampMs, headHash} = value;
  assertNumber(heartbeatTimestampMs);
  assertHash(headHash);
}

export function assertClientSDD(value: unknown): asserts value is ClientSDD {
  assertClientBase(value);
  const {mutationID, lastServerAckdMutationID} = value;
  assertNumber(mutationID);
  assertNumber(lastServerAckdMutationID);
}

export function assertClientDD31(value: unknown): asserts value is ClientDD31 {
  assert(DD31);
  assertClientBase(value);
  const {tempRefreshHash} = value;
  if (tempRefreshHash) {
    assertHash(tempRefreshHash);
  }
  assertString(value.branchID);
}

function chunkDataToClientMap(chunkData: unknown): ClientMap {
  assertObject(chunkData);
  const clients = new Map();
  for (const key in chunkData) {
    if (hasOwn(chunkData, key)) {
      const value = chunkData[key];
      if (value !== undefined) {
        assertClient(value);
        clients.set(key, value);
      }
    }
  }
  return clients;
}

function clientMapToChunkData(
  clients: ClientMap,
  dagWrite: dag.Write,
): ReadonlyJSONValue {
  clients.forEach(client => {
    dagWrite.assertValidHash(client.headHash);
    if (isClientDD31(client) && client.tempRefreshHash) {
      dagWrite.assertValidHash(client.tempRefreshHash);
    }
  });
  return Object.fromEntries(clients);
}

function clientMapToChunkDataNoHashValidation(
  clients: ClientMap,
): ReadonlyJSONValue {
  return Object.fromEntries(clients);
}

export async function getClients(dagRead: dag.Read): Promise<ClientMap> {
  const hash = await dagRead.getHead(CLIENTS_HEAD_NAME);
  return getClientsAtHash(hash, dagRead);
}

async function getClientsAtHash(
  hash: Hash | undefined,
  dagRead: dag.Read,
): Promise<ClientMap> {
  if (!hash) {
    return new Map();
  }
  const chunk = await dagRead.getChunk(hash);
  return chunkDataToClientMap(chunk?.data);
}

/**
 * Used to signal that a client does not exist. Maybe it was garbage collected?
 */
export class ClientStateNotFoundError extends Error {
  name = 'ClientStateNotFoundError';
  readonly id: string;
  constructor(id: sync.ClientID) {
    super(`Client state not found, id: ${id}`);
    this.id = id;
  }
}

/**
 * Throws a `ClientStateNotFoundError` if the client does not exist.
 */
export async function assertHasClientState(
  id: sync.ClientID,
  dagRead: dag.Read,
): Promise<void> {
  if (!(await hasClientState(id, dagRead))) {
    throw new ClientStateNotFoundError(id);
  }
}

export async function hasClientState(
  id: sync.ClientID,
  dagRead: dag.Read,
): Promise<boolean> {
  return !!(await getClient(id, dagRead));
}

export async function getClient(
  id: sync.ClientID,
  dagRead: dag.Read,
): Promise<Client | undefined> {
  const clients = await getClients(dagRead);
  return clients.get(id);
}

export async function initClient(
  lc: LogContext,
  perdag: dag.Store,
  mutatorNames: string[],
  indexes: IndexDefinitions,
): Promise<[sync.ClientID, Client, ClientMap]> {
  if (DD31) {
    return initClientDD31(lc, perdag, mutatorNames, indexes);
  }

  const newClientID = makeUuid();
  const updatedClients = await updateClients(async clients => {
    let bootstrapClient: Client | undefined;
    for (const client of clients.values()) {
      if (
        !bootstrapClient ||
        bootstrapClient.heartbeatTimestampMs < client.heartbeatTimestampMs
      ) {
        bootstrapClient = client;
      }
    }

    let newClientCommitData;
    const chunksToPut = [];
    if (bootstrapClient) {
      const constBootstrapClient = bootstrapClient;
      newClientCommitData = await perdag.withRead(async dagRead => {
        const bootstrapCommit = await db.baseSnapshotFromHash(
          constBootstrapClient.headHash,
          dagRead,
        );
        // Copy the snapshot with one change: set last mutation id to 0.  Replicache
        // server implementations expect new client ids to start with last mutation id 0.
        // If a server sees a new client id with a non-0 last mutation id, it may conclude
        // this is a very old client whose state has been garbage collected on the server.
        return newSnapshotCommitData(
          bootstrapCommit.meta.basisHash,
          0 /* lastMutationID */,
          bootstrapCommit.meta.cookieJSON,
          bootstrapCommit.valueHash,
          bootstrapCommit.indexes,
        );
      });
    } else {
      // No existing snapshot to bootstrap from. Create empty snapshot.
      const emptyBTreeChunk = await dag.createChunkWithNativeHash(
        btree.emptyDataNode,
        [],
      );
      chunksToPut.push(emptyBTreeChunk);
      newClientCommitData = newSnapshotCommitData(
        null /* basisHash */,
        0 /* lastMutationID */,
        null /* cookie */,
        emptyBTreeChunk.hash,
        [] /* indexes */,
      );
    }

    const newClientCommitChunk = await dag.createChunkWithNativeHash(
      newClientCommitData,
      getRefs(newClientCommitData),
    );
    chunksToPut.push(newClientCommitChunk);

    return {
      clients: new Map(clients).set(newClientID, {
        heartbeatTimestampMs: Date.now(),
        headHash: newClientCommitChunk.hash,
        mutationID: 0,
        lastServerAckdMutationID: 0,
      }),
      chunksToPut,
    };
  }, perdag);
  const newClient = updatedClients.get(newClientID);
  assertNotUndefined(newClient);
  return [newClientID, newClient, updatedClients];
}

export function initClientDD31(
  lc: LogContext,
  perdag: dag.Store,

  mutatorNames: string[],
  indexes: IndexDefinitions,
): Promise<[sync.ClientID, Client, ClientMap]> {
  assert(DD31);

  return perdag.withWrite(async dagWrite => {
    async function setClientsAndBranchAndCommit(
      basisHash: Hash | null,
      cookieJSON: InternalValue,
      valueHash: Hash,
      indexRecords: readonly db.IndexRecord[],
    ): Promise<[sync.ClientID, Client, ClientMap]> {
      const newSnapshotData = newSnapshotCommitDataDD31(
        basisHash,
        {[newClientID]: 0},
        cookieJSON,
        valueHash,
        indexRecords,
      );
      const chunk = dagWrite.createChunk(
        newSnapshotData,
        getRefs(newSnapshotData),
      );

      const newBranchID = makeUuid();

      const newClient: ClientDD31 = {
        heartbeatTimestampMs: Date.now(),
        headHash: chunk.hash,
        tempRefreshHash: undefined,
        branchID: newBranchID,
      };

      const newClients = new Map(clients).set(newClientID, newClient);

      const branch: Branch = {
        headHash: chunk.hash,
        mutatorNames,
        indexes,
        mutationIDs: {[newClientID]: 0},
        lastServerAckdMutationIDs: {[newClientID]: 0},
      };

      await Promise.all([
        dagWrite.putChunk(chunk),
        setClients(newClients, dagWrite),
        setBranch(newBranchID, branch, dagWrite),
      ]);

      await dagWrite.commit();

      return [newClientID, newClient, newClients];
    }

    const newClientID = makeUuid();
    const clients = await getClients(dagWrite);

    const res = await findMatchingClient(
      dagWrite,
      clients,
      mutatorNames,
      indexes,
    );
    if (res.type === FIND_MATCHING_CLIENT_TYPE_HEAD) {
      // We found a branch with matching mutators and indexes. We can reuse it.
      const {client, branch} = res;
      const {branchID} = client;

      // Update Branch with our new client ID.
      const newBranch: Branch = {
        ...branch,
        mutationIDs: {...branch.mutationIDs, [newClientID]: 0},
        lastServerAckdMutationIDs: {
          ...branch.lastServerAckdMutationIDs,
          [newClientID]: 0,
        },
      };

      const newClient: ClientDD31 = {
        ...client,
        heartbeatTimestampMs: Date.now(),
      };
      const newClients = new Map(clients).set(newClientID, newClient);

      await Promise.all([
        setBranch(branchID, newBranch, dagWrite),
        setClients(newClients, dagWrite),
      ]);

      await dagWrite.commit();
      return [newClientID, newClient, newClients];
    }

    if (res.type === FIND_MATCHING_CLIENT_TYPE_NEW) {
      // No branch to fork from. Create empty snapshot.
      const emptyBTreeChunk = dagWrite.createChunk(btree.emptyDataNode, []);
      await dagWrite.putChunk(emptyBTreeChunk);

      // Create indexes
      const indexRecords: db.IndexRecord[] = [];

      // At this point the value of replicache is the empty tree so all index
      // maps will also be the empty tree.
      for (const [name, indexDefinition] of Object.entries(indexes)) {
        const createIndexDefinition: Required<CreateIndexDefinition> = {
          name,
          prefix: indexDefinition.prefix ?? '',
          jsonPointer: indexDefinition.jsonPointer,
          allowEmpty: indexDefinition.allowEmpty ?? false,
        };
        indexRecords.push({
          definition: createIndexDefinition,
          valueHash: emptyBTreeChunk.hash,
        });
      }

      return setClientsAndBranchAndCommit(
        null,
        null,
        emptyBTreeChunk.hash,
        indexRecords,
      );
    }

    // Now we create a new client and branch that we fork from the found snapshot.
    assert(res.type === FIND_MATCHING_CLIENT_TYPE_FORK);

    const {snapshot} = res;

    // Create indexes
    const indexRecords: db.IndexRecord[] = [];
    const {valueHash} = snapshot;
    const map = new btree.BTreeRead(dagWrite, valueHash);
    for (const [name, indexDefinition] of Object.entries(indexes)) {
      const createIndexDefinition: Required<CreateIndexDefinition> = {
        name,
        prefix: indexDefinition.prefix ?? '',
        jsonPointer: indexDefinition.jsonPointer,
        allowEmpty: indexDefinition.allowEmpty ?? false,
      };

      const indexBTree = await createIndexBTree(
        lc,
        dagWrite,
        map,
        indexDefinition,
      );

      indexRecords.push({
        definition: createIndexDefinition,
        valueHash: await indexBTree.flush(),
      });
    }

    return setClientsAndBranchAndCommit(
      snapshot.meta.basisHash,
      snapshot.meta.cookieJSON,
      snapshot.valueHash,
      indexRecords,
    );
  });
}

export const FIND_MATCHING_CLIENT_TYPE_NEW = 0;
export const FIND_MATCHING_CLIENT_TYPE_FORK = 1;
export const FIND_MATCHING_CLIENT_TYPE_HEAD = 2;

export type FindMatchingClientResult =
  | {
      type: typeof FIND_MATCHING_CLIENT_TYPE_NEW;
    }
  | {
      type: typeof FIND_MATCHING_CLIENT_TYPE_FORK;
      snapshot: db.Commit<db.SnapshotMetaDD31>;
    }
  | {
      type: typeof FIND_MATCHING_CLIENT_TYPE_HEAD;
      client: ClientDD31;
      branch: Branch;
    };

export async function findMatchingClient(
  dagRead: dag.Read,
  clients: ClientMap,
  mutatorNames: string[],
  indexes: IndexDefinitions,
): Promise<FindMatchingClientResult> {
  let newestCookie: ReadonlyJSONValue | undefined;
  let bestBranch: Branch | undefined;
  let bestClient: ClientDD31 | undefined;
  let bestSnapshot: db.Commit<db.SnapshotMetaDD31> | undefined;
  const mutatorNamesSet = new Set(mutatorNames);

  for (const client of clients.values()) {
    if (!isClientDD31(client)) {
      continue;
    }

    const {branchID} = client;
    const branch = await getBranch(branchID, dagRead);
    assert(branch);

    if (
      mutatorNamesEqual(mutatorNamesSet, branch.mutatorNames) &&
      indexDefinitionsEqual(indexes, branch.indexes)
    ) {
      // exact match
      return {type: FIND_MATCHING_CLIENT_TYPE_HEAD, client, branch};
    }

    const branchSnapshotCommit = await db.baseSnapshotFromHash(
      branch.headHash,
      dagRead,
    );
    assertSnapshotCommitDD31(branchSnapshotCommit);

    const cookieJSON = safeCastToJSON(
      branchSnapshotCommit.meta.cookieJSON,
      CastReason.CompareCookies,
    );
    if (
      newestCookie === undefined ||
      compareCookies(cookieJSON, newestCookie) > 0
    ) {
      newestCookie = cookieJSON;
      bestBranch = branch;
      bestClient = client;
      bestSnapshot = branchSnapshotCommit;
    }
  }

  if (bestBranch) {
    assert(bestClient);
    assert(bestBranch);
    assert(bestSnapshot);

    return {
      type: FIND_MATCHING_CLIENT_TYPE_FORK,
      snapshot: bestSnapshot,
    };
  }

  return {type: FIND_MATCHING_CLIENT_TYPE_NEW};
}

function asyncHashOfClients(clients: ClientMap): Promise<Hash> {
  const data = clientMapToChunkDataNoHashValidation(clients);
  return hashOf(data);
}

export const noUpdates = Symbol();
export type NoUpdates = typeof noUpdates;

type ClientsUpdate = (
  clients: ClientMap,
) => MaybePromise<
  {clients: ClientMap; chunksToPut?: Iterable<dag.Chunk>} | NoUpdates
>;

export async function updateClients(
  update: ClientsUpdate,
  dagStore: dag.Store,
): Promise<ClientMap> {
  if (DD31) {
    // TODO(DD31): Update callers to use setClients for DD31c instead.
    return dagStore.withWrite(async dagWrite => {
      const clients = await getClients(dagWrite);
      const res = await update(clients);
      if (res === noUpdates) {
        return clients;
      }

      const {clients: newClients, chunksToPut} = res;
      await setClients(newClients, dagWrite);
      if (chunksToPut) {
        await Promise.all(Array.from(chunksToPut, c => dagWrite.putChunk(c)));
      }

      await dagWrite.commit();
      return clients;
    });
  }

  const [clients, clientsHash] = await dagStore.withRead(async dagRead => {
    const clientsHash = await dagRead.getHead(CLIENTS_HEAD_NAME);
    const clients = await getClientsAtHash(clientsHash, dagRead);
    return [clients, clientsHash];
  });
  return updateClientsInternal(update, clients, clientsHash, dagStore);
}

async function updateClientsInternal(
  update: ClientsUpdate,
  clients: ClientMap,
  clientsHash: Hash | undefined,
  dagStore: dag.Store,
): Promise<ClientMap> {
  const updateResults = await update(clients);
  if (updateResults === noUpdates) {
    return clients;
  }
  const {clients: updatedClients, chunksToPut} = updateResults;
  const updatedClientsHash = await asyncHashOfClients(updatedClients);
  const result = await dagStore.withWrite(async dagWrite => {
    const currClientsHash = await dagWrite.getHead(CLIENTS_HEAD_NAME);
    if (currClientsHash !== clientsHash) {
      // Conflict!  Someone else updated the ClientsMap.  Retry update.
      return {
        updateApplied: false,
        clients: await getClientsAtHash(currClientsHash, dagWrite),
        clientsHash: currClientsHash,
      };
    }
    const updatedClientsChunkData = clientMapToChunkData(
      updatedClients,
      dagWrite,
    );

    const updateClientsRefs: Hash[] = getRefsForClients(updatedClients);

    const updateClientsChunk = dag.createChunkWithHash(
      updatedClientsHash,
      updatedClientsChunkData,
      updateClientsRefs,
    );
    const chunksToPutPromises: Promise<void>[] = [];
    if (chunksToPut) {
      for (const chunk of chunksToPut) {
        chunksToPutPromises.push(dagWrite.putChunk(chunk));
      }
    }
    await Promise.all([
      ...chunksToPutPromises,
      dagWrite.putChunk(updateClientsChunk),
      dagWrite.setHead(CLIENTS_HEAD_NAME, updateClientsChunk.hash),
    ]);
    await dagWrite.commit();
    return {
      updateApplied: true,
      clients: updatedClients,
      clientsHash: updatedClientsHash,
    };
  });
  if (result.updateApplied) {
    return result.clients;
  }
  return updateClientsInternal(
    update,
    result.clients,
    result.clientsHash,
    dagStore,
  );
}

function getRefsForClients(clients: ClientMap): Hash[] {
  const refs: Hash[] = [];
  for (const client of clients.values()) {
    refs.push(client.headHash);
    if (DD31 && isClientDD31(client) && client.tempRefreshHash) {
      refs.push(client.tempRefreshHash);
    }
  }
  return refs;
}

export async function getMainBranch(
  clientID: ClientID,
  read: dag.Read,
): Promise<Branch | undefined> {
  assert(DD31);
  const branchID = await getMainBranchID(clientID, read);
  if (!branchID) {
    return undefined;
  }
  return await getBranch(branchID, read);
}

export async function getMainBranchID(
  clientID: ClientID,
  read: dag.Read,
): Promise<sync.BranchID | undefined> {
  assert(DD31);
  const client = await getClient(clientID, read);
  if (!client || !isClientDD31(client)) {
    return undefined;
  }
  return client.branchID;
}

/**
 * Adds a Client to the ClientMap and updates the 'clients' head top point at
 * the updated clients.
 */
export async function setClient(
  clientID: ClientID,
  client: Client,
  dagWrite: dag.Write,
): Promise<Hash> {
  const clientsHash = await dagWrite.getHead(CLIENTS_HEAD_NAME);
  const clients = await getClientsAtHash(clientsHash, dagWrite);
  const newClients = new Map(clients).set(clientID, client);
  return setClients(newClients, dagWrite);
}

/**
 * Sets the ClientMap and updates the 'clients' head top point at the new
 * clients.
 */
export async function setClients(
  clients: ClientMap,
  dagWrite: dag.Write,
): Promise<Hash> {
  const chunkData = clientMapToChunkData(clients, dagWrite);
  const chunk = dagWrite.createChunk(chunkData, getRefsForClients(clients));
  await dagWrite.putChunk(chunk);
  await dagWrite.setHead(CLIENTS_HEAD_NAME, chunk.hash);
  return chunk.hash;
}
