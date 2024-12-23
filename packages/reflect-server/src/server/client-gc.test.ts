import {describe, expect, jest, test} from '@jest/globals';
import type {Env} from 'reflect-shared/src/types.js';
import {jsonSchema} from 'shared/src/json-schema.js';
import {createSilentLogContext} from 'shared/src/logging-test-utils.js';
import {DurableStorage} from '../storage/durable-storage.js';
import {EntryCache} from '../storage/entry-cache.js';
import type {Storage} from '../storage/storage.js';
import {
  ClientRecord,
  IncludeDeleted,
  getClientRecord,
  putClientRecord,
} from '../types/client-record.js';
import type {ClientID} from '../types/client-state.js';
import {putConnectedClients} from '../types/connected-clients.js';
import {getUserValue, putUserValue} from '../types/user-value.js';
import {putVersion} from '../types/version.js';
import {setUserEntries} from '../util/test-utils.js';
import type {ClientDeleteHandler} from './client-delete-handler.js';
import {
  collectClientIfDeleted,
  collectClients,
  collectOldUserSpaceClientKeys,
  updateLastSeen,
} from './client-gc.js';

const {roomDO} = getMiniflareBindings();
const id = roomDO.newUniqueId();

async function setLastSeenEntries(
  cache: Storage,
  entries: Record<ClientID, number | undefined>,
) {
  for (const [clientID, v] of Object.entries(entries)) {
    await putClientRecord(
      clientID,
      {
        ...(v === undefined ? {} : {lastSeen: v}),
        baseCookie: 1,
        clientGroupID: 'client-group-id',
        lastMutationID: 2,
        lastMutationIDVersion: 3,
        userID: 'u1',
      },
      cache,
    );
  }
}

describe('collectOldUserSpaceClientKeys', () => {
  test('normal operations', async () => {
    const lc = createSilentLogContext();

    const durable = await getMiniflareDurableObjectStorage(id);
    await durable.deleteAll();
    const storage = new DurableStorage(durable);
    const cache = new EntryCache(storage);
    const version = 1;

    //  This test does not care about the lastSeen or the version
    await setUserEntries(cache, version, {
      '-/p/client-a': 1,
      '-/p/client-a/': 2,
      '-/p/client-a/more': 3,
      '-/p/client-b': 4,
      '-/p/client-b/': 5,
      '-/p/client-b/more': 6,
      '-/p/client-c': 7,
      '-/p/client-c/': 8,
      '-/p/client-c/more': 9,
      '-/p/client-d': 10,
      '-/p/client-d/': 11,
      '-/p/client-d/more': 12,
    });
    await cache.flush();

    const clientsToCollect = ['client-a', 'client-c'];
    await collectOldUserSpaceClientKeys(
      lc,
      cache,
      clientsToCollect,
      version + 1,
    );
    await cache.flush();

    const allEntries = await storage.list({}, jsonSchema);
    expect(allEntries).toMatchInlineSnapshot(`
Map {
  "user/-/p/client-a" => {
    "deleted": true,
    "value": 1,
    "version": 2,
  },
  "user/-/p/client-a/" => {
    "deleted": true,
    "value": 2,
    "version": 2,
  },
  "user/-/p/client-a/more" => {
    "deleted": true,
    "value": 3,
    "version": 2,
  },
  "user/-/p/client-b" => {
    "deleted": false,
    "value": 4,
    "version": 1,
  },
  "user/-/p/client-b/" => {
    "deleted": false,
    "value": 5,
    "version": 1,
  },
  "user/-/p/client-b/more" => {
    "deleted": false,
    "value": 6,
    "version": 1,
  },
  "user/-/p/client-c" => {
    "deleted": true,
    "value": 7,
    "version": 2,
  },
  "user/-/p/client-c/" => {
    "deleted": true,
    "value": 8,
    "version": 2,
  },
  "user/-/p/client-c/more" => {
    "deleted": true,
    "value": 9,
    "version": 2,
  },
  "user/-/p/client-d" => {
    "deleted": false,
    "value": 10,
    "version": 1,
  },
  "user/-/p/client-d/" => {
    "deleted": false,
    "value": 11,
    "version": 1,
  },
  "user/-/p/client-d/more" => {
    "deleted": false,
    "value": 12,
    "version": 1,
  },
}
`);
  });

  test('double delete', async () => {
    const lc = createSilentLogContext();

    const durable = await getMiniflareDurableObjectStorage(id);
    await durable.deleteAll();
    const storage = new DurableStorage(durable);
    const cache = new EntryCache(storage);
    const version = 2;

    //  This test does not care about the lastSeen or the version
    await setUserEntries(cache, version, {
      '-/p/client-a': 1,
      '-/p/client-b': 2,
      '-/p/client-c': 3,
    });
    await putUserValue(
      '-/p/client-a',
      {
        deleted: true,
        value: 1,
        version,
      },
      cache,
    );
    await cache.flush();
    {
      const allEntries = await storage.list({}, jsonSchema);
      expect(allEntries).toMatchInlineSnapshot(`
Map {
  "user/-/p/client-a" => {
    "deleted": true,
    "value": 1,
    "version": 2,
  },
  "user/-/p/client-b" => {
    "deleted": false,
    "value": 2,
    "version": 2,
  },
  "user/-/p/client-c" => {
    "deleted": false,
    "value": 3,
    "version": 2,
  },
}
`);
    }

    const clientsToCollect = ['client-a', 'client-c'];
    await collectOldUserSpaceClientKeys(
      lc,
      cache,
      clientsToCollect,
      version + 1,
    );
    await cache.flush();

    const allEntries = await storage.list({}, jsonSchema);
    expect(allEntries).toMatchInlineSnapshot(`
Map {
  "user/-/p/client-a" => {
    "deleted": true,
    "value": 1,
    "version": 2,
  },
  "user/-/p/client-b" => {
    "deleted": false,
    "value": 2,
    "version": 2,
  },
  "user/-/p/client-c" => {
    "deleted": true,
    "value": 3,
    "version": 3,
  },
}
`);
  });
});

