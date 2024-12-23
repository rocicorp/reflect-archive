import * as v from 'shared/src/valita.js';
import {firestoreDataConverter} from './converter.js';
import {moduleRefSchema} from './module.js';
import * as path from './path.js';
import {timestampSchema} from './timestamp.js';

export const logLevelSchema = v.union(
  v.literal('debug'),
  v.literal('info'),
  v.literal('error'),
);

export const stringBooleanSchema = v.union(
  v.literal('true'),
  v.literal('false'),
);

/**
 * Defines all vars-enabled toggles for dynamically modifying the behavior of the app
 * (e.g. logging). Each type value must have a `default(literal)` that represents the
 * value that is logically equivalent to the absence of the var. This facilitates
 * logical comparison of deployment state even when new vars are introduced, with an
 * additional benefit of new vars automatically deployed with the next deployment.
 */
export const varsSchema = v.object({
  /* eslint-disable @typescript-eslint/naming-convention */
  DISABLE: stringBooleanSchema.default('false'),
  DISABLE_LOG_FILTERING: stringBooleanSchema.default('false'),
  LOG_LEVEL: logLevelSchema.default('info'),
  /* eslint-enable @typescript-eslint/naming-convention */
});

export type DeploymentVars = v.Infer<typeof varsSchema>;

function defaultVars(): DeploymentVars {
  return v.parse({}, varsSchema);
}

export const deploymentOptionsSchema = v.object({
  vars: varsSchema,
});

export type DeploymentOptions = v.Infer<typeof deploymentOptionsSchema>;

export function defaultOptions(): DeploymentOptions {
  return {vars: defaultVars()};
}

export const deploymentSecretsSchema = v.record(v.string());

export type DeploymentSecrets = v.Infer<typeof deploymentSecretsSchema>;

export const deploymentTypeSchema = v.union(
  v.literal('USER_UPLOAD'),
  v.literal('USER_ROLLBACK'),
  v.literal('SERVER_UPDATE'),
  v.literal('ENV_UPDATE'),
  v.literal('OPTIONS_UPDATE'), // Subsumed by ENV_UPDATE, but may be revived at some point
  v.literal('SECRETS_UPDATE'), // Subsumed by ENV_UPDATE, but may be revived at some point
  v.literal('HOSTNAME_UPDATE'),
  v.literal('MAINTENANCE_UPDATE'), // Triggered by the App.forceDeployment field
  // Although DELETE is not technically a cloudflare "deployment", all cloudflare
  // worker commands are serialized via the deployment queue to avoid race
  // conditions that could otherwise arise from concurrent execution.
  v.literal('DELETE'),
);
export type DeploymentType = v.Infer<typeof deploymentTypeSchema>;

export const deploymentStatusSchema = v.union(
  v.literal('REQUESTED'),
  v.literal('DEPLOYING'),
  v.literal('RUNNING'),
  v.literal('STOPPED'),
  v.literal('FAILED'),
);
export type DeploymentStatus = v.Infer<typeof deploymentStatusSchema>;

// DeploymentSpec encapsulates the information that determines what is deployed
// to Cloudflare (along with optional user-supplied metadata such as `appVersion`
// and `description`). It is derived from a combination of user-specified inputs
// (`appModules`, `serverVersionRange`, and optional app metadata), and auxiliary
// inputs such as available server versions, app options, and secrets.
//
// When these inputs may have changed, the desired DeploymentSpec is recomputed based
// on the user-specified inputs of the currently running Deployment, to determine
// if a new deployment is necessary.
export const deploymentSpecSchema = v.object({
  // The first app module must be the "main" module that exports the
  // ReflectServerOptions creation function as default.
  appModules: v.array(moduleRefSchema),
  appVersion: v.string().optional(),
  description: v.string().optional(),
  serverVersionRange: v.string(),

  serverVersion: v.string(),
  // The hostname of the worker, which is https://<appName>.reflect-server.net
  // can be a vanity domain in the future.
  hostname: v.string(),
  // UpdateTime of the Env that determines aspects of the deployment such as
  // vars and secrets.
  envUpdateTime: timestampSchema,
});

export type DeploymentSpec = v.Infer<typeof deploymentSpecSchema>;

export const deploymentSchema = v.object({
  deploymentID: v.string(), // Matches the doc ID
  requesterID: v.string(), // userID
  type: deploymentTypeSchema,
  spec: deploymentSpecSchema,

  status: deploymentStatusSchema,
  // A message associated with the current status of the deployment that is
  // suitable for displaying to the user.
  statusMessage: v.string().optional(),

  requestTime: timestampSchema,
  deployTime: timestampSchema.optional(),
  startTime: timestampSchema.optional(),
  stopTime: timestampSchema.optional(),
});

export type Deployment = v.Infer<typeof deploymentSchema>;

export const deploymentDataConverter = firestoreDataConverter(deploymentSchema);

export const APP_COLLECTION = 'apps';

export function appPath(appID: string): string {
  return path.join(APP_COLLECTION, appID);
}

export const APP_DEPLOYMENTS_COLLECTION_ID = 'deployments';

export function deploymentsCollection(appID: string): string {
  return path.append(appPath(appID), APP_DEPLOYMENTS_COLLECTION_ID);
}

export function deploymentPath(appID: string, deploymentID: string): string {
  return path.append(deploymentsCollection(appID), deploymentID);
}
