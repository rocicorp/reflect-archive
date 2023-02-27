import type {LogLevel, LogSink} from '@rocicorp/logger';
import type {Pusher} from './pusher.js';
import type {Puller} from './puller.js';
import type {MutatorDefs, RequestOptions} from './replicache.js';
import type * as kv from './kv/mod.js';
import type {IndexDefinitions} from './index-defs.js';

/**
 * The options passed to {@link Replicache}.
 */

export interface ReplicacheOptions<MD extends MutatorDefs> {
  /**
   * This is the URL to the server endpoint dealing with the push updates. See
   * [Push Endpoint Reference](https://doc.replicache.dev/reference/server-push) for more
   * details.
   *
   * If not provided, push requests will not be made unless a custom
   * {@link ReplicacheOptions.pusher} is provided.
   */
  pushURL?: string | undefined;

  /**
   * This is the authorization token used when doing a
   * [pull](https://doc.replicache.dev/reference/server-pull#authorization) and
   * [push](https://doc.replicache.dev/reference/server-push#authorization).
   */
  auth?: string | undefined;

  /**
   * This is the URL to the server endpoint dealing with pull. See [Pull
   * Endpoint Reference](https://doc.replicache.dev/reference/server-pull) for more
   * details.
   *
   * If not provided, pull requests will not be made unless a custom
   * {@link ReplicacheOptions.puller} is provided.
   */
  pullURL?: string | undefined;

  /**
   * The name of the Replicache database.
   *
   * It is important to use user specific names so that if there are multiple
   * tabs open for different distinct users their data is kept separate.
   *
   * For efficiency and performance, a new {@link Replicache} instance will
   * initialize its state from the persisted state of an existing {@link Replicache}
   * instance with the same `name`, domain and browser profile.
   *
   * Mutations from one {@link Replicache} instance may be pushed using the
   * {@link ReplicacheOptions.auth}, {@link ReplicacheOptions.pushURL},
   * {@link ReplicacheOptions.pullURL}, {@link ReplicacheOptions.pusher}, and
   * {@link ReplicacheOptions.puller}  of another Replicache instance with the same
   * `name`, domain and browser profile.
   *
   * You can use multiple Replicache instances for the same user as long as the
   * names are unique.  e.g. `name: `$userID:$roomID`
   */
  name: string;

  /**
   * The schema version of the data understood by this application. This enables
   * versioning of mutators (in the push direction) and the client view (in the
   * pull direction).
   */
  schemaVersion?: string | undefined;

  /**
   * The duration between each {@link pull} in milliseconds. Set this to `null` to
   * prevent pulling in the background.  Defaults to 60 seconds.
   */
  pullInterval?: number | null | undefined;

  /**
   * The delay between when a change is made to Replicache and when Replicache
   * attempts to push that change.
   */
  pushDelay?: number | undefined;

  /**
   * Determines how much logging to do. When this is set to `'debug'`,
   * Replicache will also log `'info'` and `'error'` messages. When set to
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
   * provide an array of {@link LogSink}s.  Logs at or above
   * {@link ReplicacheOptions.logLevel} are sent to each of these {@link LogSink}s.
   * If you would still like logs to go to the console, include
   * `consoleLogSink` in the array.
   *
   * ```ts
   * logSinks: [consoleLogSink, myCloudLogSink],
   * ```
   */
  logSinks?: LogSink[] | undefined;

