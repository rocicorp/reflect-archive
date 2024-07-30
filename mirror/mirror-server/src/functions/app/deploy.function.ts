import {Errors, FetchResultError} from 'cloudflare-api/src/fetch.js';
import {
  FieldValue,
  Precondition,
  Timestamp,
  type Firestore,
  type UpdateData,
} from 'firebase-admin/firestore';
import type {Storage} from 'firebase-admin/storage';
import {logger} from 'firebase-functions';
import {onDocumentCreated} from 'firebase-functions/v2/firestore';
import {HttpsError} from 'firebase-functions/v2/https';
import type {App, ScriptRef} from 'mirror-schema/src/app.js';
import {appDataConverter, appPath} from 'mirror-schema/src/app.js';
import {
  Deployment,
  DeploymentStatus,
  DeploymentType,
  deploymentDataConverter,
  deploymentPath,
} from 'mirror-schema/src/deployment.js';
import {DEFAULT_ENV, envDataConverter, envPath} from 'mirror-schema/src/env.js';
import {
  providerDataConverter,
  providerPath,
} from 'mirror-schema/src/provider.js';
import type {Timestamp as SchemaTimestamp} from 'mirror-schema/src/timestamp.js';
import {watch} from 'mirror-schema/src/watch.js';
import {coerce, lt} from 'semver';
import {must} from 'shared/src/must.js';
import {getServerModuleMetadata} from '../../cloudflare/get-server-modules.js';
import {
  GlobalScriptHandler,
  NamespacedScriptHandler,
  ScriptHandler,
} from '../../cloudflare/script-handler.js';
import {newDeploymentID} from '../../ids.js';
import {
  SecretsCache,
  SecretsClient,
  apiTokenName,
} from '../../secrets/index.js';
import {getDataOrFail} from '../validators/data.js';
import {MIN_WFP_VERSION} from './create.function.js';
import {deleteAppDocs} from './delete.function.js';
import {DEPLOYMENT_SECRETS_NAMES, getAllDeploymentSecrets} from './secrets.js';

export const deploy = (
  firestore: Firestore,
  storage: Storage,
  secrets: SecretsClient,
) =>
  onDocumentCreated(
    {
      document: 'apps/{appID}/deployments/{deploymentID}',
      secrets: [...DEPLOYMENT_SECRETS_NAMES],
    },
    async event => {
      const {appID, deploymentID} = event.params;

      await earlierDeployments(firestore, appID, deploymentID);
      await runDeployment(firestore, storage, secrets, appID, deploymentID);
    },
  );

