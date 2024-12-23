import type {Auth, DecodedIdToken} from 'firebase-admin/auth';
import type {Firestore, QueryDocumentSnapshot} from 'firebase-admin/firestore';
import {logger} from 'firebase-functions';
import {CallableRequest, HttpsError} from 'firebase-functions/v2/https';
import type {BaseAppRequest} from 'mirror-protocol/src/app.js';
import type {BaseRequest} from 'mirror-protocol/src/base.js';
import type {BaseTeamRequest} from 'mirror-protocol/src/team.js';
import {
  APP_CREATE_PERMISSION,
  ApiKey,
  apiKeyDataConverter,
  type RequiredPermission,
} from 'mirror-schema/src/api-key.js';
import {appDataConverter, appPath} from 'mirror-schema/src/app.js';
import type {Role} from 'mirror-schema/src/membership.js';
import {userDataConverter, userPath} from 'mirror-schema/src/user.js';
import {assert} from 'shared/src/asserts.js';
import {must} from 'shared/src/must.js';
import {updateKey} from '../../keys/updates.js';
import {
  INTERNAL_FUNCTION_HEADER,
  INTERNAL_FUNCTION_SECRET,
} from '../internal/auth.js';
import {verifyKey} from '../keys/verify.js';
import {getDataOrFail} from './data.js';
import type {HttpsRequestContext} from './https.js';
import type {
  AppAuthorization,
  RequestContextValidator,
  TeamAuthorization,
  UserAuthorization,
  UserOrKeyAuthorization,
} from './types.js';

interface AuthKeyContext {
  apiKeyDoc?: QueryDocumentSnapshot<ApiKey>;
}

// The subset of CallableRequest fields applicable to `userAuthorization`.
interface AuthContext extends AuthKeyContext {
  auth?: {
    uid: string;
    token?: DecodedIdToken;
  };
}

/**
 * Creates an `AuthContext` from an `onRequest()` HttpsRequestContext by parsing
 * and verifying the `Authorization: <Bearer|Basic>` request header. This bridges the
 * API for https requests to callable requests.
 */
export function authorizationHeader<
  Request,
  Context extends HttpsRequestContext,
>(
  firestore: Firestore,
  auth: Auth,
): RequestContextValidator<Request, Context, Context & AuthContext> {
  return async (_, context) => {
    const authorization = context.request.header('authorization');
    if (typeof authorization !== 'string') {
      throw new HttpsError('unauthenticated', 'Invalid Authorization header');
    }
    const parts = authorization.split(/\s+/);
    if (parts.length !== 2) {
      throw new HttpsError('unauthenticated', 'Invalid Authorization header');
    }
    const authScheme = parts[0].toLowerCase();
    const creds = parts[1];
    switch (authScheme) {
      case 'bearer': {
        const decodedIdToken = await auth.verifyIdToken(creds);
        return {
          ...context,
          auth: {uid: decodedIdToken.uid, token: decodedIdToken},
        };
      }
      case 'basic': {
        const keyDoc = await verifyKey(firestore, creds);
        const keyPath = keyDoc.ref.path;
        return {
          ...context,
          auth: {uid: keyPath},
          apiKeyDoc: keyDoc,
        };
      }
    }
    throw new HttpsError('unauthenticated', 'Unsupported Authorization scheme');
  };
}

export function internalFunctionHeader<
  Request,
  Context extends CallableRequest,
>() {
  return (_: Request, ctx: Context) => {
    const secretValue = ctx.rawRequest.header(INTERNAL_FUNCTION_HEADER);
    if (secretValue !== INTERNAL_FUNCTION_SECRET.value()) {
      throw new HttpsError('permission-denied', 'Unauthorized caller');
    }
    return ctx;
  };
}

/**
 * Validator for API requests that do not contain a `requester` field, but
 * rather relies solely on the AuthContext.
 */
export function authenticatedAsRequester<
  Request,
  Context extends AuthContext,
