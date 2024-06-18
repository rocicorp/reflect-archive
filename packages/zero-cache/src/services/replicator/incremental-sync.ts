import {PG_UNIQUE_VIOLATION} from '@drdgvhbh/postgres-error-codes';
import type {LogContext} from '@rocicorp/logger';
import {EventEmitter} from 'eventemitter3';
import {
  LogicalReplicationService,
  Pgoutput,
  PgoutputPlugin,
} from 'pg-logical-replication';
import postgres from 'postgres';
import {assert} from 'shared/src/asserts.js';
import {Queue} from 'shared/src/queue.js';
import {sleep} from 'shared/src/sleep.js';
import {
  ControlFlowError,
  Statement,
  TransactionPool,
} from '../../db/transaction-pool.js';
import {epochMicrosToTimestampTz} from '../../types/big-time.js';
import {JSONValue, stringify} from '../../types/bigint-json.js';
import type {LexiVersion} from '../../types/lexi-version.js';
import {PostgresDB, registerPostgresTypeParsers} from '../../types/pg.js';
import type {RowKey, RowKeyType, RowValue} from '../../types/row-key.js';
import type {CancelableAsyncIterable} from '../../types/streams.js';
import {Subscription} from '../../types/subscription.js';
import {replicationSlot} from './initial-sync.js';
import {InvalidationFilters, InvalidationProcessor} from './invalidation.js';
import type {RowChange, VersionChange} from './replicator.js';
import {ZERO_VERSION_COLUMN_NAME, queryLastLSN} from './schema/replication.js';
import {PublicationInfo, getPublicationInfo} from './tables/published.js';
import type {TransactionTrain} from './transaction-train.js';
import {toLexiVersion} from './types/lsn.js';
import {TableTracker} from './types/table-tracker.js';

// BigInt support from LogicalReplicationService.
registerPostgresTypeParsers();

const INITIAL_RETRY_DELAY_MS = 100;
const MAX_RETRY_DELAY_MS = 10000;

/**
 * The {@link IncrementalSyncer} manages a logical replication stream from upstream,
 * handling application lifecycle events (start, stop) and retrying the
 * connection with exponential backoff. The actual handling of the logical
 * replication messages is done by the {@link MessageProcessor}.
 */
export class IncrementalSyncer {
  readonly #upstreamUri: string;
  readonly #replicaID: string;
  readonly #replica: PostgresDB;
  readonly #eventEmitter: EventEmitter = new EventEmitter();

  // The train ensures that transactions are processed serially, even
  // across re-connects to the upstream db and multiple (temporarily)
  // running instances of the Replicator.
  readonly #txTrain: TransactionTrain;
  readonly #invalidationFilters: InvalidationFilters;

  #retryDelay = INITIAL_RETRY_DELAY_MS;
  #service: LogicalReplicationService | undefined;
  #started = false;
  #stopped = false;

  constructor(
    upstreamUri: string,
    replicaID: string,
    replica: PostgresDB,
    txTrain: TransactionTrain,
    invalidationFilters: InvalidationFilters,
  ) {
    this.#upstreamUri = upstreamUri;
    this.#replicaID = replicaID;
    this.#replica = replica;
    this.#txTrain = txTrain;
    this.#invalidationFilters = invalidationFilters;
  }

