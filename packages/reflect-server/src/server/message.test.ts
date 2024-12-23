import {
  afterEach,
  beforeEach,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import type {ErrorKind} from 'reflect-protocol';
import {assert} from 'shared/src/asserts.js';
import {handleMessage} from '../../src/server/message.js';
import type {
  ClientGroupID,
  ClientID,
  ClientMap,
} from '../../src/types/client-state.js';
import {DurableStorage} from '../storage/durable-storage.js';
import type {PendingMutation} from '../types/mutation.js';
import {randomID} from '../util/rand.js';
import {Mocket, client, mutation, pendingMutation} from '../util/test-utils.js';
import {createSilentLogContext} from 'shared/src/logging-test-utils.js';

beforeEach(() => {
  jest.useFakeTimers();
  jest.setSystemTime(0);
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('handleMessage', () => {
  type Case = {
    name: string;
    data: string;
    clients?: ClientMap;
    clientID?: ClientID;
    clientGroupID?: ClientGroupID;
    expectedErrorKind?: ErrorKind;
    expectedErrorMessage?: string;
    expectedPendingMutations?: PendingMutation[];
    expectSocketClosed?: boolean;
  };

  const cases: Case[] = [
    {
      name: 'empty',
      data: '',
      expectedErrorKind: 'InvalidMessage',
      expectedErrorMessage: 'SyntaxError: Unexpected end of JSON input',
    },
    {
      name: 'invalid push',
      data: '[]',
      expectedErrorKind: 'InvalidMessage',
      expectedErrorMessage: 'TypeError: Invalid union value',
    },
    {
      name: 'valid push',
      data: JSON.stringify([
        'push',
        {
          clientGroupID: 'cg1',
          mutations: [mutation('c1', 1, 10), mutation('c1', 2, 20)],
          pushVersion: 1,
          schemaVersion: '',
          timestamp: 42,
          requestID: randomID(),
        },
      ]),
      expectedPendingMutations: [
        pendingMutation({
          clientID: 'c1',
          clientGroupID: 'cg1',
          id: 1,
          timestamps: {
            normalizedTimestamp: 10,
            originTimestamp: 10,
            serverReceivedTimestamp: 0,
          },
          auth: {userID: 'u1'},
        }),
        pendingMutation({
          clientID: 'c1',
          clientGroupID: 'cg1',
          id: 2,
          timestamps: {
            normalizedTimestamp: 20,
            originTimestamp: 20,
            serverReceivedTimestamp: 0,
          },
          auth: {userID: 'u1'},
        }),
      ],
    },
    {
      name: 'push missing requestID',
      data: JSON.stringify([
        'push',
        {
          clientID: 'c1',
          mutations: [mutation('c1', 1, 10), mutation('c1', 2, 20)],
          pushVersion: 1,
          schemaVersion: '',
          timestamp: 42,
        },
      ]),
      // This error message is not great
      expectedErrorKind: 'InvalidMessage',
      expectedErrorMessage: 'TypeError: Invalid union value',
    },
    {
      name: 'missing client push',
      data: JSON.stringify([
        'push',
        {
          clientGroupID: 'cg1',
          mutations: [mutation('c1', 1), mutation('c1', 2)],
          pushVersion: 1,
          schemaVersion: '',
          timestamp: 42,
          requestID: randomID(),
        },
      ]),
      clients: new Map(),
      clientID: 'c1',
      expectedErrorKind: 'ClientNotFound',
      expectedErrorMessage: 'c1',
      expectSocketClosed: true,
    },
    {
      name: 'missing client ping',
      data: JSON.stringify(['ping', {}]),
      clients: new Map(),
      clientID: 'c1',
      expectedErrorKind: 'ClientNotFound',
      expectedErrorMessage: 'c1',
      expectSocketClosed: true,
    },
  ];

  for (const c of cases) {
    test(c.name, async () => {
      const s1 = new Mocket();
      const clientID = c.clientID !== undefined ? c.clientID : 'c1';
      const clientGroupID =
        c.clientGroupID !== undefined ? c.clientGroupID : 'cg1';
      const clients: ClientMap =
        c.clients || new Map([client(clientID, 'u1', clientGroupID, s1, 0)]);

      const {roomDO} = getMiniflareBindings();
      const storage = new DurableStorage(
        await getMiniflareDurableObjectStorage(roomDO.newUniqueId()),
      );

      const pendingMutations: PendingMutation[] = [];
      await handleMessage(
        createSilentLogContext(),
        storage,
        clients,
        pendingMutations,
        clientID,
        c.data,
        s1,
        () => undefined,
      );

      if (c.expectSocketClosed) {
        expect(s1.log.length).toBeGreaterThan(0);
        expect(s1.log[s1.log.length - 1][0]).toEqual('close');
      }

      if (c.expectedErrorKind !== undefined) {
        expect(s1.log.length).toEqual(c.expectSocketClosed ? 2 : 1);

        expect(s1.log[0]).toEqual([
          'send',
          JSON.stringify([
            'error',
            c.expectedErrorKind,
            c.expectedErrorMessage,
          ]),
        ]);
        if (c.expectSocketClosed) {
          expect(s1.log[1]).toEqual(['close']);
        }
      }

      if (c.expectedPendingMutations) {
        const client = clients.get(clientID);
        assert(client);
        expect(pendingMutations).toEqual(c.expectedPendingMutations);
      }
    });
  }
});