>() {
  return (_: Request, context: Context) =>
    userAuthorizationImpl(true)(
      {
        requester: {
          userID: context.auth?.uid ?? 'unauthenticated', // Will fail.
          userAgent: {type: 'internal', version: 'none'},
        },
      },
      context,
    );
}

/**
 * Validator that checks the original authentication against the
 * requester userID and initializes a {@link UserOrKeyAuthorization} context.
 */
export function userOrKeyAuthorization<
  Request extends BaseRequest,
  Context extends AuthContext,
>(): RequestContextValidator<
  Request,
  Context,
  // Remove the 'auth' field from the OutputContext to prevent
  // downstream code from erroneously referencing the authenticated
  // user (i.e. context.auth.uid); subsequent logic should be based
  // on the requester.userID.
  Omit<Context, 'auth'> & UserOrKeyAuthorization
> {
  return userAuthorizationImpl(true);
}

/**
 * Validator that checks the original authentication against the
 * requester userID and initializes a {@link UserAuthorization} context.
 */
export function userAuthorization<
  Request extends BaseRequest,
  Context extends AuthContext,
>(): RequestContextValidator<
  Request,
  Context,
  // Remove the 'auth' field from the OutputContext to prevent
  // downstream code from erroneously referencing the authenticated
  // user (i.e. context.auth.uid); subsequent logic should be based
  // on the requester.userID.
  Omit<Context, 'auth'> & UserAuthorization
> {
  return userAuthorizationImpl(false);
}

/**
 * Internal implementation for `userOrKeyAuthorization` and `userAuthorization`.
 * The two are exported as separate methods to facilitate type-safety of the
 * OutputContext. (Namely, the type system requires that `appOrKeyAuthorization()`
 * be preceded by `userOrKeyAuthorization()` because it requires a
 * `UserOrKeyAuthorization` InputContext.)
 */
function userAuthorizationImpl<
  Request extends BaseRequest,
  Context extends AuthContext,
>(
  allowKeys: boolean,
): RequestContextValidator<
  Request,
  Context,
  Omit<Context, 'auth'> & UserOrKeyAuthorization
> {
  return (request, context) => {
    if (context.auth?.uid === undefined) {
      throw new HttpsError('unauthenticated', 'missing authentication');
    }
    if (!allowKeys && context.auth.uid.includes('/')) {
      throw new HttpsError(
        'permission-denied',
        'This action does not support key-based authorization',
      );
    }
    if (context.auth.uid !== request.requester.userID) {
      // Check custom claims for temporary super powers.
      const superUntil = context.auth.token?.superUntil;
      if (typeof superUntil === 'number' && superUntil >= Date.now()) {
        logger.info(
          `${context.auth.uid} (${context.auth.token?.email}) impersonating ${request.requester.userID}`,
        );
      } else {
        throw new HttpsError(
          'permission-denied',
          'authenticated user is not authorized to make this request',
        );
      }
    }
    return {
      ...context,
      userID: request.requester.userID,
      isKeyAuth: context.auth.uid.includes('/'),
    };
  };
}
/**
 * Validates that the authenticated user has one of the specified roles in a team,
 * or that the Api key has the required permission.
 */
export function teamOrKeyAuthorization<
  Request extends BaseTeamRequest,
  Context extends UserOrKeyAuthorization & AuthKeyContext,