describe('collectClients', () => {
  test('empty storage', async () => {
    const lc = createSilentLogContext();
    const env = {a: 'b'};
    const durable = await getMiniflareDurableObjectStorage(id);
    await durable.deleteAll();
    const storage = new DurableStorage(durable);
    const connectedClients: Set<string> = new Set();
    const now = 123;
    const maxAge = 456;
    const version = 789;
    const clientDeleteHandler = jest
      .fn<ClientDeleteHandler>()
      .mockRejectedValue('should not be called');

    await putVersion(version, storage);

    await collectClients(
      lc,
      env,
      storage,
      clientDeleteHandler,
      connectedClients,
      now,
      maxAge,
      version + 1,
    );

    expect(await storage.list({}, jsonSchema)).toMatchInlineSnapshot(`
Map {
  "version" => 789,
}
`);
    expect(clientDeleteHandler).not.toHaveBeenCalled();
  });

  test('normal operation', async () => {
    const lc = createSilentLogContext();
    const env = {a: 'b'};
    const durable = await getMiniflareDurableObjectStorage(id);
    await durable.deleteAll();
    const storage = new DurableStorage(durable);
    const version = 1;
    const now = 4500;
    const maxAge = 2000;
    const connectedClients = new Set(['client-a', 'client-c']);
    const clientDeleteHandler = jest
      .fn<ClientDeleteHandler>()
      .mockResolvedValue(undefined);

    await putVersion(version, storage);
    await setUserEntries(storage, version, {
      '-/p/client-a': 1,
      '-/p/client-a/more': 2,
      '-/p/client-b': 3,
      '-/p/client-b/more': 4,
      '-/p/client-c': 5,
      '-/p/client-c/more': 6,
      '-/p/client-d': 7,
      '-/p/client-d/more': 8,
    });
    await setLastSeenEntries(storage, {
      'client-a': 1000,
      'client-b': 2000,
      'client-c': 3000,
      'client-d': 4000,
    });
    await putConnectedClients(connectedClients, storage);
    await storage.flush();

    await collectClients(
      lc,
      env,
      storage,
      clientDeleteHandler,
      connectedClients,
      now,
      maxAge,
      version + 1,
    );
    await storage.flush();

    expect(clientDeleteHandler).toHaveBeenCalledTimes(1);
    expect(clientDeleteHandler).toHaveBeenCalledWith(
      expect.objectContaining({clientID: 'client-b'}),
    );

    expect(await storage.list({}, jsonSchema)).toMatchInlineSnapshot(`
Map {
  "clientV1/client-a" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 1000,
    "userID": "u1",
  },
  "clientV1/client-b" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "deleted": true,
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 2000,
    "userID": "u1",
  },
  "clientV1/client-c" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 3000,
    "userID": "u1",
  },
  "clientV1/client-d" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 4000,
    "userID": "u1",
  },
  "connectedclients" => [
    "client-a",
    "client-c",
  ],
  "user/-/p/client-a" => {
    "deleted": false,
    "value": 1,
    "version": 1,
  },
  "user/-/p/client-a/more" => {
    "deleted": false,
    "value": 2,
    "version": 1,
  },
  "user/-/p/client-b" => {
    "deleted": true,
    "value": 3,
    "version": 2,
  },
  "user/-/p/client-b/more" => {
    "deleted": true,
    "value": 4,
    "version": 2,
  },
  "user/-/p/client-c" => {
    "deleted": false,
    "value": 5,
    "version": 1,
  },
  "user/-/p/client-c/more" => {
    "deleted": false,
    "value": 6,
    "version": 1,
  },
  "user/-/p/client-d" => {
    "deleted": false,
    "value": 7,
    "version": 1,
  },
  "user/-/p/client-d/more" => {
    "deleted": false,
    "value": 8,
    "version": 1,
  },
  "version" => 2,
}
`);
  });

  test('no client key space used', async () => {
    const lc = createSilentLogContext();
    const env = {a: 'b'};
    const durable = await getMiniflareDurableObjectStorage(id);
    await durable.deleteAll();
    const storage = new DurableStorage(durable);
    const version = 1;
    const now = 4500;
    const maxAge = 2000;
    const connectedClients = new Set(['client-a', 'client-c']);
    const clientDeleteHandler = jest
      .fn<ClientDeleteHandler>()
      .mockResolvedValue(undefined);

    await putVersion(version, storage);
    await setLastSeenEntries(storage, {
      'client-a': 1000,
      'client-b': 2000,
      'client-c': 3000,
      'client-d': 4000,
    });
    await putConnectedClients(connectedClients, storage);
    await storage.flush();

    await collectClients(
      lc,
      env,
      storage,
      clientDeleteHandler,
      connectedClients,
      now,
      maxAge,
      version + 1,
    );

    expect(clientDeleteHandler).toHaveBeenCalledTimes(1);
    expect(clientDeleteHandler).toHaveBeenCalledWith(
      expect.objectContaining({clientID: 'client-b'}),
    );

    expect(await storage.list({}, jsonSchema)).toMatchInlineSnapshot(`
Map {
  "clientV1/client-a" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 1000,
    "userID": "u1",
  },
  "clientV1/client-b" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "deleted": true,
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 2000,
    "userID": "u1",
  },
  "clientV1/client-c" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 3000,
    "userID": "u1",
  },
  "clientV1/client-d" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 4000,
    "userID": "u1",
  },
  "connectedclients" => [
    "client-a",
    "client-c",
  ],
  "version" => 2,
}
`);
  });

  test('client record missing lastSeen', async () => {
    const lc = createSilentLogContext();
    const env: Env = {a: 'b'};
    const durable = await getMiniflareDurableObjectStorage(id);
    await durable.deleteAll();
    const storage = new DurableStorage(durable);
    const version = 1;
    const now = 4500;
    const maxAge = 2000;
    const connectedClients = new Set(['client-a', 'client-c']);
    const clientDeleteHandler = jest
      .fn<ClientDeleteHandler>()
      .mockRejectedValue('should not be called');

    await putVersion(version, storage);
    await setLastSeenEntries(storage, {
      'client-a': 1000,
      'client-b': undefined,
      'client-c': 3000,
      'client-d': 1500, // different from previous test, so it gets collected
    });
    await setUserEntries(storage, version, {
      '-/p/client-a': 1,
      '-/p/client-a/more': 2,
      '-/p/client-b': 3,
      '-/p/client-b/more': 4,
      '-/p/client-c': 5,
      '-/p/client-c/more': 6,
      '-/p/client-d': 7,
      '-/p/client-d/more': 8,
    });
    await putConnectedClients(connectedClients, storage);
    await storage.flush();

    // no lastSeen
    expect(
      await getClientRecord('client-b', IncludeDeleted.Include, storage),
    ).toEqual({
      baseCookie: 1,
      clientGroupID: 'client-group-id',
      lastMutationID: 2,
      lastMutationIDVersion: 3,
      userID: 'u1',
    });

    // client-b does not get deleted because it has no lastSeen so it just now
    // gets a lastSeen value.
    await collectClients(
      lc,
      env,
      storage,
      clientDeleteHandler,
      connectedClients,
      now,
      maxAge,
      version + 1,
    );
    await storage.flush();

    // client-b gets a lastSeen of now
    expect(await storage.list({}, jsonSchema)).toMatchInlineSnapshot(`
Map {
  "clientV1/client-a" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 1000,
    "userID": "u1",
  },
  "clientV1/client-b" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 4500,
    "userID": "u1",
  },
  "clientV1/client-c" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 3000,
    "userID": "u1",
  },
  "clientV1/client-d" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "deleted": true,
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 1500,
    "userID": "u1",
  },
  "connectedclients" => [
    "client-a",
    "client-c",
  ],
  "user/-/p/client-a" => {
    "deleted": false,
    "value": 1,
    "version": 1,
  },
  "user/-/p/client-a/more" => {
    "deleted": false,
    "value": 2,
    "version": 1,
  },
  "user/-/p/client-b" => {
    "deleted": false,
    "value": 3,
    "version": 1,
  },
  "user/-/p/client-b/more" => {
    "deleted": false,
    "value": 4,
    "version": 1,
  },
  "user/-/p/client-c" => {
    "deleted": false,
    "value": 5,
    "version": 1,
  },
  "user/-/p/client-c/more" => {
    "deleted": false,
    "value": 6,
    "version": 1,
  },
  "user/-/p/client-d" => {
    "deleted": true,
    "value": 7,
    "version": 2,
  },
  "user/-/p/client-d/more" => {
    "deleted": true,
    "value": 8,
    "version": 2,
  },
  "version" => 2,
}
`);
  });
});

