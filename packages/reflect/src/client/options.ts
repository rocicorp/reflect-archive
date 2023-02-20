import type {LogLevel, LogSink, MaybePromise, MutatorDefs} from 'replicache';
import type {Metrics} from './metrics.js';

/**
 * Configuration for [[Reflect]].
 */
export interface ReflectOptions<MD extends MutatorDefs> {
  /**
   * Origin for WebSocket connections to the Reflect server. This must have a
   * `'ws'` or `'wss'` scheme.
   */
  socketOrigin: string;

  /**
   * Identifies and authenticates the user.
   *
   * This string is passed to the `authHandler` function on the server, where
   * it can be used to authenticate the user.
   *
   * In the case authentication fails, the connection to the server will be
   * closed and Reflect will retry connecting with exponential backoff.
   *
   * If a function is provided here, that function is invoked before each
   * attempt. This provides the application the opportunity to calculate or
   * fetch a fresh token.
   */
  auth: string | (() => MaybePromise<string>);

  /**
   * A unique identifier for the user authenticated by
   * [[ReflectOptions.auth]]. Must be non-empty.
   *
   * This must be the same as the `userID` returned by the `authHandler` you
   * provide to the Reflect server.
   *
   * For efficiency, a new Reflect instance will initialize its state from
   * the persisted state of an existing Reflect instance with the same
   * `userID`, `roomID`, domain and browser profile.
   *
   * Mutations from one Reflect instance may be pushed using the
   * [[Reflect.auth]] of another Reflect instance with the same
   * `userID`, `roomID`, domain and browser profile.
   */
  userID: string;

  /**
   * A unique identifier for the room.
   *
   * For efficiency, a new Reflect instance will initialize its state from
   * the persisted state of an existing Reflect instance with the same
   * `userID`, `roomID`, domain and browser profile.
   *
   * Mutations from one Reflect instance may be pushed using the
   * [[Reflect.auth]] of another Reflect instance with the same
   * `userID`, `roomID`, domain and browser profile.
   */
  roomID: string;

  /**
   * The schema version of the data understood by this application. This enables
   * versioning of mutators and the client view.
   */
  schemaVersion?: string | undefined;

  /**
   * Determines how much logging to do. When this is set to `'debug'`,
   * `'info'` and `'error'` messages are also logged. When set to
   * `'info'` we log `'info'` and `'error'` but not `'debug'`. When set to
   * `'error'` we only log `'error'` messages.
   * Default is `'info'`.
   */
  logLevel?: LogLevel | undefined;

  /**
   * Enables custom handling of logs.
   *
   * By default logs are logged to the console.  If you would like logs to be
   * sent elsewhere (e.g. to a cloud logging service like DataDog) you can
   * provide an array of [[LogSink]]s.  Logs at or above
   * [[ReflectOptions.logLevel]] are sent to each of these [[LogSink]]s.
   * If you would still like logs to go to the console, include
   * [[consoleLogSink]] in the array.
   *
   * ```ts
   * logSinks: [consoleLogSink, myCloudLogSink],
   * ```
   */
  logSinks?: LogSink[] | undefined;

  /**
   * An object used as a map to define the *mutators* for this application.
   *
   * *Mutators* are used to make changes to the Reflect data.
   *
   * The registered *mutations* are reflected on the
   * [[Reflect.mutate|mutate]] property of the [[Reflect]] instance.
   *
   * #### Example
   *
   * ```ts
   * const reflect = new Reflect({
   *   socketOrigin: 'wss://example.com/',
   *   userID: 'user-id',
   *   roomID: 'room-id',
   *   mutators: {
   *     async createTodo(tx: WriteTransaction, args: JSONValue) {
   *       const key = `/todo/${args.id}`;
   *       if (await tx.has(key)) {
   *         throw new Error('Todo already exists');
   *       }
   *       await tx.put(key, args);
   *     },
   *     async deleteTodo(tx: WriteTransaction, id: number) {
   *       ...
   *     },
   *   },
   * });
   * ```
   *
   * This will create the function to later use:
   *
   * ```ts
   * await reflect.mutate.createTodo({
   *   id: 1234,
   *   title: 'Make things realtime',
   *   complete: true,
   * });
   * ```
   *
   * #### Replays
   *
   * *Mutators* run once when they are initially invoked, but they might also be
   * *replayed* multiple times during sync. As such *mutators* should not modify
   * application state directly. Also, it is important that the set of
   * registered mutator names only grows over time. If Reflect syncs and a
   * needed *mutator* is not registered, it will substitute a no-op mutator, but
   * this might be a poor user experience.
   *
   * #### Server application
   *
   * During sync, a description of each mutation is sent to the server where it
   * is applied. Once the *mutation* has been applied successfully, the local
   * version of the *mutation* is removed. See the [design
   * doc](https://doc.replicache.dev/design#commits) for additional details on
   * the sync protocol.
   *
   * #### Transactionality
   *
   * *Mutators* are atomic: all their changes are applied together, or none are.
   * Throwing an exception aborts the transaction. Otherwise, it is committed.
   * As with [[query]] and [[subscribe]] all reads will see a consistent view of
   * the cache while they run.
   */
  mutators?: MD | undefined;

  /**
   * `onOnlineChange` is called when the Reflect instance's online status changes
   */
  onOnlineChange?: ((online: boolean) => void) | undefined;

  /**
   * metrics is the interface by which Reflect instantiates metrics
   * to record important events.
   *
   * It is expected that the caller has arranged for the Metrics to be periodically
   * reported to a server. Reflect server offers an endpoint to receive metrics from
   * the client and report them to Datadog (datadog does not support CORS so metrics
   * cannot be directly submitted). You can use
   *  https://github.com/rocicorp/datadog-util
   * as the concrete implementation to record metrics and report them.
   *
   * ```ts
   * const metrics = new Metrics();
   * const reporter = new Reporter({
   *   metrics,
   *   url: '<reflect server url>/api/metrics/v0/report',
   *   headers: { [DD_AUTH_HEADER_NAME]: '<your-datadog-api-key>'},
   * });
   * const reflect = new Reflect({
   *   ...
   *   metrics,
   * });
   * ```
   *
   * If metrics is undefined, the default implementation is a no-op.
   */
  metrics?: Metrics | undefined;
}