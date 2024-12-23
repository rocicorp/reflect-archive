import {LogContext, LogLevel, LogSink} from '@rocicorp/logger';
import {createRoomRequestSchema} from 'reflect-protocol';
import {
  closeBeaconQueryParamsSchema,
  closeBeaconSchema,
} from 'reflect-protocol/src/close-beacon.js';
import {getConfig} from 'reflect-shared/src/config.js';
import {CLOSE_BEACON_PATH} from 'reflect-shared/src/paths.js';
import type {Env, MutatorDefs} from 'reflect-shared/src/types.js';
import {version} from 'reflect-shared/src/version.js';
import {BufferSizer} from 'shared/src/buffer-sizer.js';
import * as valita from 'shared/src/valita.js';
import {ConnectionLifetimeReporter} from '../events/connection-lifetimes.js';
import {ConnectionSecondsReporter} from '../events/connection-seconds.js';
import type {MutatorMap} from '../process/process-mutation.js';
import {processPending} from '../process/process-pending.js';
import {processRoomStart} from '../process/process-room-start.js';
import {DurableStorage} from '../storage/durable-storage.js';
import {scanUserValues} from '../storage/replicache-transaction.js';
import {
  ConnectionCountTrackingClientMap,
  type ClientID,
  type ClientMap,
  type ClientState,
} from '../types/client-state.js';
import type {PendingMutation} from '../types/mutation.js';
import {decodeHeaderValue} from 'shared/src/headers.js';
import {LoggingLock} from '../util/lock.js';
import {populateLogContextFromRequest} from '../util/log-context-common.js';
import {randomID} from '../util/rand.js';
import {AlarmManager} from './alarms.js';
import type {ClientDeleteHandler} from './client-delete-handler.js';
import type {ClientDisconnectHandler} from './client-disconnect-handler.js';
import {CLIENT_GC_FREQUENCY} from './client-gc.js';
import {closeBeacon} from './close-beacon.js';
import {handleClose} from './close.js';
import {handleConnection} from './connect.js';
import {closeConnections, getConnections} from './connections.js';
import {
  Socket,
  requireUpgradeHeader,
  upgradeWebsocketResponse,
} from '../util/socket.js';
import {ROOM_ID_HEADER_NAME} from './internal-headers.js';
import {handleMessage} from './message.js';
import {
  AUTH_CONNECTIONS_PATH,
  CONNECT_URL_PATTERN,
  CREATE_ROOM_PATH,
  DELETE_ROOM_PATH,
  GET_CONTENTS_ROOM_PATH,
  INVALIDATE_ALL_CONNECTIONS_PATH,
  INVALIDATE_ROOM_CONNECTIONS_PATH,
  INVALIDATE_USER_CONNECTIONS_PATH,
  LEGACY_CREATE_ROOM_PATH,
  LEGACY_DELETE_ROOM_PATH,
  LEGACY_INVALIDATE_ROOM_CONNECTIONS_PATH,
  LEGACY_INVALIDATE_USER_CONNECTIONS_PATH,
  TAIL_URL_PATH,
  roomIDParams,
  userIDParams,
} from './paths.js';
import {initRoomSchema} from './room-schema.js';
import type {RoomStartHandler} from './room-start.js';
import type {RoomContents} from './rooms.js';
import {
  Router,
  get,
  inputParams,
  post,
  queryParams,
  roomID,
  userID,
} from 'cf-shared/src/router.js';
import {connectTail} from './tail.js';
import {registerUnhandledRejectionHandler} from './unhandled-rejection-handler.js';

const roomIDKey = '/system/roomID';
const deletedKey = '/system/deleted';

export interface RoomDOOptions<MD extends MutatorDefs> {
  mutators: MD;
  state: DurableObjectState;
  onRoomStart: RoomStartHandler;
  onClientDisconnect: ClientDisconnectHandler;
  onClientDelete: ClientDeleteHandler;
  logSink: LogSink;
  logLevel: LogLevel;
  allowUnconfirmedWrites: boolean;
  maxMutationsPerTurn: number;
  env: Env;
}

