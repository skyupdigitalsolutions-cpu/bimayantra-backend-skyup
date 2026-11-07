import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Change #55 (DEC-09): one review item per insurer + agent code saved in more than one account. Raised silently when
 * the second account saves the code (neither advisor is told); SkyUp resolves it:
 *  - BOTH_VALID: a shared POSP code, both keep it (RESOLVED);
 *  - REMOVED_FROM_ACCOUNT: that account's mapping is made INACTIVE and its advisor told (RESOLVED);
 *  - ASKED_ADVISORS: both advisors get the note as a bell item; the flag stays OPEN for the answer.
 * Every action is kept in `actions` with its note. A RESOLVED flag is final: if a further account saves the code
 * later, a new OPEN flag is raised.
 */
const actionSchema = new Schema(
  { type: { type: String, enum: ['BOTH_VALID', 'REMOVED_FROM_ACCOUNT', 'ASKED_ADVISORS'], required: true }, accountId: { type: String, default: null }, note: { type: String, required: true }, by: { type: String, required: true }, at: { type: Date, required: true } },
  { _id: false },
);
const flagSchema = new Schema(
  {
    _id: { type: String, default: () => newId('acf') },
    insurerId: { type: String, required: true },
    agentCode: { type: String, required: true },
    accountIds: { type: [String], default: [] },
    status: { type: String, enum: ['OPEN', 'RESOLVED'], default: 'OPEN' },
    raisedAt: { type: Date, required: true },
    resolution: { type: String, enum: ['BOTH_VALID', 'REMOVED_FROM_ACCOUNT', null], default: null },
    removedFromAccountId: { type: String, default: null },
    resolvedBy: { type: String, default: null },
    resolvedAt: { type: Date, default: null },
    actions: { type: [actionSchema], default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
/** At most one OPEN flag per insurer + code: two saves at once update the same item. */
flagSchema.index({ insurerId: 1, agentCode: 1 }, { unique: true, partialFilterExpression: { status: 'OPEN' }, name: 'one_open_flag_per_code' });
flagSchema.index({ status: 1, raisedAt: -1 });

export type AgentCodeFlagDoc = InferSchemaType<typeof flagSchema> & { _id: string; createdAt: Date };
export const AgentCodeFlag = model('AgentCodeFlag', flagSchema, 'agent_code_flags');