  async run(lc: LogContext) {
    assert(!this.#started, `IncrementalSyncer has already been started`);
    this.#started = true;
    lc.info?.(`Starting IncrementalSyncer`);
    const replicated = await getPublicationInfo(this.#replica);
    const publicationNames = replicated.publications.map(p => p.pubname);

    // Using default from https://github.com/kibae/pg-logical-replication/blob/34b90136b06aa52f7d1fd86b91c2405692445d5a/src/logical-replication-service.ts#L135C62-L135C74
    let lastLSN = (await queryLastLSN(this.#replica)) ?? '0/00000000';

    lc.info?.(`Syncing publications ${publicationNames}`);
    while (!this.#stopped) {
      const service = new LogicalReplicationService(
        {connectionString: this.#upstreamUri},
        {acknowledge: {auto: false, timeoutSeconds: 0}},
      );
      this.#service = service;

      const processor = new MessageProcessor(
        replicated,
        this.#txTrain,
        this.#invalidationFilters,
        (lsn: string) => {
          if (!lastLSN || toLexiVersion(lastLSN) < toLexiVersion(lsn)) {
            lastLSN = lsn;
          }
          void service.acknowledge(lsn);
        },
        (v: VersionChange) => this.#eventEmitter.emit('version', v),
        (lc: LogContext, err: unknown) => this.stop(lc, err),
      );
      this.#service.on('data', (lsn: string, message: Pgoutput.Message) => {
        this.#retryDelay = INITIAL_RETRY_DELAY_MS; // Reset exponential backoff.
        processor.processMessage(lc, lsn, message);
      });
      this.#service.on(
        'heartbeat',
        (lsn: string, time: number, shouldRespond: boolean) => {
          if (shouldRespond) {
            lc.debug?.(`keepalive (lastLSN: ${lastLSN}): ${lsn}, ${time}`);
            void service.acknowledge(lastLSN ?? '0/0');
          }
        },
      );

      try {
        // TODO: Start from the last acknowledged LSN.
        await this.#service.subscribe(
          new PgoutputPlugin({protoVersion: 1, publicationNames}),
          replicationSlot(this.#replicaID),
          lastLSN,
        );
      } catch (e) {
        if (!this.#stopped) {
          await this.#service.stop();
          const delay = this.#retryDelay;
          this.#retryDelay = Math.min(this.#retryDelay * 2, MAX_RETRY_DELAY_MS);
          lc.error?.(`Error in Replication Stream. Retrying in ${delay}ms`, e);
          await sleep(delay);
        }
      }
    }
    lc.info?.('IncrementalSyncer stopped');
  }

  versionChanges(): Promise<CancelableAsyncIterable<VersionChange>> {
    const subscribe = (v: VersionChange) => subscription.push(v);
    const subscription: Subscription<VersionChange> =
      Subscription.create<VersionChange>({
        coalesce: (curr, prev) => ({
          newVersion: curr.newVersion,
          prevVersion: prev.prevVersion,
          invalidations:
            !prev.invalidations || !curr.invalidations
              ? undefined
              : {
                  ...prev.invalidations,
                  ...curr.invalidations,
                },
          changes:
            !prev.changes || !curr.changes
              ? undefined
              : [...prev.changes, ...curr.changes],
        }),
        cleanup: () => this.#eventEmitter.off('version', subscribe),
      });

    this.#eventEmitter.on('version', subscribe);
    return Promise.resolve(subscription);
  }

  async stop(lc: LogContext, err?: unknown) {
    if (this.#service) {
      if (err) {
        lc.error?.('IncrementalSyncer stopped with error', err);
      } else {
        lc.info?.(`Stopping IncrementalSyncer`);
      }
      this.#stopped = true;
      await this.#service.stop();
    }
  }
}

function ensureError(err: unknown): Error {
  if (err instanceof Error) {
    return err;
  }
  const error = new Error();
  error.cause = err;
  return error;
}

class PrecedingTransactionError extends ControlFlowError {
  constructor(err: unknown) {
    super(err);
  }
}

/**
 * The {@link MessageProcessor} partitions the stream of messages into transactions
 * by creating a {@link TransactionProcessor} when a transaction begins, and dispatching
 * messages to it until the commit is received.
 *
 * From https://www.postgresql.org/docs/current/protocol-logical-replication.html#PROTOCOL-LOGICAL-MESSAGES-FLOW :
 *
 * "The logical replication protocol sends individual transactions one by one.
 *  This means that all messages between a pair of Begin and Commit messages
 *  belong to the same transaction."
 *
 * Note that the processing of transactions must be serialized to guarantee that each
 * transaction can see the results of its predecessors. This is done with the
 * singleton `txSerializer` lock created in the IncrementalSyncer service.
 *
 * The logic for handling a transaction happens in two stages.
 *
 * 1. In the **Assembly** stage, logical replication messages from upstream are
 *    gathered by the MessageProcessor and passed to the TransactionProcessor.
 *    At the very first `Begin` message, a downstream Postgres transaction
 *    is enqueued to be started in the `txSerializer` lock.
 *
 * 2. In the **Processing** stage, all preceding transactions have completed,
 *    the downstream Postgres transaction has started, and the Transaction
 *    Processor executes statements on it.
 *
 * Note that the two stages can overlap; for example, a transaction with a
 * large number of messages may still be streaming in when the downstream
 * transaction handle becomes ready. However, it is more common for the
 * transaction to have already been assembled when it comes time for it
 * to be processed, either because it has a small number of messages, or
 * because a preceding transaction is still being processed while the next
 * one is assembled.
 *
 * Here is an example timeline of assembly stages `A*` and
 * their corresponding processing stages `P*`:
 *
 * ```
 *  ----> Upstream Logical Replication Messages ---->
 * ---------------------------     -------------------
 * |      A1       | A2 | A3 |     |   A4   |   A5   |
 * -------------------------------------------------------------------------
 *         |      P1        |   P2   |   P3    |      |   P4   |    P5     |
 *         -------------------------------------      ----------------------
 *                      ----> Downstream Transactions ---->
 * ```
 *
 * This is important to understand in the context of error handling. Although
 * errors are not expected to happen in the steady state, error handling is
 * necessary to avoid corrupting the replica with a state that is
 * inconsistent with a snapshot of upstream.
 *
 * An error may happen in the Assembly stage (e.g. unexpected Message formats,
 * unsupported schema changes), or the Processing stage (e.g. query execution
 * errors, constraint violations, etc.). The desired behavior when encountering
 * an error is to:
 *
 * 1. allow all preceding transactions to successfully finish processing
 *
 * 2. cancel/rollback the erroneous transaction, and disallow all subsequent
 *    transactions from proceeding
 *
 * 3. shut down the service (after which manual intervention is likely needed
 *    to address the unhandled condition).
 *
 * In order to satisfy (1) and (2), error handling is plumbed through the
 * TransactionProcessor object so that it is always surfaced in the Processing
 * stage, even if the error was encountered in the Assembly stage.
 *
 * In the unlikely event that an error is encountered _between_ assembling
 * transactions (e.g. an unexpected Message between the last MessageCommit
 * and the next MessageBegin) and there is no TransactionProcessor being
 * assembled, a callback to fail the service is manually enqueued on the
 * `txSerializer` to allow preceding transactions to complete before shutting
 * down.
 *
 * It follows that, from an implementation perspective, the MessageProcessor's
 * failure handling must always be done from within the `txSerializer` lock.
 */
// Exported for testing.
export class MessageProcessor {
  readonly #replicated: PublicationInfo;
  readonly #txTrain: TransactionTrain;
  readonly #invalidationFilters: InvalidationFilters;
  readonly #acknowledge: (lsn: string) => unknown;
  readonly #emitVersion: (v: VersionChange) => void;
  readonly #failService: (lc: LogContext, err: unknown) => void;

  #currentTx: Queue<Pgoutput.Message> | null = null;

  #failure: Error | undefined;
  #tx: TransactionProcessor | undefined;

  constructor(
    replicated: PublicationInfo,
    txTrain: TransactionTrain,
    invalidationFilters: InvalidationFilters,
    acknowledge: (lsn: string) => unknown,
    emitVersion: (v: VersionChange) => void,
    failService: (lc: LogContext, err: unknown) => void,
  ) {
    this.#replicated = replicated;
    this.#txTrain = txTrain;
    this.#invalidationFilters = invalidationFilters;
    this.#acknowledge = acknowledge;
    this.#emitVersion = emitVersion;
    this.#failService = failService;
  }

  #createAndEnqueueNewTransaction(
    lc: LogContext,
    commitLsn: string,
    messages: Queue<Pgoutput.Message>,
  ): void {
    const start = Date.now();
    void this.#txTrain.runNext(
      async (writer, readers, preStateVersion, invalidationRegistryVersion) => {
        const inLock = Date.now();
        const txProcessor = new TransactionProcessor(
          lc,
          commitLsn,
          writer,
          readers,
          this.#invalidationFilters,
        );
        try {
          if (this.#failure) {
            // If a preceding transaction failed, all subsequent transactions must also fail.
            txProcessor.fail(new PrecedingTransactionError(this.#failure));
            return;
          }

          loop: for await (const msg of messages.asAsyncIterable()) {
            switch (msg.tag) {
              case 'begin':
                txProcessor.processBegin(msg, invalidationRegistryVersion);
                break;
              case 'relation':
                this.#processRelation(msg);
                break;
              case 'insert':
                txProcessor.processInsert(msg);
                break;
              case 'update':
                txProcessor.processUpdate(msg);
                break;
              case 'delete':
                txProcessor.processDelete(msg);
                break;
              case 'truncate':
                txProcessor.processTruncate(msg);
                break;
              case 'commit': {
                txProcessor.processCommit(msg);
                break loop; // Done with transaction!
              }
              case 'origin':
                // We are agnostic as to which node a transaction originated from.
                lc.info?.('Ignoring ORIGIN message in replication stream', msg);
                break;
              case 'type':
                throw new Error(
                  `Custom types are not supported (received "${msg.typeName}")`,
                );
              default:
                // TODO: Determine what the "Message" message is.
                // https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html#:~:text=Identifies%20the%20message%20as%20a%20logical%20decoding%20message.
                lc.error?.(
                  `Received unexpected message of type ${msg.tag}`,
                  msg,
                );
                throw new Error(
                  `Don't know how to handle message of type ${msg.tag}`,
                );
            }
          }

          const versionChange =
            await txProcessor.getFinalVersionChange(preStateVersion);
          this.#acknowledge(commitLsn);
          this.#emitVersion(versionChange);
          lc.debug?.(
            `Committed tx (queued: ${inLock - start} ms) (${
              Date.now() - start
            } ms)`,
          );
        } catch (e) {
          if (
            // A unique violation on the TxLog means that the transaction has already been
            // processed. This is not a real error, and can happen, for example, if the upstream
            // the connection was lost before the acknowledgment was sent. Recover by resending
            // the acknowledgement, and continue processing the stream.
            e instanceof postgres.PostgresError &&
            e.code === PG_UNIQUE_VIOLATION &&
            e.schema_name === '_zero' &&
            e.table_name === 'TxLog'
          ) {
            this.#acknowledge(commitLsn);
            lc.debug?.(`Skipped repeat tx`);
          } else {
            this.#failInLock(lc, e);
          }
        }
      },
    );
  }

  /** See {@link MessageProcessor} documentation for error handling semantics. */
  #fail(lc: LogContext, err: unknown) {
    if (this.#tx) {
      // If a current transaction is being assembled, fail it so that the `err` is surfaced
      // from within the transaction's processing stage, i.e. from within the `txSerializer`
      // lock via the TransactionProcessor's `setFailed` rejection callback.
      this.#tx.fail(err);
    } else {
      // Otherwise, manually enqueue the failure on the `txTrain` to allow previous
      // transactions to complete, and prevent subsequent transactions from proceeding.
      void this.#txTrain.runNext(() => {
        this.#failInLock(lc, err);
      });
    }
  }

  // This must be called from within the txSerializer lock to allow pending
  // (not-failed) transactions to complete.
  #failInLock(lc: LogContext, err: unknown) {
    if (!this.#failure) {
      this.#failure = ensureError(err);
      lc.error?.('Message Processing failed:', this.#failure);
      this.#failService(lc, this.#failure);
    }
  }

  processMessage(lc: LogContext, lsn: string, message: Pgoutput.Message) {
    lc = lc.withContext('lsn', lsn);
    if (this.#failure) {
      lc.debug?.(`Dropping ${message.tag}`);
      return;
    }
    try {
      this.#processMessage(lc, lsn, message);
    } catch (e) {
      this.#fail(lc, e);
    }
  }

  #processMessage(lc: LogContext, lsn: string, message: Pgoutput.Message) {
    if (message.tag === 'begin') {
      const {commitLsn} = message;
      assert(commitLsn);

      if (this.#currentTx) {
        throw new Error(`Already in a transaction ${stringify(message)}`);
      }
      this.#currentTx = new Queue();
      this.#createAndEnqueueNewTransaction(
        lc.withContext('txBegin', lsn).withContext('txCommit', commitLsn),
        commitLsn,
        this.#currentTx,
      );
    }

    // For non-begin messages, there should be a #currentTx set.
    if (!this.#currentTx) {
      throw new Error(
        `Received message outside of transaction: ${stringify(message)}`,
      );
    }
    void this.#currentTx.enqueue(message);

    if (message.tag === 'commit') {
      // Undef this.#currentTx to allow the assembly of the next transaction.
      this.#currentTx = null;
    }
  }

  #processRelation(rel: Pgoutput.MessageRelation) {
    if (rel.replicaIdentity !== 'default') {
      throw new Error(
        // REPLICA IDENTITY DEFAULT is the default setting for all tables.
        // We require this so that the replication stream sends the PRIMARY KEY
        // columns in the MessageRelation message.
        //
        // REPLICA IDENTITY FULL, on the other hand, handles all columns as "key"
        // columns and hinders our ability to detect when the actual key columns change.
        // It is not expected that anyone is changing the default; this check is here
        // for defensive completeness.
        `REPLICA IDENTITY for ${rel.schema}.${rel.name} must be DEFAULT, found ${rel.replicaIdentity}`,
      );
    }
    // TODO: Check columns, keys, etc. for schema syncing.
    // For now, just reference the variable to appease the compiler.
    this.#replicated;
  }
}