export const ROOM_ROUTES = {
  deletePath: DELETE_ROOM_PATH,
  legacyDeletePath: LEGACY_DELETE_ROOM_PATH,
  getContents: GET_CONTENTS_ROOM_PATH,
  authInvalidateAll: INVALIDATE_ALL_CONNECTIONS_PATH,
  authInvalidateForUser: INVALIDATE_USER_CONNECTIONS_PATH,
  authInvalidateForRoom: INVALIDATE_ROOM_CONNECTIONS_PATH,
  legacyAuthInvalidateForUser: LEGACY_INVALIDATE_USER_CONNECTIONS_PATH,
  legacyAuthInvalidateForRoom: LEGACY_INVALIDATE_ROOM_CONNECTIONS_PATH,
  authConnections: AUTH_CONNECTIONS_PATH,
  createRoom: CREATE_ROOM_PATH,
  legacyCreateRoom: LEGACY_CREATE_ROOM_PATH,
  connect: CONNECT_URL_PATTERN,
  closeBeacon: CLOSE_BEACON_PATH,
  tail: TAIL_URL_PATH,
} as const;

export class BaseRoomDO<MD extends MutatorDefs> implements DurableObject {
  readonly #clients: ClientMap;
  readonly #pendingMutations: PendingMutation[] = [];
  readonly #bufferSizer = new BufferSizer({
    initialBufferSizeMs: 25,
    minBufferSizeMs: 0,
    maxBufferSizeMs: 500,
    adjustBufferSizeIntervalMs: 5_000,
  });
  #maxProcessedMutationTimestamp = 0;
  readonly #lock = new LoggingLock();
  readonly #mutators: MutatorMap;
  readonly #onRoomStart: RoomStartHandler;
  readonly #onClientDisconnect: ClientDisconnectHandler;
  readonly #onClientDelete: ClientDeleteHandler;
  readonly #maxMutationsPerTurn: number;
  #roomIDDependentInitCompleted = false;
  #lc: LogContext;
  readonly #storage: DurableStorage;
  #turnTimerID: ReturnType<typeof setInterval> | 0 = 0;

  readonly #turnDuration: number;
  readonly #router = new Router();

  readonly #alarm: AlarmManager;
  readonly #connectionSecondsReporter: ConnectionSecondsReporter;
  readonly #connectionLifetimeReporter: ConnectionLifetimeReporter;
  readonly #env: Env;
  #lastGCClientsTimestamp: undefined | number = undefined;

  constructor(options: RoomDOOptions<MD>) {
    const {
      mutators,
      onRoomStart,
      onClientDisconnect,
      onClientDelete,
      state,
      logSink,
      logLevel,
      maxMutationsPerTurn,
      env,
    } = options;

    this.#mutators = new Map([...Object.entries(mutators)]) as MutatorMap;
    this.#onRoomStart = onRoomStart;
    this.#onClientDisconnect = onClientDisconnect;
    this.#onClientDelete = onClientDelete;
    this.#maxMutationsPerTurn = maxMutationsPerTurn;
    this.#storage = new DurableStorage(
      state.storage,
      options.allowUnconfirmedWrites,
    );

    this.#alarm = new AlarmManager(state.storage);
    this.#connectionSecondsReporter = new ConnectionSecondsReporter(
      this.#alarm.scheduler,
    );
    this.#connectionLifetimeReporter = new ConnectionLifetimeReporter(
      this.#alarm.scheduler,
    );
    this.#env = env;
    this.#clients = new ConnectionCountTrackingClientMap(
      this.#connectionSecondsReporter,
      this.#connectionLifetimeReporter,
    );

    this.#initRoutes();

    this.#turnDuration = getDefaultTurnDuration(options.allowUnconfirmedWrites);
    const lc = new LogContext(logLevel, undefined, logSink).withContext(
      'component',
      'RoomDO',
    );
    registerUnhandledRejectionHandler(lc);
    this.#lc = lc.withContext('doID', state.id.toString());

    this.#lc.info?.('Starting RoomDO. Version:', version);

    void state.blockConcurrencyWhile(async () => {
      await initRoomSchema(this.#lc, this.#storage);
    });
  }

  #initRoutes() {
    this.#router.register(ROOM_ROUTES.deletePath, this.#deleteRoom);
    this.#router.register(ROOM_ROUTES.legacyDeletePath, this.#legacyDeleteRoom);
    this.#router.register(ROOM_ROUTES.getContents, this.#getContents);
    this.#router.register(
      ROOM_ROUTES.authInvalidateAll,
      this.#authInvalidateAll,
    );
    this.#router.register(
      ROOM_ROUTES.authInvalidateForUser,
      this.#authInvalidateForUser,
    );
    this.#router.register(
      ROOM_ROUTES.authInvalidateForRoom,
      this.#authInvalidateForRoom,
    );
    this.#router.register(
      ROOM_ROUTES.legacyAuthInvalidateForUser,
      this.#legacyAuthInvalidateForUser,
    );
    this.#router.register(
      ROOM_ROUTES.legacyAuthInvalidateForRoom,
      this.#legacyAuthInvalidateForRoom,
    );
    this.#router.register(ROOM_ROUTES.authConnections, this.#authConnections);
    this.#router.register(ROOM_ROUTES.createRoom, this.#createRoom);
    this.#router.register(ROOM_ROUTES.legacyCreateRoom, this.#legacyCreateRoom);
    this.#router.register(ROOM_ROUTES.connect, this.#connect);
    this.#router.register(ROOM_ROUTES.tail, this.#tail);
    if (getConfig('closeBeacon')) {
      this.#router.register(ROOM_ROUTES.closeBeacon, this.#closeBeacon);
    }
  }

  async fetch(request: Request): Promise<Response> {
    const lc = populateLogContextFromRequest(this.#lc, request);
    try {
      if (await this.deleted()) {
        return new Response('deleted', {
          status: 410, // Gone
        });
      }
      const roomIDHeaderValue = request.headers.get(ROOM_ID_HEADER_NAME);
      if (roomIDHeaderValue === null || roomIDHeaderValue === '') {
        return new Response('Missing Room ID Header', {status: 500});
      }
      if (!this.#roomIDDependentInitCompleted) {
        await this.#lock.withLock(lc, 'initRoomID', async lcInLock => {
          if (this.#roomIDDependentInitCompleted) {
            lcInLock.debug?.('roomID already initialized, returning');
            return;
          }
          const roomID = decodeHeaderValue(roomIDHeaderValue);
          await processRoomStart(
            lcInLock,
            this.#env,
            this.#onRoomStart,
            this.#storage,
            roomID,
          );
          this.#lc = this.#lc.withContext('roomID', roomID);
          this.#roomIDDependentInitCompleted = true;
          this.#connectionSecondsReporter.setRoomID(roomID);
          lc.info?.('initialized roomID');
        });
      }

      return await this.#router.dispatch(request, {lc});
    } catch (e) {
      lc.error?.('Unhandled exception in fetch', e);
      return new Response(
        e instanceof Error ? e.message : 'Unexpected error.',
        {status: 500},
      );
    }
  }

  #setRoomID(roomID: string) {
    return this.#storage.put(roomIDKey, roomID);
  }

  maybeRoomID(): Promise<string | undefined> {
    return this.#storage.get(roomIDKey, valita.string());
  }

  async #setDeleted(roomID: string | undefined) {
    if (roomID) {
      await this.#setRoomID(roomID);
    }
    return this.#storage.put(deletedKey, true);
  }

  async deleted(): Promise<boolean> {
    return (await this.#storage.get(deletedKey, valita.boolean())) === true;
  }

  /**
   * _internalCreateRoom does not require an API key. It is used by the
   * _createRoom after it has validated the API key. It is also used as an RPC
   * from the AuthDO.
   *
   */
  #createRoom = post()
    .with(inputParams(roomIDParams, createRoomRequestSchema))
    .handle(async ctx => {
      const {roomID} = ctx.query;
      this.#lc.info?.('Handling create room request for roomID', roomID);
      await this.#setRoomID(roomID);
      await this.#storage.flush();
      this.#lc.debug?.('Flushed roomID to storage', roomID);
      return new Response('ok');
    });

  // TODO: Delete
  #legacyCreateRoom = post()
    .with(roomID())
    .handle(async ctx => {
      const {roomID} = ctx;
      this.#lc.info?.('Handling create room request for roomID', roomID);
      await this.#setRoomID(roomID);
      await this.#storage.flush();
      this.#lc.debug?.('Flushed roomID to storage', roomID);
      return new Response('ok');
    });

  #deleteRoom = post()
    .with(queryParams(roomIDParams))
    .handle(ctx => {
      const {
        lc,
        query: {roomID},
      } = ctx;
      return this.#invalidateConnectionsAndDeleteRoom(lc, roomID);
    });

  #legacyDeleteRoom = post()
    .with(roomID())
    .handle(ctx => {
      const {lc, roomID} = ctx;
      return this.#invalidateConnectionsAndDeleteRoom(lc, roomID);
    });

  // - Invalidates all connections
  // - Deletes all data
  // - Restores: system/roomID
  // - Sets: system/deleted
  // If we store more system keys in the future we might want to add logic to fetch
  // all system entries and restore them after deleteAll().
  #invalidateConnectionsAndDeleteRoom = async (
    lc: LogContext,
    roomID: string,
  ) => {
    const myRoomID = await this.maybeRoomID();
    if (myRoomID && myRoomID !== roomID) {
      // Sanity check. This would indicate a bug in the AuthDO.
      throw new Error(
        `Specified roomID ${roomID} does not match expected ${myRoomID}`,
      );
    }
    lc.debug?.(`Closing room ${roomID}'s connections before deleting data.`);
    await this.#closeConnections(_ => true);
    lc.info?.(`delete all data for ${roomID}`);
    await this.#storage.deleteAll();
    lc.info?.('done deleting all data');
    await this.#setDeleted(myRoomID);
    return new Response('ok');
  };

  #connect = get().handle((ctx, request) => {
    const {lc} = ctx;
    const errorResponse = requireUpgradeHeader(request, lc);
    if (errorResponse) {
      return errorResponse;
    }

    const {0: clientWS, 1: serverWS} = new WebSocketPair();
    const url = new URL(request.url);
    lc.debug?.('connection request', url.toString(), 'waiting for lock');
    serverWS.accept();

    void this.#lock
      .withLock(lc, 'handleConnection', async lc => {
        await handleConnection(
          lc,
          serverWS,
          this.#storage,
          url,
          request.headers,
          this.#clients,
          this.#handleMessage,
          this.#handleClose,
        );
        this.#processUntilDone(lc);
      })
      .catch(e => {
        lc.error?.('unhandled exception in handleConnection', e);
      });

    return upgradeWebsocketResponse(clientWS, request.headers);
  });

  #closeBeacon = post()
    // not checking authorization header again.
    .with(inputParams(closeBeaconQueryParamsSchema, closeBeaconSchema))
    .handle(ctx => {
      const {
        body: {lastMutationID},
        query: {clientID, roomID, userID},
      } = ctx;

      return closeBeacon(
        ctx.lc.withContext('handler', 'closeBeacon'),
        this.#env,
        clientID,
        roomID,
        userID,
        lastMutationID,
        this.#onClientDelete,
        this.#storage,
      );
    });

  #tail = get().handle((ctx, request) => {
    const {lc} = ctx;
    lc.debug?.('tail request', request.url);

    const errorResponse = requireUpgradeHeader(request, lc);
    if (errorResponse) {
      return errorResponse;
    }

    const {0: clientWS, 1: serverWS} = new WebSocketPair();

    serverWS.accept();
    connectTail(serverWS);

    return upgradeWebsocketResponse(clientWS, request.headers);
  });

  #getContents = get().handleAPIResult((ctx, _req): Promise<RoomContents> => {
    const {lc} = ctx;
    lc.info?.('getting room contents');
    return this.#lock.withLock(lc, 'getContents', async () => {
      const response: RoomContents = {contents: {}};
      for await (const [key, value] of scanUserValues(
        this.#storage,
        {},
      ).entries()) {
        response.contents[key] = value;
      }
      return response;
    });
  });

  #authInvalidateForRoom = post()
    .with(queryParams(roomIDParams))
    .handle(async ctx => {
      const {
        lc,
        query: {roomID},
      } = ctx;
      lc.debug?.(
        `Closing room ${roomID}'s connections fulfilling auth api invalidateForRoom request.`,
      );
      await this.#closeConnections(_ => true);
      return new Response('Success', {status: 200});
    });

  // TODO: Delete
  #legacyAuthInvalidateForRoom = post()
    .with(roomID())
    .handle(async ctx => {
      const {lc, roomID} = ctx;
      lc.debug?.(
        `Closing room ${roomID}'s connections fulfilling auth api invalidateForRoom request.`,
      );
      await this.#closeConnections(_ => true);
      return new Response('Success', {status: 200});
    });

  #authInvalidateForUser = post()
    .with(queryParams(userIDParams))
    .handle(async ctx => {
      const {
        lc,
        query: {userID},
      } = ctx;
      lc.debug?.(
        `Closing user ${userID}'s connections fulfilling auth api invalidateForUser request.`,
      );
      await this.#closeConnections(
        clientState => clientState.auth.userID === userID,
      );
      return new Response('Success', {status: 200});
    });

  // TODO: Delete
  #legacyAuthInvalidateForUser = post()
    .with(userID())
    .handle(async ctx => {
      const {lc, userID} = ctx;
      lc.debug?.(
        `Closing user ${userID}'s connections fulfilling auth api invalidateForUser request.`,
      );
      await this.#closeConnections(
        clientState => clientState.auth.userID === userID,
      );
      return new Response('Success', {status: 200});
    });

  #authInvalidateAll = post().handle(async ctx => {
    const {lc} = ctx;
    lc.debug?.(
      'Closing all connections fulfilling auth api invalidateAll request.',
    );
    await this.#closeConnections(_ => true);
    return new Response('Success', {status: 200});
  });

  #authConnections = post().handle(ctx => {
    const {lc} = ctx;
    lc.debug?.('Retrieving all auth connections');
    return new Response(JSON.stringify(getConnections(this.#clients)));
  });

  #closeConnections(
    predicate: (clientState: ClientState) => boolean,
  ): Promise<void> {
    return this.#lock.withLock(this.#lc, 'closeConnections', () =>
      closeConnections(this.#clients, predicate),
    );
  }

  #handleMessage = (
    lc: LogContext,
    clientID: ClientID,
    data: string,
    ws: Socket,
  ): void => {
    void this.#handleMessageInner(lc, clientID, data, ws);
  };

  async #handleMessageInner(
    lc: LogContext,
    clientID: ClientID,
    data: string,
    ws: Socket,
  ): Promise<void> {
    lc = lc.withContext('msgID', randomID());
    lc.debug?.('handling message', data);

    try {
      await this.#lock.withLock(lc, 'handleMessage', async lc => {
        await handleMessage(
          lc,
          this.#storage,
          this.#clients,
          this.#pendingMutations,
          clientID,
          data,
          ws,
          () => this.#processUntilDone(lc),
        );
      });
    } catch (e) {
      lc.error?.('Unhandled exception in handleMessage', e);
    }
  }

  async alarm(): Promise<void> {
    const lc = this.#lc.withContext('handler', 'alarm');
    await this.#alarm.fireScheduled(lc);
  }

  #processUntilDone(lc: LogContext) {
    lc.debug?.('handling processUntilDone');
    if (this.#turnTimerID) {
      lc.debug?.('already processing, nothing to do');
      return;
    }

    this.#turnTimerID = this.runInLockAtInterval(
      // The logging in turn processing should use this.#lc (i.e. the RoomDO's
      // general log context), rather than lc which has the context of a
      // specific request/connection
      this.#lc,
      '#processNext',
      this.#turnDuration,
      logContext => this.#processNextInLock(logContext),
    );
  }

  // Exposed for testing.
  runInLockAtInterval(
    lc: LogContext,
    name: string,
    interval: number,
    callback: (lc: LogContext) => Promise<void>,
    beforeQueue = () => {
      /* hook for testing */
    },
  ): ReturnType<typeof setInterval> {
    let queued = false;

    return setInterval(async () => {
      beforeQueue(); // Hook for testing.

      // setInterval() is recommended to only be used with logic that completes within the interval:
      //
      // https://developer.mozilla.org/en-US/docs/Web/API/setInterval#ensure_that_execution_duration_is_shorter_than_interval_frequency
      //
      // We do not have this guarantee with the `callback`, and because calls are serialized by the lock,
      // a long invocation can result in setInterval() queueing up many subsequent invocations and
      // consequently hogging the lock.
      //
      // To avoid this self-DOS situation, we only allow one invocation to be queued, meanwhile
      // aborting redundant invocations fired by setInterval().
      if (queued) {
        lc.info?.(
          `Previous ${name} is still queued. Dropping redundant invocation.`,
        );
        return;
      }
      queued = true;

      await this.#lock.withLock(
        lc,
        name,
        async lc => {
          queued = false;
          await callback(lc).catch(e => {
            lc.error?.(`Unhandled exception in ${name}`, e);
          });
        },
        // The callback is expected to run close to and occasionally exceed the interval.
        // Log if it runs for more than 1.5x the interval.
        interval * 1.5,
      );
    }, interval);
  }

  async #processNextInLock(lc: LogContext) {
    const {maxProcessedMutationTimestamp, nothingToProcess} =
      await processPending(
        lc,
        this.#env,
        this.#storage,
        this.#clients,
        this.#pendingMutations,
        this.#mutators,
        this.#onClientDisconnect,
        this.#onClientDelete,
        this.#maxProcessedMutationTimestamp,
        this.#bufferSizer,
        this.#maxMutationsPerTurn,
        (now: number) => this.#shouldGCClients(now),
      );
    this.#maxProcessedMutationTimestamp = maxProcessedMutationTimestamp;
    if (nothingToProcess && this.#turnTimerID) {
      clearInterval(this.#turnTimerID);
      this.#turnTimerID = 0;
    }
  }

  #shouldGCClients(now: number): boolean {
    if (
      this.#lastGCClientsTimestamp === undefined ||
      now - this.#lastGCClientsTimestamp > CLIENT_GC_FREQUENCY
    ) {
      this.#lastGCClientsTimestamp = now;
      return true;
    }
    return false;
  }

  #handleClose = async (
    lc: LogContext,
    clientID: ClientID,
    ws: Socket,
  ): Promise<void> => {
    await this.#lock.withLock(lc, '#handleClose', lc => {
      handleClose(lc, this.#clients, clientID, ws);
      this.#processUntilDone(lc);
    });
  };
}

export function getDefaultTurnDuration(
  allowUnconfirmedWrites: boolean,
): number {
  return Math.floor(1000 / (allowUnconfirmedWrites ? 60 : 15));
}
