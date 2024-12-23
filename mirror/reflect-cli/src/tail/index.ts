import {
  TailMessage,
  connectedMessageSchema,
  errorMessageSchema,
} from 'mirror-protocol/src/tail-message.js';
import type {RoomTailRequest} from 'mirror-protocol/src/tail.js';
import * as valita from 'shared/src/valita.js';
import {getAppID, getDefaultApp} from '../app-config.js';
import type {CommonYargsArgv, YargvToInterface} from '../yarg-types.js';
import {createTailEventSource} from './tail-event-source.js';
import type {AuthContext} from '../handler.js';
import {getLogger} from '../logger.js';

export function tailOptions(yargs: CommonYargsArgv) {
  return yargs
    .option('room', {
      describe: 'The room ID of the room to tail',
      type: 'string',
      requiresArg: true,
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

type TailHandlerArgs = YargvToInterface<ReturnType<typeof tailOptions>>;

export async function tailHandler(
  yargs: TailHandlerArgs,
  authContext: AuthContext,
) {
  const {app} = yargs;
  const appID = await getAppID(authContext, app, false);
  const idToken = await authContext.user.getIdToken();
  const {room: roomID} = yargs;

  const data: RoomTailRequest = {
    requester: authContext.requester,
    appID,
    roomID,
  };

  const tailEventSource = createTailEventSource(
    'room-tail',
    appID,
    idToken,
    data,
  );

  try {
    getLogger().log(`Connecting to room ${roomID} to tail log...`);
    for await (const entry of tailEventSource) {
      logTailMessage(entry);
    }
  } catch (e) {
    if (e instanceof Error) {
      if (/\b404\b/.test(e.message)) {
        getLogger().error('404 Not found');
        getLogger().error('Could not connect to room to tail log.');
        getLogger().error(
          'Please update your app dependencies to @rocicorp/reflect@latest.',
        );
        return;
      }
    }
    throw e;
  }
}

function logTailMessage(entry: TailMessage) {
  if (valita.is(entry, connectedMessageSchema)) {
    getLogger().log('Connected.');
    return;
  }

  if (valita.is(entry, errorMessageSchema)) {
    // failed to connect
    getLogger().error(`${entry.kind}: ${entry.message}`);
    process.exit(1);
  }

  const {level, message} = entry;
  switch (level) {
    case 'debug':
    case 'error':
    case 'info':
    case 'log':
    case 'warn':
      getLogger()[level](...message);
      console[level](...message);
      break;
    default:
      getLogger().log(`(${level})`, ...message);
      console.log(`(${level})`, ...message);
  }
}
