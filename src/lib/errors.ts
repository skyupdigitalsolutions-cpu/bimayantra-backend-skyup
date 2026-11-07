import { msg, type MessageId, type MessageParams } from './messages.js';

/**
 * Every error the API intentionally returns goes through AppError, so each known cause has its own
 * stable code AND its own message ID from Section 21 (GR-05). GEN-99 is only for truly unknown causes.
 */
export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'UNAUTHENTICATED'
  | 'SESSION_ENDED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'REFRESH_TOKEN_REUSED'
  | 'FORBIDDEN'
  | 'SUPPORT_GRANT_REQUIRED'
  | 'READ_ONLY'
  | 'PLAN_REQUIRED'
  | 'STEP_UP_REQUIRED'
  | 'NOT_FOUND'
  | 'VERSION_CONFLICT'
  | 'INVALID_STATE'
  | 'DUPLICATE'
  | 'CONFIRMATION_REQUIRED'
  | 'ALREADY_SUBMITTED'
  | 'REQUEST_IN_PROGRESS'
  | 'IDEMPOTENCY_KEY_REUSED'
  | 'LIMIT_REACHED'
  | 'RATE_LIMITED'
  | 'PAYMENT_NOT_VERIFIED'
  | 'PAYMENT_NOT_CAPTURED'
  | 'GATEWAY_ERROR'
  | 'OTP_INCORRECT'
  | 'OTP_EXPIRED'
  | 'OTP_LOCKED'
  | 'OTP_SEND_LIMIT'
  | 'OTP_SEND_FAILED'
  | 'MOBILE_NOT_REGISTERED'
  | 'MOBILE_IN_USE'
  | 'ACCOUNT_SUSPENDED'
  | 'ACCOUNT_CLOSED'
  | 'USER_DISABLED'
  | 'INVITE_EXPIRED'
  | 'LAST_ADMIN'
  | 'SELF_ACTION'
  | 'CONSENT_REQUIRED'
  | 'INTERNAL_ERROR';

export interface FieldError { field: string; messageId: string; message: string }

export class AppError extends Error {
  public readonly messageId: MessageId;
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    messageId: MessageId,
    params: MessageParams = {},
    public readonly details?: unknown,
    public readonly fields?: FieldError[],
  ) {
    super(msg(messageId, params));
    this.name = 'AppError';
    this.messageId = messageId;
  }

  static forbidden() {
    return new AppError(403, 'FORBIDDEN', 'GEN-03');
  }
  /** 404 for a missing record AND for a record in another account: never reveal which (GR-18). */
  static notFound() {
    return new AppError(404, 'NOT_FOUND', 'GEN-11');
  }
  /** GR-21 / GR-19: the action is not allowed in the record's current state. */
  static invalidState(recordType: string, currentStatus: string, details?: unknown) {
    return new AppError(409, 'INVALID_STATE', 'GEN-04', { 'record type': recordType, 'current status': currentStatus }, details);
  }
  /** GR-11: the record changed since the form loaded it. `current` lets the form show what changed. */
  static versionConflict(recordType: string, current: unknown) {
    return new AppError(409, 'VERSION_CONFLICT', 'GEN-05', { 'record type': recordType }, { current });
  }
  /** One or more field errors (GR-03, Section 2.5): GEN-02 on top when there are two or more. */
  static fields(fields: Array<{ field: string; messageId: MessageId; params?: MessageParams }>) {
    const list: FieldError[] = fields.map((f) => ({ field: f.field, messageId: f.messageId, message: msg(f.messageId, f.params) }));
    if (list.length === 1) {
      const only = fields[0]!;
      return new AppError(400, 'VALIDATION_FAILED', only.messageId, only.params, undefined, list);
    }
    return new AppError(400, 'VALIDATION_FAILED', 'GEN-02', { count: list.length }, undefined, list);
  }
  static field(field: string, messageId: MessageId, params?: MessageParams) {
    return AppError.fields([{ field, messageId, params }]);
  }
}