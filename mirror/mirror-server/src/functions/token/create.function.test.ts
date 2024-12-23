import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from '@jest/globals';
import {initializeApp} from 'firebase-admin/app';
import type {Auth} from 'firebase-admin/auth';
import {getFirestore} from 'firebase-admin/firestore';
import {https} from 'firebase-functions/v2';
import {HttpsError, type Request} from 'firebase-functions/v2/https';
import {apiKeyPath} from 'mirror-schema/src/api-key.js';
import {create} from './create.function.js';

describe('token-create', () => {
  // Note: The Firestore emulator returns an explanation-free UNKNOWN error if there are
  // capital letters in the projectId, so don't capitalize anything there.
  initializeApp({projectId: 'token-create-test'});
  const firestore = getFirestore();
  const TEAM_ID = 'token-team-id';
  const API_KEY_NAME = 'my-api-key';
  const API_KEY_VALUE = 'rHm_ELVQvsuj0GfZIF62A1BGUQE6NA8kZHwu8mF_UVo';

  const auth = {
    createCustomToken: jest
      .fn()
      .mockImplementation(() => Promise.resolve('custom-token')),
  };
  afterEach(() => {
    jest.clearAllMocks();
  });

  beforeAll(async () => {
    await Promise.all([
      firestore.doc(apiKeyPath(TEAM_ID, API_KEY_NAME)).create({
        value: API_KEY_VALUE,
      }),
    ]);
  });

  afterAll(async () => {
    // Clean up global emulator data.
    const batch = firestore.batch();
    batch.delete(firestore.doc(apiKeyPath(TEAM_ID, API_KEY_NAME)));
    await batch.commit();
  });

  function callCreate(key: string) {
    const createFunction = https.onCall(
      create(firestore, auth as unknown as Auth),
    );
    return createFunction.run({
      data: {key},
      rawRequest: null as unknown as Request,
    });
  }
  test('invalid key', async () => {
    const resp = await callCreate('not-a-valid-key-value').catch(e => e);
    expect(resp).toBeInstanceOf(HttpsError);
    expect((resp as HttpsError).code).toBe('permission-denied');
  });

  test('valid keys', async () => {
    const resp = await callCreate(API_KEY_VALUE);
    expect(resp).toEqual({
      success: true,
      token: 'custom-token',
    });
    expect(auth.createCustomToken).toBeCalledTimes(1);
    expect(auth.createCustomToken.mock.calls[0][0]).toBe(
      apiKeyPath(TEAM_ID, API_KEY_NAME),
    );
  });
});
