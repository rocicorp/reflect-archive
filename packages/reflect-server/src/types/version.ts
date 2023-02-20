import * as s from 'superstruct';
import type {Storage} from '../storage/storage.js';

export const versionSchema = s.number();
export const nullableVersionSchema = s.union([versionSchema, s.literal(null)]);

export type Version = s.Infer<typeof versionSchema>;
export type NullableVersion = s.Infer<typeof nullableVersionSchema>;

export const versionKey = 'version';

export async function putVersion(
  version: Version,
  storage: Storage,
): Promise<void> {
  await storage.put(versionKey, version);
}

export function getVersion(storage: Storage): Promise<Version | undefined> {
  return storage.get(versionKey, versionSchema);
}

export function compareVersions(
  v1: NullableVersion,
  v2: NullableVersion,
): number {
  if (v1 === v2) {
    return 0;
  }
  if (v1 === null) {
    return -1;
  }
  if (v2 === null) {
    return 1;
  }
  if (v1 < v2) {
    return -1;
  }
  return 1;
}