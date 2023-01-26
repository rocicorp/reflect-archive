import type {MutatorDefs} from 'replicache';
import {processPending} from '../process/process-pending.js';
import type {MutatorMap} from '../process/process-mutation.js';
import type {
  ClientID,
  ClientMap,
  ClientState,
  Socket,
} from '../types/client-state.js';
import {Lock} from '@rocicorp/lock';
import {LogSink, LogContext, LogLevel} from '@rocicorp/logger';
import {handleClose} from './close.js';
import {handleConnection} from './connect.js';
import {handleMessage} from './message.js';
import {randomID} from '../util/rand.js';
import {version} from '../util/version.js';
import {dispatch} from './dispatch.js';
import {
  invalidateForUserRequestSchema,
  invalidateForRoomRequestSchema,
} from '../protocol/api/auth.js';
import {closeConnections, getConnections} from './connections.js';
import type {DisconnectHandler} from './disconnect.js';
import {DurableStorage} from '../storage/durable-storage.js';
import {getConnectedClients} from '../types/connected-clients.js';
import * as s from 'superstruct';
import type {CreateRoomRequest} from '../protocol/api/room.js';
import {
  post,
  requireAuthAPIKey,
  Router,
  Handler,
  BaseContext,
  withBody,
} from './router.js';
import {addRequestIDFromHeadersOrRandomID} from './request-id.js';

const roomIDKey = '/system/roomID';
const deletedKey = '/system/deleted';

export interface RoomDOOptions<MD extends MutatorDefs> {
  mutators: MD;
  state: DurableObjectState;
  authApiKey: string;
  disconnectHandler: DisconnectHandler;
  logSink: LogSink;
  logLevel: LogLevel;
  allowUnconfirmedWrites: boolean;
}

export const ROOM_ROUTES = {
  deletePath: '/api/room/v0/room/:roomID/delete',
  authInvalidateAll: '/api/auth/v0/invalidateAll',
  authInvalidateForUser: '/api/auth/v0/invalidateForUser',
  authInvalidateForRoom: '/api/auth/v0/invalidateForRoom',
};

export class BaseRoomDO<MD extends MutatorDefs> implements DurableObject {
  private readonly _clients: ClientMap = new Map();
  private readonly _lock = new Lock();
  private readonly _mutators: MutatorMap;
  private readonly _disconnectHandler: DisconnectHandler;
  private _lcHasRoomIdContext = false;
  private _lc: LogContext;
  private readonly _storage: DurableStorage;
  private readonly _authApiKey: string;
  private _turnTimerID: ReturnType<typeof setInterval> | 0 = 0;
  private readonly _turnDuration: number;
  private _router: Router;

  constructor(options: RoomDOOptions<MD>) {
    const {mutators, disconnectHandler, state, authApiKey, logSink, logLevel} =
      options;

    this._mutators = new Map([...Object.entries(mutators)]) as MutatorMap;
    this._disconnectHandler = disconnectHandler;
    this._storage = new DurableStorage(
      state.storage,
      options.allowUnconfirmedWrites,
    );

    this._router = new Router();
    this._initRoutes();

    this._turnDuration = 1000 / (options.allowUnconfirmedWrites ? 60 : 15);
    this._authApiKey = authApiKey;
    this._lc = new LogContext(logLevel, logSink)
      .addContext('RoomDO')
      .addContext('doID', state.id.toString());
    this._lc.info?.('Starting server');
    this._lc.info?.('Version:', version);
  }

  private _initRoutes() {
    this._router.register(ROOM_ROUTES.deletePath, this._deleteAllData);
    this._router.register(
      ROOM_ROUTES.authInvalidateAll,
      this._authInvalidateAll,
    );
    this._router.register(
      ROOM_ROUTES.authInvalidateForUser,
      this._authInvalidateForUser,
    );
    this._router.register(
      ROOM_ROUTES.authInvalidateForRoom,
      this._authInvalidateForRoom,
    );
  }