>(
  firestore: Firestore,
  keyPermission: RequiredPermission,
  allowedRoles: Role[] = ['admin', 'member'],
): RequestContextValidator<Request, Context, Context & TeamAuthorization> {
  const nonKeyTeamAuthorization = teamAuthorization<Request, Context>(
    firestore,
    allowedRoles,
  );

  return async (request: Request, context: Context) => {
    const {isKeyAuth, apiKeyDoc: apiKeyFromBasicAuth} = context;
    if (!isKeyAuth) {
      return nonKeyTeamAuthorization(request, context);
    }
    const {teamID} = request;
    const {userID: keyPath} = context;
    const apiKeyDocRef = firestore
      .doc(keyPath)
      .withConverter(apiKeyDataConverter);
    if (teamID !== apiKeyDocRef.parent.parent?.id) {
      throw new HttpsError(
        'permission-denied',
        `Key "${apiKeyDocRef.id}" is not authorized for team ${teamID}`,
      );
    }

    const authorization: TeamAuthorization = await firestore.runTransaction(
      async txn => {
        // No need to lookup up the ApiKey again if it was queried when verifying the Authorization header.
        const apiKeyDoc = apiKeyFromBasicAuth ?? (await txn.get(apiKeyDocRef));
        if (!apiKeyDoc.exists) {
          throw new HttpsError(
            'permission-denied',
            `Key "${apiKeyDoc.id}" has been deleted`,
          );
        }
        const apiKey = must(apiKeyDoc.data());
        if (!apiKey.permissions[keyPermission]) {
          throw new HttpsError(
            'permission-denied',
            `Key "${apiKeyDoc.id}" has not been granted "${keyPermission}" permission`,
          );
        }
        logger.info(
          `Key "${keyPath}" authorized with ${keyPermission} permission`,
        );
        return {teamID};
      },
      {readOnly: true},
    );
    // Fire-and-forget a call to `apiKeys-update`, which is an internal function that
    // uses delayed batching to coalesce writes to the same key, and moves the Firestore
    // write transaction out of the critical path.
    void updateKey({
      teamID,
      keyName: apiKeyDocRef.id,
      lastUsed: Date.now(),
    }).catch(e =>
      logger.error(`Error sending update for ${apiKeyDocRef.path}`, e),
    );
    return {...context, ...authorization};
  };
}

/**
 * Validates that the authenticated user has one of the specified roles in a team.
 */
export function teamAuthorization<
  Request extends BaseTeamRequest,
  Context extends UserAuthorization,
>(
  firestore: Firestore,
  allowedRoles: Role[] = ['admin', 'member'],
): RequestContextValidator<Request, Context, Context & TeamAuthorization> {
  return async (request: Request, context: Context) => {
    const {teamID} = request;
    const {userID} = context;
    const userDoc = await firestore
      .doc(userPath(userID))
      .withConverter(userDataConverter)
      .get();
    const {roles} = getDataOrFail(
      userDoc,
      'failed-precondition',
      `User ${userID} has not been initialized`,
    );
    const role = roles[teamID];
    if (!allowedRoles.includes(role)) {
      throw new HttpsError(
        'permission-denied',
        `User has insufficient permissions (${role}) for team ${teamID}`,
      );
    }
    logger.debug(`User is authorized as ${role} of ${teamID}`);
    return {...context, teamID};
  };
}

export function appOrKeyAuthorization<
  Request extends Pick<BaseAppRequest, 'appID'>,
  Context extends UserOrKeyAuthorization & AuthKeyContext,
