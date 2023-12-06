import {FieldValue, type Firestore} from 'firebase-admin/firestore';
import {logger} from 'firebase-functions';
import {HttpsError} from 'firebase-functions/v2/https';
import {
  createAppKeyRequestSchema,
  createAppKeyResponseSchema,
} from 'mirror-protocol/src/app-keys.js';
import {
  appKeyDataConverter,
  appKeyPath,
  appKeysCollection,
  isValidAppKeyName,
  normalizePermissions,
  type Permissions,
} from 'mirror-schema/src/app-key.js';
import {randomBytes} from 'node:crypto';
import {appAuthorization, userAuthorization} from '../validators/auth.js';
import {validateSchema} from '../validators/schema.js';
import {userAgentVersion} from '../validators/version.js';

export const MAX_KEYS = 100;

export const create = (firestore: Firestore) =>
  validateSchema(createAppKeyRequestSchema, createAppKeyResponseSchema)
    .validate(userAgentVersion())
    .validate(userAuthorization())
    .validate(appAuthorization(firestore, ['admin']))
    .handle(async request => {
      const {appID, name, permissions} = request;

      if (!isValidAppKeyName(name)) {
        throw new HttpsError(
          'invalid-argument',
          `Invalid name "${name}". Names must be lowercased alphanumeric, starting with a letter and not ending with a hyphen.`,
        );
      }
      let validatedPermissions: Permissions;
      try {
        validatedPermissions = normalizePermissions(permissions);
      } catch (e) {
        logger.warn(`Rejecting permissions: ${String(e)}`, permissions);
        throw new HttpsError('invalid-argument', 'Invalid permissions');
      }

      const keyDoc = firestore
        .doc(appKeyPath(appID, name))
        .withConverter(appKeyDataConverter);

      const value = randomBytes(32).toString('base64url');
      await firestore.runTransaction(async tx => {
        const keys = await tx.get(
          firestore.collection(appKeysCollection(appID)).count(),
        );
        if (keys.data().count >= MAX_KEYS) {
          throw new HttpsError(
            'resource-exhausted',
            'Maximum keys reached. Use `reflect keys delete` to delete keys',
          );
        }
        const doc = await tx.get(keyDoc);
        if (doc.exists) {
          throw new HttpsError(
            'already-exists',
            `A key named "${name}" already exists.`,
          );
        }
        tx.create(keyDoc, {
          value,
          permissions: validatedPermissions,
          created: FieldValue.serverTimestamp(),
          lastUsed: null,
        });
      });

      return {
        success: true,
        value,
      };
    });