  async fetch(request: Request): Promise<Response> {
    try {
      if (await this.deleted()) {
        return new Response('deleted', {
          status: 410, // Gone
        });
      }

      if (!this._lcHasRoomIdContext) {
        const roomID = await this.maybeRoomID();
        const url = new URL(request.url);
        const urlRoomID = url.searchParams.get('roomID');
        if (
          // roomID is not going to be set on the createRoom request, or after
          // the room has been deleted.
          roomID !== undefined &&
          // roomID is not going to be set for all calls, eg to delete the room.
          urlRoomID !== null &&
          urlRoomID !== roomID
        ) {
          console.log('roomID mismatch', roomID, urlRoomID);
          this._lc.error?.(
            'roomID mismatch',
            'urlRoomID',
            urlRoomID,
            'roomID',
            roomID,
          );
          return new Response('Unexpected roomID', {status: 400});
        }

        if (roomID) {
          this._lc = this._lc.addContext('roomID', roomID);
          this._lc.info?.('initializing room');
          this._lcHasRoomIdContext = true;
        }
      }

      const lc = addClientIPToLogContext(
        addRequestIDFromHeadersOrRandomID(this._lc, request),
        request,
      );

      const response = await this._router.dispatch(request, {lc});
      if (response !== undefined) {
        return response;
      }

      return await dispatch(request, lc, this._authApiKey, this);
    } catch (e) {
      const lc = addClientIPToLogContext(this._lc, request);

      lc.error?.('Unhandled exception in fetch', e);
      return new Response(
        e instanceof Error ? e.message : 'Unexpected error.',
        {status: 500},
      );
    }
  }

  private _setRoomID(roomID: string) {
    return this._storage.put(roomIDKey, roomID);
  }

  maybeRoomID(): Promise<string | undefined> {
    return this._storage.get(roomIDKey, s.string());
  }

  private _setDeleted() {
    return this._storage.put(deletedKey, true);
  }

  async deleted(): Promise<boolean> {
    return (await this._storage.get(deletedKey, s.boolean())) === true;
  }

  // roomID errors and returns "unknown" if the roomID is not set. Prefer
  // roomID() to maybeRoomID() in cases where the roomID is expected to be set,
  // which is most cases.
  async roomID(lc: LogContext): Promise<string> {
    const roomID = await this.maybeRoomID();
    if (roomID !== undefined) {
      return roomID;
    }
    lc.error?.('roomID is not set');
    return 'unknown';
  }

  // A more appropriate name might be init(), but this is easy since authDO and
  // roomDO share dispatch and handlers.
  async createRoom(
    _lc: LogContext,
    _request: Request,
    createRoomRequest: CreateRoomRequest,
  ) {
    const {roomID} = createRoomRequest;
    await this._setRoomID(roomID);
    return new Response('ok');
  }

  private _requireAPIKey = <Context extends BaseContext, Resp>(
    next: Handler<Context, Resp>,
  ) => requireAuthAPIKey(() => this._authApiKey, next);

  // There's a bit of a question here about whether we really want to delete *all* the
  // data when a room is deleted. This deletes everything, including values kept by the
  // system e.g. the roomID. If we store more system keys in the future we might want to have
  // delete room only delete the room user data and not the system keys, because once
  // system keys are deleted who knows what behavior the room will have when its apis are
  // called. Maybe it's fine if they error out, dunno.
  private _deleteAllData = post(
    this._requireAPIKey(async ctx => {
      const {lc} = ctx;
      // Maybe we should validate that the roomID in the request matches?
      lc.info?.('delete all data');
      await this._storage.deleteAll();
      lc.info?.('done deleting all data');
      await this._setDeleted();
      return new Response('ok');
    }),
  );

  // eslint-disable-next-line require-await
  async connect(lc: LogContext, request: Request): Promise<Response> {
    lc = addWebSocketIDToLogContext(lc, request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      lc.error?.('roomDO: missing Upgrade header');
      return new Response('expected websocket', {status: 400});
    }

    const {0: clientWS, 1: serverWS} = new WebSocketPair();
    const url = new URL(request.url);
    lc.debug?.('connection request', url.toString(), 'waiting for lock');
    serverWS.accept();

    void this._lock.withLock(() => {
      lc.debug?.('received lock');
      return handleConnection(
        lc,
        serverWS,
        this._storage,
        url,
        request.headers,
        this._clients,
        this._handleMessage,
        this._handleClose,
      );
    });

    return new Response(null, {status: 101, webSocket: clientWS});
  }

  private _authInvalidateForRoom = post(
    this._requireAPIKey(
      withBody(invalidateForRoomRequestSchema, async ctx => {
        const {lc, body} = ctx;
        const {roomID} = body;
        lc.debug?.(
          `Closing room ${roomID}'s connections fulfilling auth api invalidateForRoom request.`,
        );
        await this._closeConnections(_ => true);
        return new Response('Success', {status: 200});
      }),
    ),
  );

