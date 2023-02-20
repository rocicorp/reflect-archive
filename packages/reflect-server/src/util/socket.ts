import type {LogContext} from '@rocicorp/logger';
import type {Downstream} from '../protocol/down.js';
import type {ErrorKind, ErrorMessage} from '../protocol/error.js';
import type {Socket} from '../types/client-state.js';

export function sendError(
  lc: LogContext,
  ws: Socket,
  kind: ErrorKind,
  message = '',
) {
  sendErrorInternal(lc, 'Sending error on socket', ws, kind, message);
}

/**
 * msg is optional and will be truncated to 123 bytes.
 */
export function closeWithError(
  lc: LogContext,
  ws: Socket,
  kind: ErrorKind,
  message = '',
) {
  sendErrorInternal(lc, 'Closing socket with error', ws, kind, message);
  ws.close();
}

function sendErrorInternal(
  lc: LogContext,
  logMessage: string,
  ws: Socket,
  kind: ErrorKind,
  message = '',
) {
  const data: ErrorMessage = ['error', kind, message];
  lc.debug?.(logMessage, {
    kind,
    message,
  });
  send(ws, data);
}

export function send(ws: Socket, data: Downstream) {
  ws.send(JSON.stringify(data));
}

export function encodeReason(msg: string): string {
  // WebSocket close reason length must be less than 123 bytes UTF-8 (RFC 6455)
  // We replace all non ascii characters in msg with '?'. We then encode the
  // reason as "kind: msg" and truncate to 123 bytes.

  msg = msg
    // eslint-disable-next-line no-control-regex
    .replace(/[^\x00-\x7F]/gu, '?');

  if (msg.length > 123) {
    msg = msg.slice(0, 120) + '...';
  }

  return msg;
}