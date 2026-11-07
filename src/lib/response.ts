import type { Response } from 'express';
import { msg, type MessageId, type MessageParams } from './messages.js';

/**
 * Response envelope (single point of change):
 *   success → { data, meta? }      meta.messageId/message carry the success message (GR-03), meta.page… for lists
 *   error   → { error: { code, messageId, message, requestId, fields?, details? } }
 */
export function sendData<T>(res: Response, data: T, status = 200, meta?: Record<string, unknown>) {
  res.status(status).json(meta ? { data, meta } : { data });
}

/** Success with the exact success message from Section 21 (for example LD-01 "Lead LD-2610-00001 created."). */
export function sendDone<T>(res: Response, data: T, messageId: MessageId, params: MessageParams = {}, status = 200, meta: Record<string, unknown> = {}) {
  sendData(res, data, status, { ...meta, messageId, message: msg(messageId, params) });
}

export function sendNoContent(res: Response) {
  res.status(204).end();
}

export function errorBody(e: { code: string; messageId: string; message: string; fields?: unknown; details?: unknown }, requestId: string) {
  return {
    error: {
      code: e.code,
      messageId: e.messageId,
      message: e.message,
      requestId,
      ...(e.fields === undefined ? {} : { fields: e.fields }),
      ...(e.details === undefined ? {} : { details: e.details }),
    },
  };
}