test('touchClients', async () => {
  const durable = await getMiniflareDurableObjectStorage(id);
  await durable.deleteAll();
  const storage = new DurableStorage(durable);
  const landed = 1969;
  const lc = createSilentLogContext();

  for (const c of 'abcd') {
    await putClientRecord(
      `client-${c}`,
      {
        baseCookie: 1,
        clientGroupID: 'client-group-id',
        lastMutationID: 2,
        lastMutationIDVersion: 3,
        userID: 'u1',
      },
      storage,
    );
  }

  await updateLastSeen(
    lc,
    new Set(['client-a', 'client-b']),
    new Set(['client-b', 'client-c']),
    storage,
    landed,
  );
  await storage.flush();

  expect(await storage.list({}, jsonSchema)).toMatchInlineSnapshot(`
Map {
  "clientV1/client-a" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "lastSeen": 1969,
    "userID": "u1",
  },
  "clientV1/client-b" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "userID": "u1",
  },
  "clientV1/client-c" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "userID": "u1",
  },
  "clientV1/client-d" => {
    "baseCookie": 1,
    "clientGroupID": "client-group-id",
    "lastMutationID": 2,
    "lastMutationIDVersion": 3,
    "userID": "u1",
  },
}
`);
});

describe('collectClientIfDeleted', () => {
  const lc = createSilentLogContext();

  type Case = {
    name: string;
    lastMutationID: number;
    lastMutationIDAtClose: number;
    expectDeleted: boolean;
    deleted?: boolean | undefined;
  };

  const cases: Case[] = [
    {
      name: 'client not deleted because it has pending mutations',
      lastMutationID: 1,
      lastMutationIDAtClose: 2,
      expectDeleted: false,
    },
    {
      name: 'client  deleted because it no pending mutations',
      lastMutationID: 2,
      lastMutationIDAtClose: 2,
      expectDeleted: true,
    },
    {
      name: 'client  deleted because it finished processing extra mutations',
      lastMutationID: 3,
      lastMutationIDAtClose: 2,
      expectDeleted: true,
    },
    {
      name: 'client record already deleted',
      lastMutationID: 3,
      lastMutationIDAtClose: 2,
      expectDeleted: true,
      deleted: true,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const {
        expectDeleted,
        lastMutationID,
        lastMutationIDAtClose,
        deleted = false,
      } = c;

      const durable = await getMiniflareDurableObjectStorage(id);
      await durable.deleteAll();
      const storage = new DurableStorage(durable);
      const cache = new EntryCache(storage);
      const version = 1;
      const clientID = 'client-a';
      const clientGroupID = 'client-group-id';
      const env: Env = {a: 'b'};
      const clientDeleteHandler: ClientDeleteHandler = jest
        .fn<ClientDeleteHandler>()
        .mockReturnValue(Promise.resolve());
      const userID = 'user-id-xyz';

      // Set a presence state key value
      const keyToTest = `-/p/${clientID}/test`;
      await setUserEntries(cache, version, {
        [keyToTest]: 1,
      });

      const clientRecord: ClientRecord = {
        baseCookie: 1,
        clientGroupID,
        lastMutationID,
        lastMutationIDVersion: null,
        lastSeen: 4,
        lastMutationIDAtClose,
        userID,
        deleted,
      };

      await putClientRecord(clientID, clientRecord, cache);

      await collectClientIfDeleted(
        lc,
        env,
        clientID,
        clientDeleteHandler,
        cache,
        version,
      );

      const testEntry = await getUserValue(keyToTest, cache);
      expect(testEntry?.deleted).toBe(expectDeleted);

      expect(clientDeleteHandler).toHaveBeenCalledTimes(
        expectDeleted && !deleted ? 1 : 0,
      );
    });
  }
});