>(
  firestore: Firestore,
  keyPermission: RequiredPermission,
  allowedRoles: Role[] = ['admin', 'member'],
): RequestContextValidator<Request, Context, Context & AppAuthorization> {
  const nonKeyAppAuthorization = appAuthorization<Request, Context>(
    firestore,
    allowedRoles,
  );

  return async (request: Request, context: Context) => {
    const {isKeyAuth, apiKeyDoc: apiKeyFromBasicAuth} = context;
    if (!isKeyAuth) {
      return nonKeyAppAuthorization(request, context);
    }
    const {userID: keyPath} = context;
    const apiKeyDocRef = firestore
      .doc(keyPath)
      .withConverter(apiKeyDataConverter);
    const {appID} = request;
    const appDocRef = firestore
      .doc(appPath(appID))
      .withConverter(appDataConverter);

    const authorization: AppAuthorization = await firestore.runTransaction(
      async txn => {
        const [apiKeyDoc, appDoc] = await Promise.all([
          // No need to lookup up the ApiKey again if it was queried when verifying the Authorization header.
          apiKeyFromBasicAuth ? apiKeyFromBasicAuth : txn.get(apiKeyDocRef),
          txn.get(appDocRef),
        ]);
        if (!apiKeyDoc.exists) {
          throw new HttpsError(
            'permission-denied',
            `Key "${apiKeyDoc.id}" has been deleted`,
          );
        }
        const apiKey = must(apiKeyDoc.data());
        if (!apiKey.appIDs.includes(appID)) {
          throw new HttpsError(
            'permission-denied',
            `Key "${apiKeyDocRef.id}" is not authorized for app ${appID}`,
          );
        }
        if (!apiKey.permissions[keyPermission]) {
          throw new HttpsError(
            'permission-denied',
            keyPermission === APP_CREATE_PERMISSION
              ? `Key "${apiKeyDoc.id}" is not configured to create new Apps. ` +
                'Add "(created apps)" to the list of allowed apps for this key.'
              : `Key "${apiKeyDoc.id}" has not been granted "${keyPermission}" permission`,
          );
        }
        logger.info(
          `Key "${keyPath}" authorized with ${keyPermission} permission`,
        );
        // Note: The existence check for the appID is done _after_ verifying that the
        // key is authorized to act upon the App, eliminating the ability to scrape appIDs.
        if (!appDoc.exists) {
          throw new HttpsError('not-found', `App ${appID} does not exist`);
        }
        const app = must(appDoc.data());
        // Sanity check that the app still belongs to the team. (We should remove them from team
        // keys if/when we allow moving apps to different teams).
        if (apiKeyDoc.ref.parent?.parent?.id !== app.teamID) {
          throw new HttpsError(
            'internal',
            `Invalid ApiKey ${keyPath} for App ${appID} in team ${app.teamID}`,
          );
        }
        return {app};
      },
      {readOnly: true},
    );
    // Fire-and-forget a call to `apiKeys-update`, which is an internal function that
    // uses delayed batching to coalesce writes to the same key, and moves the Firestore
    // write transaction out of the critical path.
    void updateKey({
      teamID: authorization.app.teamID,
      keyName: apiKeyDocRef.id,
      lastUsed: Date.now(),
    }).catch(e =>
      logger.error(`Error sending update for ${apiKeyDocRef.path}`, e),
    );
    return {...context, ...authorization};
  };
}

/**
 * Validates that the authorized user has privileges to modify the
 * app associated with the request.
 */
export function appAuthorization<
  Request extends Pick<BaseAppRequest, 'appID'>,
  Context extends UserAuthorization,
>(
  firestore: Firestore,
  allowedRoles: Role[] = ['admin', 'member'],
): RequestContextValidator<Request, Context, Context & AppAuthorization> {
  assert(allowedRoles.length > 0, 'allowedRoles must be non-empty');
  return async (request: Request, context: Context) => {
    const {userID} = context;
    const userDocRef = firestore
      .doc(userPath(userID))
      .withConverter(userDataConverter);
    const {appID} = request;
    const appDocRef = firestore
      .doc(appPath(appID))
      .withConverter(appDataConverter);

    const authorization: AppAuthorization = await firestore.runTransaction(
      async txn => {
        const [userDoc, appDoc] = await Promise.all([
          txn.get(userDocRef),
          txn.get(appDocRef),
        ]);
        if (!userDoc.exists) {
          throw new HttpsError(
            'failed-precondition',
            `User ${userID} has not been initialized`,
          );
        }
        if (!appDoc.exists) {
          throw new HttpsError('not-found', `App ${appID} does not exist`);
        }
        const user = must(userDoc.data());
        const app = must(appDoc.data());
        const {teamID} = app;
        const role = user.roles[teamID];
        if (allowedRoles.indexOf(role) < 0) {
          throw new HttpsError(
            'permission-denied',
            `User ${userID} has insufficient permissions for App ${appID}`,
          );
        }
        logger.info(
          `User ${userID} has role ${role} in team ${teamID} of app ${appID}`,
        );
        return {app};
      },
      {readOnly: true},
    );
    return {...context, ...authorization};
  };
}