/**
 * The {@link TransactionProcessor} handles the sequence of messages from
 * upstream, from `BEGIN` to `COMMIT` and executes the corresponding mutations
 * on the {@link postgres.TransactionSql} on the replica.
 */
class TransactionProcessor {
  readonly #lc: LogContext;
  readonly #version: LexiVersion;
  readonly #invalidation: InvalidationProcessor;
  readonly #writer: TransactionPool;
  readonly #readers: TransactionPool;
  readonly #tableTrackers = new Map<string, TableTracker>();

  constructor(
    lc: LogContext,
    lsn: string,
    writer: TransactionPool,
    readers: TransactionPool,
    filters: InvalidationFilters,
  ) {
    this.#version = toLexiVersion(lsn);
    this.#lc = lc.withContext('tx', this.#version);
    this.#invalidation = new InvalidationProcessor(filters);
    this.#writer = writer;
    this.#readers = readers;
  }

  async getFinalVersionChange(
    prevVersion: LexiVersion,
  ): Promise<VersionChange> {
    const [writes, reads] = await Promise.allSettled([
      this.#writer.done(),
      this.#readers.done(),
    ]);
    if (reads.status === 'rejected') {
      // An error from the readers pool is logged but otherwise dropped, because meaningful
      // errors from the readers pool must necessarily be propagated to the writer pool.
      //
      // In particular, an error from the reader pool may arise because of a transaction
      // error from the writer pool (i.e. UNIQUE violation constraint from a transaction
      // replay preventing a snapshot capture from happening). In such a case, it is
      // imperative that the writer pool error is surfaced directly, rather than masking it
      // with an auxiliary error from the reader pool
      this.#lc.info?.(`Error from reader pool`, reads.reason);
    }
    if (writes.status === 'rejected') {
      throw writes.reason;
    }

    const invalidations = this.#invalidation.getInvalidations();

    return {
      newVersion: this.#version,
      prevVersion,
      invalidations: Object.fromEntries(
        [...invalidations.keys()].map(hash => [hash, this.#version]),
      ),
      changes: rowChanges(this.#tableTrackers.values()),
    };
  }

  fail(err: unknown) {
    this.#writer.fail(err);
    this.#readers.fail(err);
  }

  processBegin(
    begin: Pgoutput.MessageBegin,
    invalidationRegistryVersion: LexiVersion | null,
  ) {
    this.#invalidation.processInitTasks(
      this.#readers,
      invalidationRegistryVersion,
    );

    const row = {
      stateVersion: this.#version,
      lsn: begin.commitLsn,
      time: epochMicrosToTimestampTz(begin.commitTime.valueOf()),
      xid: begin.xid,
    };

    return this.#writer.process(tx => [
      tx`INSERT INTO _zero."TxLog" ${tx(row)}`,
    ]);
  }