export async function runDeployment(
  firestore: Firestore,
  storage: Storage,
  secretsClient: SecretsClient,
  appID: string,
  deploymentID: string,
  testScriptHandler?: ScriptHandler, // Overridden in tests.
): Promise<void> {
  const secrets = new SecretsCache(secretsClient);
  const [appDoc, envDoc, deploymentDoc] = await firestore.runTransaction(
    tx =>
      Promise.all([
        tx.get(firestore.doc(appPath(appID)).withConverter(appDataConverter)),
        tx.get(
          firestore
            .doc(envPath(appID, DEFAULT_ENV))
            .withConverter(envDataConverter),
        ),
        tx.get(
          firestore
            .doc(deploymentPath(appID, deploymentID))
            .withConverter(deploymentDataConverter),
        ),
      ]),
    {readOnly: true},
  );
  if (!appDoc.exists) {
    throw new HttpsError('not-found', `Missing app doc for ${appID}`);
  }
  if (!envDoc.exists) {
    throw new HttpsError('not-found', `Missing environment doc for ${appID}`);
  }
  if (!deploymentDoc.exists) {
    throw new HttpsError(
      'not-found',
      `Missing deployment doc ${deploymentID} for app ${appID}`,
    );
  }

  const {
    provider,
    cfScriptName,
    scriptRef,
    name: appName,
    teamID,
    teamLabel,
  } = must(appDoc.data());
  const {deploymentOptions, secrets: encryptedSecrets} = must(envDoc.data());
  const envUpdateTime = must(envDoc.updateTime);
  const {
    type: deploymentType,
    status,
    spec: {serverVersion, hostname, appModules},
  } = must(deploymentDoc.data());

  try {
    const [apiToken, providerDoc] = await Promise.all([
      secrets.getSecretPayload(apiTokenName(provider)),
      firestore
        .doc(providerPath(provider))
        .withConverter(providerDataConverter)
        .get(),
    ]);
    const {accountID, defaultZone, dispatchNamespace} = getDataOrFail(
      providerDoc,
      'internal',
      `Unknown provider ${provider} for App ${appID}`,
    );
    const account = {apiToken, accountID};
    const zone = {apiToken, ...defaultZone};

    if (status !== 'REQUESTED') {
      logger.warn(`Deployment is already ${status}`);
      return;
    }
    const lastUpdateTime = must(deploymentDoc.updateTime);
    await setDeploymentStatus(
      firestore,
      appID,
      deploymentID,
      'DEPLOYING',
      undefined,
      {lastUpdateTime}, // Aborts if another trigger is already executing the same deployment.
    );

    const script = testScriptHandler
      ? testScriptHandler
      : scriptRef
        ? new NamespacedScriptHandler(account, zone, scriptRef)
        : new GlobalScriptHandler(account, zone, cfScriptName);

    if (deploymentType === 'DELETE') {
      // For a DELETE, the Deployment lifecycle is 'REQUESTED' -> 'DEPLOYING' -> (document deleted) | 'FAILED'
      await script.delete();
      await deleteAppDocs(firestore, appID);
      logger.info(`Deleted app ${appID}`);
      return;
    }

    // For all other deployments, the lifecycle is 'REQUESTED' -> 'DEPLOYING' -> 'RUNNING' | 'FAILED'
    const {modules: serverModules} = await getServerModuleMetadata(
      firestore,
      serverVersion,
    );

    const appSecrets = await getAllDeploymentSecrets(secrets, encryptedSecrets);

    const newScriptRef = (await migrateToWFP(
      firestore,
      appID,
      deploymentID,
      scriptRef,
      script,
      serverVersion,
    ))
      ? {
          name: cfScriptName,
          namespace: dispatchNamespace,
        }
      : undefined;
    const publisher =
      newScriptRef && script instanceof GlobalScriptHandler // Note: Leaves testScriptHandler as is.
        ? new NamespacedScriptHandler(account, zone, newScriptRef)
        : script;

    for await (const deploymentUpdate of publisher.publish(
      storage,
      {id: appID, name: appName},
      {id: teamID, label: teamLabel},
      hostname,
      deploymentOptions,
      appSecrets,
      appModules,
      serverModules,
    )) {
      await setDeploymentStatus(
        firestore,
        appID,
        deploymentID,
        'DEPLOYING',
        deploymentUpdate,
      );
    }
    await setRunningDeployment(
      firestore,
      appID,
      deploymentID,
      envUpdateTime,
      newScriptRef,
    );
  } catch (e) {
    const {message, severity} = deploymentErrorMessage(deploymentType, e);
    await setDeploymentStatus(
      firestore,
      appID,
      deploymentID,
      'FAILED',
      message,
    );
    if (severity === 'WARNING') {
      logger.warn(e); // Log warnings but do not throw/report as an error.
    } else {
      throw e;
    }
  }
}

const userActionableErrorCodes = new Set([
  Errors.ScriptContentFailedValidationChecks,
  Errors.ScriptBodyWasTooLarge,
]);

function deploymentErrorMessage(
  deploymentType: DeploymentType,
  e: unknown,
): {message: string; severity: 'WARNING' | 'ERROR'} {
  let message = `There was an error ${
    deploymentType === 'DELETE' ? 'deleting' : 'deploying'
  } the app`;
  if (e instanceof FetchResultError) {
    if (userActionableErrorCodes.has(e.code)) {
      return {message: e.messages().join('\n'), severity: 'WARNING'};
    }
    message += ` (error code ${e.code})`;
  } else if (e instanceof HttpsError) {
    message += `: ${e.message}`;
  }
  return {message, severity: 'ERROR'};
}

