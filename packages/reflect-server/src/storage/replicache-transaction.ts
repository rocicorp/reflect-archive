import {
  isScanIndexOptions,
  JSONValue,
  makeScanResult,
  ScanNoIndexOptions,
  ScanOptions,
  WriteTransaction,
} from 'replicache';
import type {JSONType} from '../protocol/json.js';
import type {Patch} from '../protocol/poke.js';
import type {ClientID} from '../types/client-state.js';
import {
  UserValue,
  userValueKey,
  userValuePrefix,
  userValueSchema,
} from '../types/user-value.js';
import type {Version} from '../types/version.js';
import type {Storage} from './storage.js';

/**
 * Implements Replicache's WriteTransaction in terms of EntryCache.
 */
export class ReplicacheTransaction implements WriteTransaction {
  private _clientID: ClientID;
  private _storage: Storage;
  private _version: Version;

  get clientID(): string {
    return this._clientID;
  }

  constructor(storage: Storage, clientID: string, version: Version) {
    this._storage = storage;
    this._clientID = clientID;
    this._version = version;
  }

  async put(key: string, value: JSONValue): Promise<void> {
    const userValue: UserValue = {
      deleted: false,
      version: this._version,
      value: value as JSONType,
    };
    await this._storage.put(userValueKey(key), userValue);
  }

  async del(key: string): Promise<boolean> {
    const prev = await this.get(key);
    if (prev === undefined) {
      return false;
    }

    // Implement del with soft delete so we can detect deletes for diff.
    const userValue: UserValue = {
      deleted: true,
      version: this._version,
      value: prev as JSONType,
    };
    await this._storage.put(userValueKey(key), userValue);
    return prev !== undefined;
  }

  async get(key: string): Promise<JSONValue | undefined> {
    const entry = await this._storage.get(userValueKey(key), userValueSchema);
    if (entry === undefined) {
      return undefined;
    }
    return entry.deleted ? undefined : entry.value;
  }

  async has(key: string): Promise<boolean> {
    const val = await this.get(key);
    return val !== undefined;
  }

  async isEmpty(): Promise<boolean> {
    const sr = this.scan();
    const {done} = await sr.keys().next();
    return !!done;
  }

  scan(options: ScanOptions = {}) {
    if (isScanIndexOptions(options)) {
      throw new Error('not implemented');
    }

    return makeScanResult<ScanNoIndexOptions>(options, () =>
      this._list(options),
    );
  }

  private async *_list(options: ScanNoIndexOptions) {
    const {prefix, start} = options;

    const optsInternal = {
      ...options,
      // We cannot use the limit option because we soft-delete entries,
      // so we grab all entries and let makeScanResult() implement the limit.
      limit: undefined,
      prefix: userValueKey(prefix || ''),
      start: start && {key: userValueKey(start.key)}, // remove exclusive option, as makeScanResult will take care of it
    };

    const entriesMap = await this._storage.list(optsInternal, userValueSchema);

    for (const [k, v] of entriesMap) {
      if (!v.deleted) {
        const entry: [string, JSONValue] = [stripPrefix(k), v.value];
        yield entry;
      }
    }
  }
}

function stripPrefix(key: string) {
  return key.slice(userValuePrefix.length);
}

export function unwrapPatch(inner: Patch): Patch {
  return inner
    .filter(p => p.key.startsWith(userValuePrefix))
    .map(p => {
      const {key, op} = p;
      const unwrappedKey = stripPrefix(key);
      if (op === 'put') {
        const userValue = p.value as UserValue;
        if (userValue.deleted) {
          return {
            op: 'del',
            key: unwrappedKey,
          };
        }
        return {
          op: 'put',
          key: unwrappedKey,
          value: userValue.value,
        };
      }
      // We don't use del or clear at this layer
      throw new Error(`unexpected op: ${op}`);
    });
}