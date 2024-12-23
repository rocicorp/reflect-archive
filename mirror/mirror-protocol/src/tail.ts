import {getFunctions, type Functions} from 'firebase/functions';
import * as v from 'shared/src/valita.js';
import {baseAppRequestFields} from './app.js';
import {baseResponseFields} from './base.js';

export const roomTailRequestSchema = v.object({
  ...baseAppRequestFields,
  roomID: v.string(),
});

export type RoomTailRequest = v.Infer<typeof roomTailRequestSchema>;

export const roomTailResponseSchema = v.object(baseResponseFields);

export type RoomTailResponse = v.Infer<typeof roomTailResponseSchema>;

export const tailRequestSchema = v.object({
  ...baseAppRequestFields,
});

export type TailRequest = v.Infer<typeof tailRequestSchema>;

export const tailResponseSchema = v.object(baseResponseFields);

export type TailResponse = v.Infer<typeof tailResponseSchema>;

export function createTailEventSourceURL(
  functionName: string,
  appID: string,
): string {
  // Firebase has an undocumented property to determine if the emulator is being
  // used and at what origin.
  // https://stackoverflow.com/questions/71899872/how-to-get-the-current-https-functions-endpoint-for-firebase-when-using-not-usin
  const functions: Functions & {emulatorOrigin?: string} = getFunctions();
  if (functions.emulatorOrigin) {
    return `${functions.emulatorOrigin}/${functions.app.options.projectId}/${functions.region}/${functionName}/${appID}`;
  }
  return `https://${functions.region}-${functions.app.options.projectId}.cloudfunctions.net/${functionName}/${appID}`;
}
