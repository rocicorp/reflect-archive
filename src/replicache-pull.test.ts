import {
  disableAllBackgroundProcesses,
  expectConsoleLogContextStub,
  initReplicacheTesting,
  makePullResponse,
  replicacheForTesting,
  requestIDLogContextRegex,
  tickAFewTimes,
  waitForSync,
} from './test-util.js';
import type {VersionNotSupportedResponse, WriteTransaction} from './mod.js';
import {expect} from '@esm-bundle/chai';
import {emptyHash, Hash} from './hash.js';
import * as sinon from 'sinon';

// fetch-mock has invalid d.ts file so we removed that on npm install.
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-expect-error
import fetchMock from 'fetch-mock/esm/client';
import {httpStatusUnauthorized, UpdateNeededReason} from './replicache.js';
import {defaultPuller, Puller, PullerDD31} from './puller.js';

initReplicacheTesting();

test('pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('pull', {
    auth: '1',
    pullURL,
    mutators: {
      createTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        createCount++;
        await tx.put(`/todo/${args.id}`, args);
      },
      deleteTodo: async <A extends {id: number}>(
        tx: WriteTransaction,
        args: A,
      ) => {
        deleteCount++;
        await tx.del(`/todo/${args.id}`);
      },
    },
    ...disableAllBackgroundProcesses,
  });

  let createCount = 0;
  let deleteCount = 0;
  let syncHead: Hash;
  let beginPullResult: {
    requestID: string;
    syncHead: Hash;
    ok: boolean;
  };

  const {createTodo, deleteTodo} = rep.mutate;

  const id1 = 14323534;
  const id2 = 22354345;

  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(2);
  const clientID = await rep.clientID;
  fetchMock.postOnce(
    pullURL,
    makePullResponse(clientID, 2, [
      {op: 'del', key: ''},
      {
        op: 'put',
        key: '/list/1',
        value: {id: 1, ownerUserID: 1},
      },
    ]),
  );
  rep.pull();
  await tickAFewTimes();
  expect(deleteCount).to.equal(2);

  fetchMock.postOnce(pullURL, makePullResponse(clientID, 2));
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).to.equal(emptyHash);
  expect(deleteCount).to.equal(2);

  await createTodo({
    id: id1,
    text: 'Test',
  });
  expect(createCount).to.equal(1);
  expect(
    ((await rep.query(tx => tx.get(`/todo/${id1}`))) as {text: string}).text,
  ).to.equal('Test');

  fetchMock.postOnce(
    pullURL,
    makePullResponse(clientID, 3, [
      {
        op: 'put',
        key: '/todo/14323534',
        value: {id: 14323534, text: 'Test'},
      },
    ]),
  );
  beginPullResult = await rep.beginPull();
  ({syncHead} = beginPullResult);
  expect(syncHead).to.not.be.undefined;
  expect(syncHead).to.not.equal(emptyHash);

  await createTodo({
    id: id2,
    text: 'Test 2',
  });
  expect(createCount).to.equal(2);
  expect(
    ((await rep.query(tx => tx.get(`/todo/${id2}`))) as {text: string}).text,
  ).to.equal('Test 2');

  fetchMock.postOnce(pullURL, makePullResponse(clientID, 3));
  await rep.maybeEndPull(syncHead, beginPullResult.requestID);

  expect(createCount).to.equal(3);

  // Clean up
  await deleteTodo({id: id1});
  await deleteTodo({id: id2});

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);

  fetchMock.postOnce(
    pullURL,
    makePullResponse(clientID, 6, [{op: 'del', key: '/todo/14323534'}], ''),
  );
  rep.pull();
  await tickAFewTimes();

  expect(deleteCount).to.equal(4);
  expect(createCount).to.equal(3);
});

test('reauth pull', async () => {
  const pullURL = 'https://diff.com/pull';

  const rep = await replicacheForTesting('reauth', {
    pullURL,
    auth: 'wrong',
  });

  fetchMock.post(pullURL, {body: 'xxx', status: httpStatusUnauthorized});

  const consoleErrorStub = sinon.stub(console, 'error');

  const getAuthFake = sinon.fake.returns(null);
  rep.getAuth = getAuthFake;

  await rep.beginPull();

  expect(getAuthFake.callCount).to.equal(1);
  expect(consoleErrorStub.callCount).to.equal(1);
  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.lastCall,
    'Got error response from server (https://diff.com/pull) doing pull: 401: xxx',
    ['pull', requestIDLogContextRegex],
  );
  {
    const consoleInfoStub = sinon.stub(console, 'info');
    const getAuthFake = sinon.fake(() => 'boo');
    rep.getAuth = getAuthFake;

    expect((await rep.beginPull()).syncHead).to.equal(emptyHash);

    expect(getAuthFake.callCount).to.equal(8);
    expect(consoleErrorStub.callCount).to.equal(9);
    expectConsoleLogContextStub(
      rep.name,
      consoleInfoStub.lastCall,
      'Tried to reauthenticate too many times',
      ['pull'],
    );
  }
});

