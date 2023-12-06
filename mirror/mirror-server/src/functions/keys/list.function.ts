import type {Firestore} from 'firebase-admin/firestore';
import {
  listAppKeysRequestSchema,
  listAppKeysResponseSchema,
} from 'mirror-protocol/src/app-keys.js';
import {
  appKeyDataConverter,
  appKeysCollection,
  defaultPermissions,
} from 'mirror-schema/src/app-key.js';
import {appAuthorization, userAuthorization} from '../validators/auth.js';
import {validateSchema} from '../validators/schema.js';
import {userAgentVersion} from '../validators/version.js';

export const list = (firestore: Firestore) =>
  validateSchema(listAppKeysRequestSchema, listAppKeysResponseSchema)
    .validate(userAgentVersion())
    .validate(userAuthorization())
    .validate(appAuthorization(firestore, ['admin']))
    .handle(async request => {
      const {appID, show} = request;

      const keys = await firestore
        .collection(appKeysCollection(appID))
        .orderBy('lastUsed', 'desc')
        .withConverter(appKeyDataConverter)
        .get();

      return {
        success: true,
        keys: keys.docs.map(doc => {
          const key = doc.data();
          return {
            name: doc.id,
            value: show ? key.value : null,
            permissions: key.permissions,
            createTime: key.created.toMillis(),
            lastUseTime: key.lastUsed?.toMillis() ?? null,
          };
        }),
        defaultPermissions: defaultPermissions(),
      };
    });
