import {
  Firestore,
  collection,
  doc,
  getDoc,
  getDocs,
  getFirestore,
  query,
  where,
} from 'firebase/firestore';
import {deleteApp} from 'mirror-protocol/src/app.js';
import {
  APP_COLLECTION,
  appPath,
  appViewDataConverter,
} from 'mirror-schema/src/external/app.js';
import {deploymentViewDataConverter} from 'mirror-schema/src/external/deployment.js';
import {watchDoc} from 'mirror-schema/src/external/watch.js';
import {must} from 'shared/src/must.js';
import {getAppID, readAppConfig, writeAppConfig} from './app-config.js';
import type {AuthContext} from './handler.js';
import {checkbox, confirm} from './inquirer.js';
import {makeRequester} from './requester.js';
import {getSingleTeam} from './teams.js';
import type {CommonYargsArgv, YargvToInterface} from './yarg-types.js';

export function deleteOptions(yargs: CommonYargsArgv) {
  return yargs.option('app', {
    describe: 'The name of the App. Omit this to choose the Apps from a list.',
    type: 'string',
    requiresArg: true,
  });
}

type DeleteHandlerArgs = YargvToInterface<ReturnType<typeof deleteOptions>>;

export async function deleteHandler(
  yargs: DeleteHandlerArgs,
  authContext: AuthContext,
): Promise<void> {
  const firestore = getFirestore();
  const {userID} = authContext.user;
  const apps = await getAppsToDelete(firestore, yargs, authContext);
  let selectedApps = [];
  if (apps.length === 1) {
    if (
      !(await confirm({
        message: `Delete "${apps[0].name}" and associated data?`,
        default: false,
      }))
    ) {
      return;
    }
    selectedApps = apps;
  } else if (apps.length === 0) {
    console.info('No apps to delete.');
    return;
  } else {
    selectedApps = await checkbox({
      message: `Select the apps and associated data to delete:`,
      instructions: false,
      choices: apps.map(app => ({name: app.name, value: app})),
    });
  }
  for (const app of selectedApps) {
    console.info(`Requesting delete of "${app.name}"`);
    const {deploymentPath} = await deleteApp.call({
      requester: makeRequester(userID),
      appID: app.id,
    });

    const deploymentDoc = doc(firestore, deploymentPath).withConverter(
      deploymentViewDataConverter,
    );

    try {
      for await (const snapshot of watchDoc(deploymentDoc)) {
        const deployment = snapshot.data();
        if (!deployment) {
          // Happens if requested by a superAdmin that has permission to read any doc.
          console.info(`"${app.name}" successfully deleted`);
          break;
        }
        const {status, statusMessage: msg} = deployment;
        console.info(
          `Status: ${status === 'DEPLOYING' ? 'DELETING' : status}${
            msg ? ': ' + msg : ''
          }`,
        );
        if (deployment.status === 'FAILED' || deployment.status === 'STOPPED') {
          break;
        }
      }
    } catch (e) {
      // Once the App doc is deleted, security rules bar the user from accessing the
      // deployment doc, which results in a 'permission-denied' error. Assume this to
      // mean that the App was successfully deleted.
      if ((e as unknown as {code?: unknown}).code === 'permission-denied') {
        console.info(`"${app.name}" successfully deleted`);
      } else {
        throw e;
      }
    }
    if (app.fromAppConfig) {
      const config = readAppConfig();
      if (config?.apps?.default) {
        delete config.apps.default;
        writeAppConfig(config);
      }
    }
  }
}

type AppInfo = {
  id: string;
  name: string;
  fromAppConfig?: boolean | undefined;
};

async function getAppsToDelete(
  firestore: Firestore,
  yargs: DeleteHandlerArgs,
  authContext: AuthContext,
): Promise<AppInfo[]> {
  const {app} = yargs;
  if (app) {
    const appID = await getAppID(authContext, app);
    return getApp(firestore, appID, true);
  }
  const teamID = await getSingleTeam(firestore, authContext, 'admin');
  const q = query(
    collection(firestore, APP_COLLECTION).withConverter(appViewDataConverter),
    where('teamID', '==', teamID),
  );
  const apps = await getDocs(q);
  return apps.docs.map(doc => ({id: doc.id, name: doc.data().name}));
}

async function getApp(
  firestore: Firestore,
  id: string,
  fromAppConfig?: boolean,
): Promise<AppInfo[]> {
  const appDoc = await getDoc(
    doc(firestore, appPath(id)).withConverter(appViewDataConverter),
  );
  if (!appDoc.exists()) {
    throw new Error(`App is already deleted`);
  }
  const {name} = must(appDoc.data());
  return [{id, name, fromAppConfig}];
}