export async function requestDeployment(
  firestore: Firestore,
  appID: string,
  data: Pick<Deployment, 'requesterID' | 'type' | 'spec'>,
  newServerReleaseChannel?: string,
  lastAppUpdateTime?: Timestamp,
): Promise<string> {
  const appDocRef = firestore
    .doc(appPath(appID))
    .withConverter(appDataConverter);
  logger.debug(`Requesting ${data.type} for ${appID}`, data);
  const path = await firestore.runTransaction(async tx => {
    for (let i = 0; i < 5; i++) {
      const deploymentID = newDeploymentID();
      const docRef = firestore
        .doc(deploymentPath(appID, deploymentID))
        .withConverter(deploymentDataConverter);
      const doc = await tx.get(docRef);
      if (doc.exists) {
        logger.warn(`Deployment ${deploymentID} already exists. Trying again.`);
        continue;
      }
      const deployment: Deployment = {
        ...data,
        deploymentID,
        status: 'REQUESTED',
        requestTime: FieldValue.serverTimestamp() as Timestamp,
      };
      logger.debug(`Creating Deployment ${deploymentID}`, deployment);

      const appUpdate: UpdateData<App> = {
        queuedDeploymentIDs: FieldValue.arrayUnion(deploymentID),
        forceRedeployment: FieldValue.delete(),
      };
      if (newServerReleaseChannel) {
        appUpdate.serverReleaseChannel = newServerReleaseChannel;
      }

      tx.create(docRef, deployment);
      tx.update(
        appDocRef,
        appUpdate,
        lastAppUpdateTime ? {lastUpdateTime: lastAppUpdateTime} : {},
      );
      return docRef.path;
    }
    throw new HttpsError(
      'resource-exhausted',
      'Failed to generate unused deployment ID',
    );
  });
  logger.info(`Requested ${path}`);
  return path;
}

const DEPLOYMENT_FAILURE_TIMEOUT_MS = 1000 * 60; // 1 minute.

export async function earlierDeployments(
  firestore: Firestore,
  appID: string,
  deploymentID: string,
  setTimeoutFn = setTimeout,
): Promise<void> {
  const appDoc = firestore.doc(appPath(appID)).withConverter(appDataConverter);
  let failureTimeout;

  for await (const appSnapshot of watch(appDoc)) {
    clearTimeout(failureTimeout);

    if (!appSnapshot.exists) {
      throw new HttpsError('not-found', `App ${appID} has been deleted.`);
    }
    const app = must(appSnapshot.data());
    if (!app.queuedDeploymentIDs?.length) {
      throw new HttpsError(
        'aborted',
        `Deployment ${deploymentID} is no longer queued.`,
      );
    }
    const nextDeploymentID = app.queuedDeploymentIDs[0];
    if (nextDeploymentID === deploymentID) {
      return; // Common case: the deployment is next in line.
    }
    logger.info(
      `Waiting for deployments ahead of ${deploymentID}: ${app.queuedDeploymentIDs}`,
    );

    const deploymentDoc = await firestore
      .doc(deploymentPath(appID, nextDeploymentID))
      .withConverter(deploymentDataConverter)
      .get();
    const deployment = must(deploymentDoc.data());
    const lastUpdateTime = must(deploymentDoc.updateTime);
    const lastActionTime = deployment.deployTime ?? deployment.requestTime;
    failureTimeout = setTimeoutFn(
      async () => {
        await setDeploymentStatus(
          firestore,
          appID,
          nextDeploymentID,
          'FAILED',
          'Deployment timed out',
          {lastUpdateTime},
        );
        logger.warn(`Set ${nextDeploymentID} to FAILED after timeout`);
      },
      lastActionTime.toMillis() + DEPLOYMENT_FAILURE_TIMEOUT_MS - Date.now(),
    );
  }
}

function deploymentUpdate(
  status: Exclude<DeploymentStatus, 'REQUESTED'>,
  statusMessage?: string,
): Partial<Deployment> {
  const update: Partial<Deployment> = {
    status,
    statusMessage: statusMessage ?? '',
  };
  switch (status) {
    case 'DEPLOYING':
      update.deployTime = Timestamp.now();
      break;
    case 'RUNNING':
      update.startTime = Timestamp.now();
      break;
    case 'STOPPED':
    case 'FAILED':
      update.stopTime = Timestamp.now();
      break;
  }
  return update;
}

async function setDeploymentStatus(
  firestore: Firestore,
  appID: string,
  deploymentID: string,
  status: 'DEPLOYING' | 'FAILED',
  statusMessage?: string,
  precondition: Precondition = {},
): Promise<void> {
  const batch = firestore.batch();
  batch.update(
    firestore
      .doc(deploymentPath(appID, deploymentID))
      .withConverter(deploymentDataConverter),
    deploymentUpdate(status, statusMessage),
    precondition,
  );
  if (status !== 'DEPLOYING') {
    batch.update(
      firestore.doc(appPath(appID)).withConverter(appDataConverter),
      {queuedDeploymentIDs: FieldValue.arrayRemove(deploymentID)},
    );
  }
  await batch.commit();
}