  processInsert(insert: Pgoutput.MessageInsert) {
    const row = {
      ...insert.new,
      [ZERO_VERSION_COLUMN_NAME]: this.#version,
    };
    const key = Object.fromEntries(
      insert.relation.keyColumns.map(col => [col, insert.new[col]]),
    );
    this.#getTableTracker(insert.relation).add({
      preValue: 'none',
      postRowKey: key,
      postValue: row,
    });

    return this.#writer.process(tx => [
      tx`INSERT INTO ${table(tx, insert)} ${tx(row)}`,
    ]);
  }

  processUpdate(update: Pgoutput.MessageUpdate) {
    const row = {
      ...update.new,
      [ZERO_VERSION_COLUMN_NAME]: this.#version,
    };
    // update.key is set with the old values if the key has changed.
    const oldKey = update.key;
    const newKey = Object.fromEntries(
      update.relation.keyColumns.map(col => [col, update.new[col]]),
    );
    this.#getTableTracker(update.relation).add({
      preRowKey: oldKey,
      preValue: 'unknown',
      postRowKey: newKey,
      postValue: row,
    });

    return this.#writer.process(tx => {
      const currKey = oldKey ?? newKey;
      const conds = Object.entries(currKey).map(
        ([col, val]) => tx`${tx(col)} = ${val}`,
      );

      // Note: The flatMap() dance for dynamic filters is a bit obtuse, but it is
      //       what the Postgres.js author recommends until there's a better api for it.
      //       https://github.com/porsager/postgres/issues/807#issuecomment-1949924843
      return [
        tx`
        UPDATE ${table(tx, update)}
          SET ${tx(row)}
          WHERE ${conds.flatMap((k, i) => (i ? [tx` AND `, k] : k))}`,
      ];
    });
  }

  processDelete(del: Pgoutput.MessageDelete) {
    // REPLICA IDENTITY DEFAULT means the `key` must be set.
    // https://www.postgresql.org/docs/current/protocol-logicalrep-message-formats.html
    assert(del.relation.replicaIdentity === 'default');
    assert(del.key);
    const rowKey = del.key;

    this.#getTableTracker(del.relation).add({
      preValue: 'unknown',
      postRowKey: rowKey,
      postValue: 'none',
    });

    return this.#writer.process(tx => {
      const conds = Object.entries(rowKey).map(
        ([col, val]) => tx`${tx(col)} = ${val}`,
      );

      // Note: The flatMap() dance for dynamic filters is a bit obtuse, but it is
      //       what the Postgres.js author recommends until there's a better api for it.
      //       https://github.com/porsager/postgres/issues/807#issuecomment-1949924843
      return [
        tx`
      DELETE FROM ${table(tx, del)}
        WHERE ${conds.flatMap((k, i) => (i ? [tx` AND `, k] : k))} `,
      ];
    });
  }

  processTruncate(truncate: Pgoutput.MessageTruncate) {
    for (const relation of truncate.relations) {
      this.#getTableTracker(relation).truncate();
    }

    const tables = truncate.relations.map(r => `${r.schema}.${r.name}`);
    return this.#writer.process(tx => [tx`TRUNCATE ${tx(tables)}`]);
  }

  processCommit(_commit: Pgoutput.MessageCommit) {
    this.#writer.process(tx => {
      // Construct ChangeLog entries based on the effective row changes.
      const changeLogEntries: Statement[] = [];
      for (const table of this.#tableTrackers.values()) {
        const {truncated, changes} = table.getEffectiveRowChanges();
        if (truncated) {
          changeLogEntries.push(
            this.#changeLogEntry(tx, table.schema, table.table),
          );
        }
        for (const [_, change] of changes) {
          changeLogEntries.push(
            this.#changeLogEntry(
              tx,
              table.schema,
              table.table,
              change.rowKey,
              change.postValue === 'none' ? undefined : change.postValue,
            ),
          );
        }
      }
      return changeLogEntries;
    });
    // Invalidation tagging involves blocking on reader pool queries
    // (which read the pre-transaction state of UPDATE'd and DELETE'd rows).
    // Process these tasks last so that all of the user table and ChangeLog
    // writes can be applied in parallel with the computation of the invalidation tags.
    this.#invalidation.processFinalTasks(
      this.#readers,
      this.#writer,
      this.#version,
      this.#tableTrackers.values(),
    );
    this.#readers.setDone();
    this.#writer.setDone();
  }

  #changeLogEntry(
    tx: postgres.TransactionSql,
    schema: string,
    table: string,
    key?: RowKey,
    row?: RowValue,
  ) {
    const change: ChangeLogEntry = {
      stateVersion: this.#version,
      schema,
      table,
      op: row ? 's' : key ? 'd' : 't',
      rowKey: (key as postgres.JSONValue) ?? {}, // Empty object for truncate
    };
    return tx`
    INSERT INTO _zero."ChangeLog" ${tx(change)}
      ON CONFLICT ON CONSTRAINT "RK_change_log"
      DO UPDATE SET ${tx(change)};
    `;
  }

  #getTableTracker(relation: Pgoutput.MessageRelation) {
    const key = stringify([relation.schema, relation.name]);
    const rowKeyType: RowKeyType = Object.fromEntries(
      relation.keyColumns.map(name => {
        const column = relation.columns.find(c => c.name === name);
        assert(column);
        return [name, column];
      }),
    );
    let tracker = this.#tableTrackers.get(key);
    if (!tracker) {
      tracker = new TableTracker(relation.schema, relation.name, rowKeyType);
      this.#tableTrackers.set(key, tracker);
    }
    return tracker;
  }
}

type ChangeLogEntry = {
  stateVersion: string;
  schema: string;
  table: string;
  op: 't' | 's' | 'd';
  rowKey: postgres.JSONValue;
};

function table(db: postgres.Sql, msg: {relation: Pgoutput.MessageRelation}) {
  const {schema, name: table} = msg.relation;
  return db`${db(schema)}.${db(table)}`;
}

function rowChanges(
  tableTrackers: Iterable<TableTracker>,
): RowChange[] | undefined {
  const rowChanges: RowChange[] = [];

  for (const tracker of tableTrackers) {
    const {schema, table} = tracker;
    const {truncated, changes} = tracker.getEffectiveRowChanges();
    if (truncated) {
      rowChanges.push({schema, table});
    }
    for (const [_, change] of changes) {
      const {rowKey} = change;
      rowChanges.push({
        schema,
        table,
        rowKey: rowKey as Record<string, JSONValue>,
        rowData:
          change.postValue === 'none'
            ? undefined
            : (change.postValue as Record<string, JSONValue>),
      });
    }
  }
  return rowChanges;
}
