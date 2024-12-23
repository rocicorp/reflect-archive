import {Timestamp, type Firestore} from '@google-cloud/firestore';
import {firebaseStub} from 'firestore-jest-mock/mocks/firebase.js';
import {App, appDataConverter, appPath} from 'mirror-schema/src/app.js';
import {
  Membership,
  Role,
  membershipDataConverter,
  teamMembershipPath,
} from 'mirror-schema/src/membership.js';
import {
  appNameIndexDataConverter,
  appNameIndexPath,
  sanitizeForLabel,
  teamDataConverter,
  teamPath,
  type AppNameIndex,
  type Team,
} from 'mirror-schema/src/team.js';
import {
  userDataConverter,
  userPath,
  type User,
} from 'mirror-schema/src/user.js';
import {must} from 'shared/src/must.js';
import {defaultOptions} from './deployment.js';
import {DEFAULT_ENV, envDataConverter, envPath, type Env} from './env.js';
import {
  DEFAULT_PROVIDER_ID,
  providerDataConverter,
  providerPath,
  type Provider,
} from './provider.js';

export function fakeFirestore(): Firestore {
  return firebaseStub(
    {database: {}},
    {mutable: true},
  ).firestore() as unknown as Firestore;
}

export async function setUser(
  firestore: Firestore,
  userID: string,
  email: string,
  name = 'Foo Bar',
  roles: Record<string, Role> = {},
): Promise<User> {
  const user: User = {
    email,
    name,
    roles,
  };
  await firestore
    .doc(userPath(userID))
    .withConverter(userDataConverter)
    .set(user);
  return user;
}

export async function getUser(
  firestore: Firestore,
  userID: string,
): Promise<User> {
  const userDoc = await firestore
    .doc(userPath(userID))
    .withConverter(userDataConverter)
    .get();
  return must(userDoc.data());
}

export async function setTeam(
  firestore: Firestore,
  teamID: string,
  team: Partial<Team>,
): Promise<Team> {
  const {
    name = `Name of ${teamID}`,
    label = sanitizeForLabel(name),
    defaultProvider = DEFAULT_PROVIDER_ID,
    numAdmins = 0,
    numMembers = 0,
    numInvites = 0,
    numApps = 0,
    maxApps = null,
  } = team;
  const newTeam: Team = {
    name,
    label,
    defaultCfID: 'deprecated',
    defaultProvider,
    numAdmins,
    numMembers,
    numInvites,
    numApps,
    maxApps,
  };
  await firestore
    .doc(teamPath(teamID))
    .withConverter(teamDataConverter)
    // Work around bug in
    .set(newTeam, {merge: true});
  return newTeam;
}

export async function getTeam(
  firestore: Firestore,
  teamID: string,
): Promise<Team> {
  const teamDoc = await firestore
    .doc(teamPath(teamID))
    .withConverter(teamDataConverter)
    .get();
  return must(teamDoc.data());
}

export async function setMembership(
  firestore: Firestore,
  teamID: string,
  userID: string,
  email: string,
  role: Role,
): Promise<Membership> {
  const membership: Membership = {
    email,
    role,
  };
  await firestore
    .doc(teamMembershipPath(teamID, userID))
    .withConverter(membershipDataConverter)
    .set(membership);
  return membership;
}

export async function getMembership(
  firestore: Firestore,
  teamID: string,
  userID: string,
): Promise<Membership> {
  const membershipDoc = await firestore
    .doc(teamMembershipPath(teamID, userID))
    .withConverter(membershipDataConverter)
    .get();
  return must(membershipDoc.data());
}

export async function setProvider(
  firestore: Firestore,
  providerID: string,
  provider: Partial<Provider>,
): Promise<Provider> {
  const {
    accountID = `${providerID}-account-id`,
    defaultZone = {
      zoneID: `${providerID}-zone-id`,
      zoneName: `${providerID}-zone-name`,
    },
    defaultMaxApps = 3,
    dispatchNamespace = 'prod',
  } = provider;
  const newProvider: Provider = {
    accountID,
    defaultZone,
    defaultMaxApps,
    dispatchNamespace,
  };
  await firestore
    .doc(providerPath(providerID))
    .withConverter(providerDataConverter)
    .set(newProvider);
  return newProvider;
}

export async function getApp(
  firestore: Firestore,
  appID: string,
): Promise<App> {
  const appDoc = await firestore
    .doc(appPath(appID))
    .withConverter(appDataConverter)
    .get();
  return must(appDoc.data());
}

export async function setApp(
  firestore: Firestore,
  appID: string,
  app: Partial<App>,
): Promise<App> {
  const {
    name = `Name of ${appID}`,
    teamID = 'team-id',
    teamLabel = 'teamlabel',
    provider = DEFAULT_PROVIDER_ID,
    cfScriptName = 'cf-script-name',
    serverReleaseChannel = 'stable',
    envUpdateTime = Timestamp.now(),
    runningDeployment,
  } = app;
  const newApp: App = {
    name,
    teamID,
    teamLabel,
    cfID: 'deprecated',
    provider,
    cfScriptName,
    serverReleaseChannel,
    envUpdateTime,
  };
  if (runningDeployment) {
    newApp.runningDeployment = runningDeployment;
  }
  await firestore
    .doc(appPath(appID))
    .withConverter(appDataConverter)
    .set(newApp);
  return newApp;
}

export async function getAppName(
  firestore: Firestore,
  teamID: string,
  appName: string,
): Promise<AppNameIndex> {
  const appNameDoc = await firestore
    .doc(appNameIndexPath(teamID, appName))
    .withConverter(appNameIndexDataConverter)
    .get();
  return must(appNameDoc.data());
}

export async function setAppName(
  firestore: Firestore,
  teamID: string,
  appID: string,
  name: NamedCurve,
): Promise<void> {
  await firestore
    .doc(appNameIndexPath(teamID, name))
    .withConverter(appNameIndexDataConverter)
    .set({appID});
}

export async function getEnv(
  firestore: Firestore,
  appID: string,
): Promise<Env> {
  const envDoc = await firestore
    .doc(envPath(appID, DEFAULT_ENV))
    .withConverter(envDataConverter)
    .get();
  return must(envDoc.data());
}

export async function setEnv(
  firestore: Firestore,
  appID: string,
  env: Partial<Env>,
): Promise<Env> {
  const {deploymentOptions = defaultOptions(), secrets = {}} = env;
  const newEnv: Env = {
    deploymentOptions,
    secrets,
  };
  await firestore
    .doc(envPath(appID, DEFAULT_ENV))
    .withConverter(envDataConverter)
    .set(newEnv);
  return newEnv;
}
