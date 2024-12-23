import * as v from 'shared/src/valita.js';
import {isValidAppName} from './app.js';
import {firestoreDataConverter} from './converter.js';
import * as path from './path.js';
import {teamPath} from './team.js';
import {timestampSchema} from './timestamp.js';

// All permissions must be a default=false boolean.
// This makes any instance forward compatible with new permissions.
const permissionValue = v.boolean().default(false);

// These permission have special handling with respect to an API key's `appIDs` field.
export const APP_CREATE_PERMISSION = 'app:create';
export const APP_PUBLISH_PERMISSION = 'app:publish';

export const permissionsSchema = v.object({
  [APP_CREATE_PERMISSION]: permissionValue,
  [APP_PUBLISH_PERMISSION]: permissionValue,
  'env:modify': permissionValue,
  'rooms:read': permissionValue,
  'rooms:create': permissionValue,
  'rooms:close': permissionValue,
  'rooms:delete': permissionValue,
  'connections:invalidate': permissionValue,
});

export type Permissions = v.Infer<typeof permissionsSchema>;

export const ALL_PERMISSIONS: {[perm in keyof Permissions]: string} = {
  [APP_CREATE_PERMISSION]: 'authorizes creating a new app',
  [APP_PUBLISH_PERMISSION]: 'authorizes publishing a new server version',
  'env:modify': 'authorizes modifying environment variables',
  'rooms:read': 'authorizes reading room status',
  'rooms:create': 'authorizes creating new rooms',
  'rooms:close': 'authorizes closing rooms',
  'rooms:delete': 'authorizes deleting rooms',
  'connections:invalidate': 'authorizes invalidating connections to rooms',
} as const;

export function defaultPermissions(): Permissions {
  return v.parse({}, permissionsSchema);
}

export function normalizePermissions(perms: unknown): Permissions {
  return v.parse(perms, permissionsSchema);
}

/** Type used by runtime actions to declare the permission required to execute the action. */
export type RequiredPermission = keyof Permissions;

export const apiKeySchema = v.object({
  value: v.string(),
  permissions: permissionsSchema,
  created: timestampSchema,
  lastUsed: timestampSchema.nullable(),
  appIDs: v.array(v.string()),
});

export type ApiKey = v.Infer<typeof apiKeySchema>;

export const apiKeyDataConverter = firestoreDataConverter(apiKeySchema);

export const API_KEY_COLLECTION_ID = 'keys';

export function apiKeysCollection(teamID: string): string {
  return path.append(teamPath(teamID), API_KEY_COLLECTION_ID);
}

export function apiKeyPath(teamID: string, name: string): string {
  return path.append(apiKeysCollection(teamID), name);
}

// Key names are used in Firestore paths. Use the same constraints for
// app names as we do for key names. This makes things consistent and understandable,
// and avoids illegal document names.
// https://firebase.google.com/docs/firestore/quotas#collections_documents_and_fields
export const isValidApiKeyName = isValidAppName;
