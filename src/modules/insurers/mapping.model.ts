import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * An advisor's insurer and agent code (P-07). One mapping per account and insurer: the unique rule
 * makes a duplicate save from two tabs keep exactly one (PRF-09 for the second). An INACTIVE mapping is
 * activated again rather than added twice ("Edit the existing entry instead").
 */
const mappingSchema = new Schema(
  {
    _id: { type: String, default: () => newId('map') },
    accountId: { type: String, required: true },
    insurerId: { type: String, required: true },
    agentCode: { type: String, required: true },
    validUntil: { type: String, default: null }, // YYYY-MM-DD; optional
    appointmentLetterFileId: { type: String, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    declaredAt: { type: Date, required: true },
    createdBy: { type: String, required: true },
    // DEC-09 [TO CONFIRM]: the same insurer + agent code in another account flags both for STF review,
    // silently (neither advisor is told).
    flaggedAt: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
export const MAPPING_UNIQUE_INDEX = 'one_mapping_per_account_insurer';
mappingSchema.index({ accountId: 1, insurerId: 1 }, { unique: true, name: MAPPING_UNIQUE_INDEX });
mappingSchema.index({ insurerId: 1, agentCode: 1 });
mappingSchema.index({ flaggedAt: 1 }, { partialFilterExpression: { flaggedAt: { $type: 'date' } } });

export type MappingDoc = InferSchemaType<typeof mappingSchema> & { _id: string };
export const InsurerMapping = model('InsurerMapping', mappingSchema, 'insurer_mappings');