  private _authInvalidateForUser = post(
    this._requireAPIKey(
      withBody(invalidateForUserRequestSchema, async ctx => {
        const {lc, body} = ctx;
        const {userID} = body;
        lc.debug?.(
          `Closing user ${userID}'s connections fulfilling auth api invalidateForUser request.`,
        );
        await this._closeConnections(
          clientState => clientState.userData.userID === userID,
        );
        return new Response('Success', {status: 200});
      }),
    ),
  );

  private _authInvalidateAll = post(
    this._requireAPIKey(async ctx => {
      const {lc} = ctx;
      lc.info?.(
        'Closing all connections fulfilling auth api invalidateAll request.',
      );
      await this._closeConnections(_ => true);
      return new Response('Success', {status: 200});
    }),
  );

  // eslint-disable-next-line require-await
  async authConnections(): Promise<Response> {
    // Note this intentionally does not acquire this._lock, as it is
    // unnecessary and can add latency.
    return new Response(JSON.stringify(getConnections(this._clients)));
  }

  private _closeConnections(
    predicate: (clientState: ClientState) => boolean,
  ): Promise<void> {
    return this._lock.withLock(() =>
      closeConnections(this._clients, predicate),
    );
  }

  private _handleMessage = async (
    lc: LogContext,
    clientID: ClientID,
    data: string,
    ws: Socket,
  ): Promise<void> => {
    lc = lc.addContext('msg', randomID());
    lc.debug?.('handling message', data, 'waiting for lock');

    try {
      await this._lock.withLock(() => {
        lc.debug?.('received lock');
        handleMessage(lc, this._clients, clientID, data, ws, () =>
          this._processUntilDone(lc),
        );
      });
    } catch (e) {
      lc.error?.('Unhandled exception in _handleMessage', e);
    }
  };

  private _processUntilDone(lc: LogContext) {
    lc.debug?.('handling processUntilDone');
    if (this._turnTimerID) {
      lc.debug?.('already processing, nothing to do');
      return;
    }
    this._turnTimerID = setInterval(() => {
      void this._processNext(lc);
    }, this._turnDuration);
  }

  private async _processNext(lc: LogContext) {
    lc.debug?.(
      `processNext - starting turn at ${Date.now()} - waiting for lock`,
    );
    await this._lock.withLock(async () => {
      lc.debug?.(`received lock at ${Date.now()}`);

      const storedConnectedClients = await getConnectedClients(this._storage);
      let hasDisconnectsToProcess = false;
      for (const clientID of storedConnectedClients) {
        if (!this._clients.has(clientID)) {
          hasDisconnectsToProcess = true;
          break;
        }
      }
      if (!hasPendingMutations(this._clients) && !hasDisconnectsToProcess) {
        lc.debug?.('No pending mutations or disconnects to process, exiting');
        if (this._turnTimerID) {
          clearInterval(this._turnTimerID);
          this._turnTimerID = 0;
        }
        return;
      }

      await processPending(
        lc,
        this._storage,
        this._clients,
        this._mutators,
        this._disconnectHandler,
        Date.now(),
      );
    });
  }

  private _handleClose = async (
    lc: LogContext,
    clientID: ClientID,
    ws: Socket,
  ): Promise<void> => {
    lc.debug?.('handling close - waiting for lock');
    await this._lock.withLock(() => {
      lc.debug?.('received lock');
      handleClose(lc, this._clients, clientID, ws);
      this._processUntilDone(lc);
    });
  };
}

/**
 * Adds the "wsid" to the LogContext. This is a unique ID that is generated by
 * the client and is used to identify a WebSocket connection. The "wsid" is
 * passed to the server via the query string. If the "wsid" is not present, a
 * random ID is generated.
 */
function addWebSocketIDToLogContext(lc: LogContext, url: string): LogContext {
  return lc.addContext(
    'wsid',
    new URL(url).searchParams.get('wsid') ?? randomID(),
  );
}

function hasPendingMutations(clients: ClientMap) {
  for (const clientState of clients.values()) {
    if (clientState.pending.length > 0) {
      return true;
    }
  }
  return false;
}

/**
 * Adds the "client IP address connecting to Cloudflare to the origin web
 * server" to the LogContext.
 * https://developers.cloudflare.com/fundamentals/get-started/reference/http-request-headers/#cf-connecting-ip
 *
 * If the header is not present, the LogContext is returned unchanged.
 */
function addClientIPToLogContext(lc: LogContext, request: Request): LogContext {
  const ip = request.headers.get('CF-Connecting-IP');
  return ip ? lc.addContext('clientIP', ip) : lc;
}
