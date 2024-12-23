import {getFirestore} from 'firebase/firestore';
import {deleteVars} from 'mirror-protocol/src/vars.js';
import {getAppID, getDefaultApp} from '../app-config.js';
import {deleteDevVars} from '../dev/vars.js';
import type {AuthContext} from '../handler.js';
import {makeRequester} from '../requester.js';
import {watchDeployment} from '../watch-deployment.js';
import type {YargvToInterface} from '../yarg-types.js';
import type {CommonVarsYargsArgv} from './types.js';
import {getLogger} from '../logger.js';

export function deleteVarsOptions(yargs: CommonVarsYargsArgv) {
  return yargs
    .positional('keys', {
      describe: 'Space-separated variable names to delete',
      type: 'string',
      array: true,
      demandOption: true,
    })
    .option('app', {
      describe: 'The name of the App',
      type: 'string',
      requiresArg: true,
      default: getDefaultApp(),
      required: true,
    });
}

type DeleteVarsHandlerArgs = YargvToInterface<
  ReturnType<typeof deleteVarsOptions>
>;

export async function deleteVarsHandler(
  yargs: DeleteVarsHandlerArgs,
  authContext: AuthContext,
): Promise<void> {
  const {keys: vars, dev, app} = yargs;
  if (dev) {
    deleteDevVars(vars);
    getLogger().log('Deleted specified Dev Variables');
    return;
  }
  const {userID} = authContext.user;
  const appID = await getAppID(authContext, app, false);

  const data = {requester: makeRequester(userID), appID, vars};
  const {deploymentPath} = await deleteVars.call(data);
  if (!deploymentPath) {
    getLogger().log('Deleted specified environment variables');
  } else {
    getLogger().log('Deploying updated environment variables');
    await watchDeployment(getFirestore(), deploymentPath, 'Deployed');
  }
}