/**
 * Updates the collection of deployments so that the specified one
 * is `RUNNING`, setting the previously `RUNNING` deployment to `STOPPED`.
 */
async function setRunningDeployment(
  firestore: Firestore,
  appID: string,
  newDeploymentID: string,
  envUpdateTime: SchemaTimestamp,
  newScriptRef: ScriptRef | undefined,
): Promise<void> {
  const appDocRef = firestore
    .doc(appPath(appID))
    .withConverter(appDataConverter);
  const newDeploymentDocRef = firestore
    .doc(deploymentPath(appID, newDeploymentID))
    .withConverter(deploymentDataConverter);

  await firestore.runTransaction(async tx => {
    const [appDoc, newDeploymentDoc] = await Promise.all([
      tx.get(appDocRef),
      tx.get(newDeploymentDocRef),
    ]);
    if (!appDoc.exists) {
      throw new HttpsError('internal', `Missing ${appID} App doc`);
    }
    if (!newDeploymentDoc.exists) {
      throw new HttpsError(
        'internal',
        `Missing ${newDeploymentID} Deployment doc`,
      );
    }
    const newDeployment = must(newDeploymentDoc.data());
    if (
      envUpdateTime.toMillis() !== newDeployment.spec.envUpdateTime.toMillis()
    ) {
      logger.debug(
        `Deployed envUpdateTime differs from that at request time. ` +
          `This should only happen on the first publish or if the env concurrently changes.`,
      );
      newDeployment.spec.envUpdateTime = envUpdateTime;
    }
    const newRunningDeployment = {
      ...newDeployment,
      ...deploymentUpdate('RUNNING'),
    };

    const app = must(appDoc.data());
    const appUpdate: UpdateData<App> = {
      runningDeployment: newRunningDeployment,
      queuedDeploymentIDs: FieldValue.arrayRemove(newDeploymentID),
    };
    if (newScriptRef) {
      appUpdate.scriptRef = newScriptRef;
    }
    if (app.envUpdateTime.toMillis() < envUpdateTime.toMillis()) {
      // Note that it is possible for the app.envUpdateTime to differ from the deployed
      // envUpdateTime because deployments and env updates can happen concurrently. However,
      // a pathological scenario in which the update to app.envUpdateTime permanently
      // fails would result in an infinite deployment loop with the app.envUpdateTime never
      // matching the deployed envUpdateTime. To prevent such a scenario from happening,
      // update the app.envUpdateTime if it is behind. It is always (and only) safe to move
      // the value forward in time.
      logger.debug(
        `App ${appID} envUpdateTime is behind (${app.envUpdateTime.toMillis()} vs ${envUpdateTime.toMillis()}). Updating it with deployment.`,
      );
      appUpdate.envUpdateTime = envUpdateTime;
    }

    tx.set(newDeploymentDocRef, newRunningDeployment);
    tx.update(appDocRef, appUpdate);

    const oldDeploymentID = app.runningDeployment?.deploymentID;
    if (oldDeploymentID) {
      const oldDeploymentDoc = firestore
        .doc(deploymentPath(appID, oldDeploymentID))
        .withConverter(deploymentDataConverter);
      tx.update(oldDeploymentDoc, deploymentUpdate('STOPPED'));
    }
  });
}

async function migrateToWFP(
  firestore: Firestore,
  appID: string,
  deploymentID: string,
  scriptRef: ScriptRef | undefined,
  script: ScriptHandler,
  serverVersion: string,
): Promise<boolean> {
  if (
    scriptRef ||
    // coerce to pre-releases equally.
    lt(coerce(serverVersion) ?? serverVersion, MIN_WFP_VERSION)
  ) {
    // Already on WFP or cannot migrate to WFP
    return false;
  }
  await setDeploymentStatus(
    firestore,
    appID,
    deploymentID,
    'DEPLOYING',
    'Upgrading to new infrastructure',
  );
  logger.info(`Deleting legacy script and custom domain for App ${appID}`);
  await script.delete();

  return true;
}