test('pull request is only sent when pullURL or non-default puller are set', async () => {
  const rep = await replicacheForTesting(
    'no push requests',
    {
      auth: '1',
      pushURL: 'https://diff.com/push',
    },
    {useDefaultURLs: false},
  );

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  rep.pull();
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();
  fetchMock.reset();

  rep.pullURL = 'https://diff.com/pull';
  fetchMock.post(rep.pullURL, {lastMutationID: 0, patch: []});

  rep.pull();
  await tickAFewTimes();
  expect(fetchMock.calls()).to.have.length.greaterThan(0);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  rep.pullURL = '';

  rep.pull();
  await tickAFewTimes();
  expect(fetchMock.calls()).to.have.length(0);

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});

  let pullerCallCount = 0;

  const consoleErrorStub = sinon.stub(console, 'error');

  rep.puller = () => {
    pullerCallCount++;
    return Promise.resolve({
      httpRequestInfo: {
        httpStatusCode: 500,
        errorMessage: 'Test failure',
      },
    });
  };

  rep.pull();
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);
  expect(pullerCallCount).to.be.greaterThan(0);

  expectConsoleLogContextStub(
    rep.name,
    consoleErrorStub.firstCall,
    'Got error response from server () doing pull: 500: Test failure',
    ['pull', requestIDLogContextRegex],
  );
  consoleErrorStub.restore();

  await tickAFewTimes();
  fetchMock.reset();
  fetchMock.postAny({});
  pullerCallCount = 0;

  rep.puller = defaultPuller;

  rep.pull();
  await tickAFewTimes();

  expect(fetchMock.calls()).to.have.length(0);
  expect(pullerCallCount).to.equal(0);
});

test('Client Group not found on server', async () => {
  if (!DD31) {
    return;
  }

  const consoleErrorStub = sinon.stub(console, 'error');

  const rep = await replicacheForTesting('client-group-not-found-pull', {
    ...disableAllBackgroundProcesses,
  });

  // eslint-disable-next-line require-await
  const puller: PullerDD31 = async () => {
    return {
      response: {error: 'ClientStateNotFound'},
      httpRequestInfo: {
        httpStatusCode: 200,
        errorMessage: '',
      },
    };
  };

  expect(rep.isClientGroupDisabled).false;

  rep.puller = puller as Puller;
  rep.pull();

  await waitForSync(rep);

  expect(rep.isClientGroupDisabled).true;

  expect(consoleErrorStub.callCount).to.equal(1);
  expect(consoleErrorStub.lastCall.args).to.have.length(2);
  const err = consoleErrorStub.lastCall.args[1];
  expect(err).to.be.an.instanceOf(Error);
  expect(err.message).to.match(/Client group (\S)+ is unknown on server/);
});

test('Version not supported on server', async () => {
  const t = async (
    response: VersionNotSupportedResponse,
    reason: UpdateNeededReason,
  ) => {
    const rep = await replicacheForTesting('version-not-supported-pull', {
      ...disableAllBackgroundProcesses,
    });

    const onUpdateNeededStub = (rep.onUpdateNeeded = sinon.stub());

    // eslint-disable-next-line require-await
    const puller: PullerDD31 = async () => {
      return {
        response,
        httpRequestInfo: {
          httpStatusCode: 200,
          errorMessage: '',
        },
      };
    };

    rep.puller = puller as Puller;
    rep.pull();

    await waitForSync(rep);

    expect(onUpdateNeededStub.callCount).to.equal(1);
    expect(onUpdateNeededStub.lastCall.args).deep.equal([reason]);
  };

  await t({error: 'VersionNotSupported'}, {type: 'VersionNotSupported'});
  await t(
    {error: 'VersionNotSupported', versionType: 'pull'},
    {type: 'VersionNotSupported', versionType: 'pull'},
  );
  await t(
    {error: 'VersionNotSupported', versionType: 'schema'},
    {type: 'VersionNotSupported', versionType: 'schema'},
  );
});