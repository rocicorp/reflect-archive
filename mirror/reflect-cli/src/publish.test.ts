import {
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  jest,
  test,
} from '@jest/globals';
import {doc, getFirestore, setDoc} from 'firebase/firestore';
import type {PublishRequest, publish} from 'mirror-protocol/src/publish.js';
import {deploymentViewDataConverter} from 'mirror-schema/src/external/deployment.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  DEFAULT_FROM_REFLECT_CONFIG,
  setAppConfigForTesting,
} from './app-config.js';
import {ErrorWrapper} from './error.js';
import {initFirebase} from './firebase.js';
import {teamAuthContext} from './login.test.helper.js';
import {publishHandler, type PublishCaller} from './publish.js';
import {reflectVersionMatcher, useFakeAuthConfig} from './test-helpers.js';

type Args = Parameters<typeof publishHandler>[0];

useFakeAuthConfig();

beforeAll(() => {
  initFirebase({stack: 'sandbox', local: true});
});

beforeEach(() => {
  // silence logs
  jest.spyOn(console, 'log').mockImplementation(jest.fn());
  jest.spyOn(console, 'error').mockImplementation(jest.fn());
});

afterEach(() => {
  setAppConfigForTesting(undefined);
  jest.restoreAllMocks();
});

async function writeTempFiles(
  data: string,
  filename = 'test.js',
  reflectVersion?: string,
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reflect-publish-test-'));
  const testFilePath = path.join(dir, filename);
  await fs.writeFile(testFilePath, data, 'utf-8');
  setAppConfigForTesting({
    apps: {default: {appID: 'test-app-id'}},
    server: testFilePath,
  });

  if (!reflectVersion) {
    const currentFile = fileURLToPath(import.meta.url);
    const reflectPackageJSONPath = path.join(
      path.dirname(currentFile), // src
      '..', // reflect-cli
      '..', // mirror
      '..', // mono
      'packages',
      'reflect',
      'package.json',
    );
    const s = await fs.readFile(reflectPackageJSONPath, 'utf-8');
    const reflectPackageJSON = JSON.parse(s);
    reflectVersion = '>=' + reflectPackageJSON.version;
  }

  const packageJSONFilePath = path.join(dir, 'package.json');
  await fs.writeFile(
    packageJSONFilePath,
    JSON.stringify({
      dependencies: {
        '@rocicorp/reflect': reflectVersion,
      },
    }),
    'utf-8',
  );

  return testFilePath;
}

test('it should throw warning if the source has syntax errors', async () => {
  const testFilePath = await writeTempFiles('const x =');
  await expect(
    publishHandler(
      {serverPath: testFilePath, app: 'abc123'} as Args,
      teamAuthContext,
    ),
  ).rejects.toEqual(
    expect.objectContaining({
      constructor: ErrorWrapper,
      message: expect.stringMatching(/Unexpected end of file/),
      severity: 'WARNING',
    }),
  );
});

test('it should throw if an invalid appname', async () => {
  const testFilePath = await writeTempFiles('const x = 42;', 'test.ts');
  await expect(
    publishHandler(
      {serverPath: testFilePath, app: '0000'} as Args,
      teamAuthContext,
    ),
  ).rejects.toThrow(
    /Invalid App Name "0000".*lowercased alphanumeric, starting with a letter and not ending with a hyphen./,
  );
});

test('it should throw warning if invalid version', async () => {
  const testFilePath = await writeTempFiles(
    'const x = 42;',
    'test.ts',
    '1.0.0',
  );
  await expect(
    publishHandler(
      {serverPath: testFilePath, app: 'abc123'} as Args,
      teamAuthContext,
    ),
  ).rejects.toEqual(
    expect.objectContaining({
      constructor: ErrorWrapper,
      message: expect.stringMatching(
        /^Unsupported version range "1.0.0" for "@rocicorp\/reflect" in /,
      ),
      severity: 'WARNING',
    }),
  );
});

async function testPublishedCode(source: string, expectedOutputs: string[]) {
  const publishMock = {
    call: jest
      .fn<typeof publish.call>()
      .mockImplementationOnce((body: PublishRequest) => {
        expect(body).toMatchObject({
          requester: {
            userAgent: {
              type: 'reflect-cli',
              version: reflectVersionMatcher,
            },
            userID: 'fake-uid',
          },
          source: {
            content: expect.any(String),
            name: 'test.js',
          },
          sourcemap: {content: expect.any(String), name: 'test.js.map'},
        });

        for (const expectedOutput of expectedOutputs) {
          expect(body.source.content).toContain(expectedOutput);
        }
        return Promise.resolve({
          success: true,
          deploymentPath: 'apps/foo/deployments/bar',
        });
      }),
  };

  const testFilePath = await writeTempFiles(source, 'test.ts');

  // Set the Deployment doc to RUNNING so that the cli command exits.
  const firestore = getFirestore();
  await setDoc(
    doc(firestore, 'apps/foo/deployments/bar').withConverter(
      deploymentViewDataConverter,
    ),
    {
      status: 'RUNNING',
      spec: {
        hostname: 'app-name.reflect-server-net',
        serverVersion: '0.1.0',
      },
    },
  );

  await publishHandler(
    {serverPath: testFilePath, app: DEFAULT_FROM_REFLECT_CONFIG} as Args,
    teamAuthContext,
    publishMock as unknown as PublishCaller,
    firestore,
  );

  expect(publishMock.call).toHaveBeenCalledTimes(1);
}

test('it should compile typescript', async () => {
  await testPublishedCode('const x: number = 42; console.log(x);', [
    `var x = 42;`,
  ]);
});

test('it should replace process.env', async () => {
  await testPublishedCode('console.log(process.env);', [
    `var define_process_env_default = {};`,
    `console.log(define_process_env_default);`,
  ]);
});

test('it should replace process.env.NODE_ENV', async () => {
  await testPublishedCode('console.log(process.env.NODE_ENV);', [
    `console.log("production");`,
  ]);
});

test('it should replace process.env.NODE_ENV again', async () => {
  await testPublishedCode(
    `console.log(process.env.NODE_ENV === "production")`,
    [`console.log(true);`],
  );
});

test('it should replace process.env.XYZ', async () => {
  await testPublishedCode('console.log(process.env.XYZ);', [
    `var define_process_env_default = {};`,
    `console.log(define_process_env_default.XYZ);`,
  ]);
});