  /**
   * An object used as a map to define the *mutators*. These gets registered at
   * startup of {@link Replicache}.
   *
   * *Mutators* are used to make changes to the data.
   *
   * #### Example
   *
   * The registered *mutations* are reflected on the
   * {@link Replicache.mutate | mutate} property of the {@link Replicache} instance.
   *
   * ```ts
   * const rep = new Replicache({
   *   name: 'user-id',
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
   * await rep.mutate.createTodo({
   *   id: 1234,
   *   title: 'Make things work offline',
   *   complete: true,
   * });
   * ```
   *
   * #### Replays
   *
   * *Mutators* run once when they are initially invoked, but they might also be
   * *replayed* multiple times during sync. As such *mutators* should not modify
   * application state directly. Also, it is important that the set of
   * registered mutator names only grows over time. If Replicache syncs and
   * needed *mutator* is not registered, it will substitute a no-op mutator, but
   * this might be a poor user experience.
   *
   * #### Server application
   *
   * During push, a description of each mutation is sent to the server's [push
   * endpoint](https://doc.replicache.dev/reference/server-push) where it is applied. Once
   * the *mutation* has been applied successfully, as indicated by the client
   * view's
   * [`lastMutationId`](https://doc.replicache.dev/reference/server-pull#lastmutationid)
   * field, the local version of the *mutation* is removed. See the [design
   * doc](https://doc.replicache.dev/design#commits) for additional details on
   * the sync protocol.
   *
   * #### Transactionality
   *
   * *Mutators* are atomic: all their changes are applied together, or none are.
   * Throwing an exception aborts the transaction. Otherwise, it is committed.
   * As with {@link query} and {@link subscribe} all reads will see a consistent view of
   * the cache while they run.
   */
  mutators?: MD | undefined;

  /**
   * Options to use when doing pull and push requests.
   */
  requestOptions?: RequestOptions | undefined;

  /**
   * Allows passing in a custom implementation of a {@link Puller} function. This
   * function is called when doing a pull and it is responsible for
   * communicating with the server.
   *
   * Normally, this is just a POST to a URL with a JSON body but you can provide
   * your own function if you need to do things differently.
   */
  puller?: Puller | undefined;

  /**
   * Allows passing in a custom implementation of a {@link Pusher} function. This
   * function is called when doing a push and it is responsible for
   * communicating with the server.
   *
   * Normally, this is just a POST to a URL with a JSON body but you can provide
   * your own function if you need to do things differently.
   */
  pusher?: Pusher | undefined;

  /**
   * The license key for Replicache. This parameter is required for Replicache to
   * function. See https://replicache.dev for how to acquire a license key.
   *
   * YOU SHOULD PASS TEST_LICENSE_KEY IN AUTOMATED TESTS. It disables license
   * checks for several minutes. If you pass a normal license key in tests, each test
   * that instantiates Replicache will attempt to perform a license check against
   * Replicache's licensing server, potentially increasing your monthly active browser
   * profile count, slowing the test down, and spamming Replicache's servers.
   */
  licenseKey: string;

  /**
   * Allows providing a custom implementation of the underlying storage layer.
   *
   * @experimental This option is experimental and might be removed or changed
   * in the future without following semver versioning. Please be cautious.
   */
  experimentalCreateKVStore?: kv.CreateStore | undefined;

  /**
   * Defines the indexes, if any, to use on the data.
   */
  readonly indexes?: IndexDefinitions | undefined;
}

export const enablePullAndPushInOpenSymbol = Symbol();
export const enableMutationRecoverySymbol = Symbol();
export const enableScheduledPersistSymbol = Symbol();
export const enableScheduledRefreshSymbol = Symbol();

export type ReplicacheInternalOptions = {
  /**
   * Defaults to true.
   * Does not use a symbol because it is used by reflect.
   */
  enableLicensing?: boolean | undefined;

  /**
   * Defaults to true.
   */
  [enableMutationRecoverySymbol]?: boolean | undefined;

  /**
   * Defaults to true.
   */
  [enableScheduledPersistSymbol]?: boolean | undefined;

  /**
   * Defaults to true.
   */
  [enableScheduledRefreshSymbol]?: boolean | undefined;

  /**
   * Defaults to true.
   */
  [enablePullAndPushInOpenSymbol]?: boolean | undefined;

  /**
   * Allows exposing parts of the internal API to a subclass. This works when
   * thing have been minified and with the npm package.
   */
  exposeInternalAPI?: (api: ReplicacheInternalAPI) => void;
};

export interface ReplicacheInternalAPI {
  persist(): Promise<void>;
  refresh(): Promise<void>;
}