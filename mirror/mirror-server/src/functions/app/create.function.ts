import type {Firestore, WithFieldValue} from 'firebase-admin/firestore';
import {FieldValue} from 'firebase-admin/firestore';
import {logger} from 'firebase-functions';
import {HttpsError} from 'firebase-functions/v2/https';
import {
  createRequestSchema,
  createResponseSchema,
} from 'mirror-protocol/src/app.js';
import type {UserAgent} from 'mirror-protocol/src/user-agent.js';
import {DistTag} from 'mirror-protocol/src/version.js';
import {apiKeyDataConverter} from 'mirror-schema/src/api-key.js';
import {
  App,
  appDataConverter,
  appPath,
  isValidAppName,
} from 'mirror-schema/src/app.js';
import {encryptUtf8} from 'mirror-schema/src/crypto.js';
import {defaultOptions} from 'mirror-schema/src/deployment.js';
import {
  DEFAULT_ENV,
  ENCRYPTION_KEY_SECRET_NAME,
  Env,
  envDataConverter,
  envPath,
} from 'mirror-schema/src/env.js';
import {
  providerDataConverter,
  providerPath,
} from 'mirror-schema/src/provider.js';
import {
  appNameIndexDataConverter,
  appNameIndexPath,
  teamDataConverter,
  teamPath,
} from 'mirror-schema/src/team.js';
import {randomBytes} from 'node:crypto';
import {SemVer, coerce, gt, gte} from 'semver';
import {newAppID, newAppIDAsNumber, newAppScriptName} from '../../ids.js';
import {SecretsCache, SecretsClient} from '../../secrets/index.js';
import {
  teamOrKeyAuthorization,
  userOrKeyAuthorization,
} from '../validators/auth.js';
import {getDataOrFail} from '../validators/data.js';
import {validateSchema} from '../validators/schema.js';
import {DistTags, userAgentVersion} from '../validators/version.js';
import {REFLECT_API_KEY} from './secrets.js';

export const create = (
  firestore: Firestore,
  secretsClient: SecretsClient,
  testDistTags?: DistTags,
) =>
  validateSchema(createRequestSchema, createResponseSchema)
    .validate(userAgentVersion(testDistTags))
    .validate(userOrKeyAuthorization())
    .validate(teamOrKeyAuthorization(firestore, 'app:create', ['admin']))
    .handle((request, context) => {
      const secrets = new SecretsCache(secretsClient);
      const {userID: keyPath, distTags, isKeyAuth} = context;
      const {
        requester: {userAgent},
        teamID,
        serverReleaseChannel,
        name: appName,
      } = request;

      const minNonDeprecated = distTags[DistTag.MinNonDeprecated];
      if (
        minNonDeprecated &&
        gt(minNonDeprecated, new SemVer(userAgent.version))
      ) {
        throw new HttpsError(
          'out-of-range',
          'This version of Reflect is deprecated. Please update to @rocicorp/reflect@latest to create a new app.',
        );
      }

      if (appName !== undefined && !isValidAppName(appName)) {
        throw new HttpsError(
          'invalid-argument',
          `Invalid App Name "${appName}". Names must be lowercased alphanumeric, starting with a letter and not ending with a hyphen.`,
        );
      }

      // Fetch the secret in parallel with the Firestore transaction.
      const encryptionKey = secrets.getSecret(ENCRYPTION_KEY_SECRET_NAME);
      const reflectAuthApiKey = randomBytes(32).toString('base64url');

      const teamDocRef = firestore
        .doc(teamPath(teamID))
        .withConverter(teamDataConverter);

      return firestore.runTransaction(async txn => {
        // Check app limits
        const team = getDataOrFail(
          await txn.get(teamDocRef),
          'not-found',
          `Team ${teamID} does not exist`,
        );
        // TODO: To support onprem, allow apps to be created for a specific provider with
        //       appropriate authorization.
        const {defaultProvider} = team;
        const {defaultMaxApps, dispatchNamespace} = getDataOrFail(
          await txn.get(
            firestore
              .doc(providerPath(defaultProvider))
              .withConverter(providerDataConverter),
          ),
          'internal',
          `Provider ${defaultProvider} is not properly set up.`,
        );
        if (team.numApps >= (team.maxApps ?? defaultMaxApps)) {
          throw new HttpsError(
            'resource-exhausted',
            `Maximum number of apps reached. Use 'npx @rocicorp/reflect delete' to clean up old apps.`,
          );
        }

        const appIDNumber = newAppIDAsNumber();
        const appID = newAppID(appIDNumber);
        const scriptName = newAppScriptName(appIDNumber);

        const appDocRef = firestore
          .doc(appPath(appID))
          .withConverter(appDataConverter);
        const appNameDocRef = firestore
          .doc(appNameIndexPath(teamID, appName))
          .withConverter(appNameIndexDataConverter);
        const envDocRef = firestore
          .doc(envPath(appID, DEFAULT_ENV))
          .withConverter(envDataConverter);

        const {version, payload: secretKey} = await encryptionKey;
        const encryptedApiKey = encryptUtf8(
          reflectAuthApiKey,
          Buffer.from(secretKey, 'base64url'),
          {version},
        );

        const app: WithFieldValue<App> = {
          name: appName,
          teamID,
          teamLabel: team.label,
          teamSubdomain: '', // Deprecated
          provider: defaultProvider,
          cfID: 'deprecated',
          cfScriptName: scriptName,
          serverReleaseChannel,
          // This will technically be slightly behind the resulting updateTime:
          // https://github.com/googleapis/nodejs-firestore/issues/1610
          // but being behind is okay; timestamps will align at the first deployment.
          envUpdateTime: FieldValue.serverTimestamp(),
        };
        const env: Env = {
          deploymentOptions: defaultOptions(),
          secrets: {[REFLECT_API_KEY]: encryptedApiKey},
        };

        if (supportsWorkersForPlatforms(userAgent)) {
          app.scriptRef = {
            namespace: dispatchNamespace,
            name: scriptName,
          };
        }
        txn.update(teamDocRef, {numApps: team.numApps + 1});
        txn.create(appDocRef, app);
        txn.create(appNameDocRef, {appID});
        txn.create(envDocRef, env);

        if (isKeyAuth) {
          // Add the appID to the key used to authorize the request.
          const keyDoc = firestore
            .doc(keyPath)
            .withConverter(apiKeyDataConverter);
          txn.update(keyDoc, {appIDs: FieldValue.arrayUnion(appID)});
        }
        return {appID, success: true};
      });
    });

export const MIN_WFP_VERSION = new SemVer('0.36.0');

function supportsWorkersForPlatforms(userAgent: UserAgent): boolean {
  const {type: agent, version} = userAgent;
  if (agent !== 'reflect-cli') {
    throw new HttpsError(
      'invalid-argument',
      'Please use @rocicorp/reflect to create and publish apps.',
    );
  }
  // coerce to treat pre-releases equally.
  if (gte(coerce(version) ?? version, MIN_WFP_VERSION)) {
    logger.info(`Creating WFP app for reflect-cli v${version}`);
    return true;
  }
  logger.info(`Creating legacy app for reflect-cli v${version}`);
  return false;
}
