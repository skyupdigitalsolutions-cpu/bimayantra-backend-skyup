import { protect } from '../../lib/pii.js';
import { Schema, model } from 'mongoose';

/**
 * Audit entry (GR-30, P-50): who (or which system job), when, which record, old value, new value,
 * result, request ID. Append-only at the application layer; in production also grant the API's database
 * user insert+find only on this collection so MongoDB itself enforces it.
 */
const auditSchema = new Schema(
  {
    at: { type: Date, required: true },
    accountId: { type: String, default: null },
    actorUserId: { type: String, default: null },
    actorRole: { type: String, default: null },
    actorLabel: { type: String, default: null }, // system job (SYS-xx) or "anonymous"
    entity: { type: String, required: true },
    entityId: { type: String, default: null },
    entityRef: { type: String, default: null }, // record number people use (LD-…, CU-…)
    action: { type: String, required: true },
    before: { type: Schema.Types.Mixed, default: null },
    after: { type: Schema.Types.Mixed, default: null },
    result: { type: String, enum: ['SUCCESS', 'FAILED', 'REFUSED'], default: 'SUCCESS' },
    requestId: { type: String, default: null },
    ip: { type: String, default: null },
    device: { type: String, default: null }, // change #58: a short user-agent summary ("Chrome on Windows", "Bimayantra app on Android")
    stepUpId: { type: String, default: null }, // the OTP verification behind a sensitive action (P-48)
  },
  { versionKey: false },
);
auditSchema.index({ accountId: 1, at: -1 });
auditSchema.index({ entity: 1, entityId: 1, at: -1 });
auditSchema.index({ actorUserId: 1, at: -1 });

const blocked = function () { throw new Error('audit_log is append-only'); };
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  auditSchema.pre(op, blocked);
}
export const AuditLog = model('AuditLog', auditSchema, 'audit_log');
/** Snapshots hold names, emails and other personal data: stored encrypted, decrypted when the log is read. */
protect(AuditLog, { fields: { before: 'json', after: 'json' } });