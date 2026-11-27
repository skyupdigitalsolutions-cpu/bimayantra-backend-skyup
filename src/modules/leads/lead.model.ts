import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { STORED_MOBILE } from '../../lib/phone.js';
import { LEAD_STATUSES } from './leadStatus.js';
import { protect, searchIndexFields } from '../../lib/pii.js';

export const CONTACT_OUTCOMES = ['SPOKE_TO_CUSTOMER', 'NOT_REACHABLE', 'ASKED_TO_CALL_BACK'] as const;
/** Gap fix: how the contact happened (LS2 "How did you contact them?"). Optional; older rows have none. */
export const CONTACT_CHANNELS = ['CALL', 'WHATSAPP', 'EMAIL', 'MEETING'] as const;
export const CHANNEL_LABEL = { CALL: 'Call', WHATSAPP: 'WhatsApp', EMAIL: 'Email', MEETING: 'Meeting' } as const;
export const OUTCOME_LABEL = { SPOKE_TO_CUSTOMER: 'Spoke to customer', NOT_REACHABLE: 'Not reachable', ASKED_TO_CALL_BACK: 'Asked to call back' } as const;
export const PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

/**
 * Update after call (client change, Nov 2026). Each outcome says what happens to the lead:
 *   to: the status it moves to (when that move is allowed), lost: the lost reason, followUp: REQUIRED | OPTIONAL | NONE.
 * Retry outcomes keep the status (NEW becomes CONTACTED: a call was attempted) and need the retry date.
 */
export const CALL_OUTCOMES = {
  INTERESTED: { answered: true, label: 'Interested', to: 'QUALIFIED', followUp: 'OPTIONAL', contact: 'SPOKE_TO_CUSTOMER' },
  CALL_BACK: { answered: true, label: 'Call back', to: 'FOLLOW_UP', followUp: 'REQUIRED', contact: 'ASKED_TO_CALL_BACK' },
  WANTS_QUOTATION: { answered: true, label: 'Wants a quotation', to: 'QUALIFIED', followUp: 'OPTIONAL', contact: 'SPOKE_TO_CUSTOMER' },
  NOT_INTERESTED: { answered: true, label: 'Not interested', to: 'LOST', lost: 'Not interested', followUp: 'NONE', contact: 'SPOKE_TO_CUSTOMER' },
  ALREADY_INSURED: { answered: true, label: 'Already insured', to: 'LOST', lost: 'Already insured', followUp: 'OPTIONAL', contact: 'SPOKE_TO_CUSTOMER' },
  WRONG_PERSON: { answered: true, label: 'Wrong person', to: 'LOST', lost: 'Wrong person', followUp: 'NONE', contact: 'SPOKE_TO_CUSTOMER' },
  BUSY: { answered: false, label: 'Busy', to: null, followUp: 'REQUIRED', contact: 'NOT_REACHABLE' },
  NO_ANSWER: { answered: false, label: 'Ringing, no answer', to: null, followUp: 'REQUIRED', contact: 'NOT_REACHABLE' },
  SWITCHED_OFF: { answered: false, label: 'Switched off', to: null, followUp: 'REQUIRED', contact: 'NOT_REACHABLE' },
  NOT_REACHABLE: { answered: false, label: 'Not reachable', to: null, followUp: 'REQUIRED', contact: 'NOT_REACHABLE' },
  INVALID_NUMBER: { answered: false, label: 'Invalid number', to: 'LOST', lost: 'Invalid number', followUp: 'NONE', contact: 'NOT_REACHABLE' },
  WRONG_NUMBER: { answered: false, label: 'Wrong number', to: 'LOST', lost: 'Wrong number', followUp: 'NONE', contact: 'NOT_REACHABLE' },
} as const;
export type CallOutcome = keyof typeof CALL_OUTCOMES;
export const CALL_OUTCOME_CODES = Object.keys(CALL_OUTCOMES) as CallOutcome[];

/** Stage history: every move with who, when, from, to, reason and note (P-13 backend rules). */
const stageSchema = new Schema(
  { from: { type: String, default: null }, to: { type: String, required: true }, reason: { type: String, default: null },
    note: { type: String, default: null }, by: { type: String, default: null }, at: { type: Date, required: true } },
  { _id: false },
);
/** Contact log (P-13 step 2). */
const contactSchema = new Schema({
  _id: { type: String, default: () => newId('act') },
  outcome: { type: String, enum: CONTACT_OUTCOMES, required: true },
  /** Update after call (Nov 2026): answered or not, and the outcome the advisor picked (CALL_OUTCOMES). */
  answered: { type: Boolean, default: null },
  callOutcome: { type: String, default: null },
  channel: { type: String, enum: [...CONTACT_CHANNELS, null], default: null },
  note: { type: String, default: null },
  at: { type: Date, required: true },
  by: { type: String, required: true },
});

const leadSchema = new Schema(
  {
    _id: { type: String, default: () => newId('led') },
    accountId: { type: String, required: true },
    number: { type: String, required: true },
    pipelineId: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    mobile: { type: String, required: true, match: STORED_MOBILE },
    altMobile: { type: String, default: null },
    email: { type: String, default: null },
    /** The label shown when the lead was saved (kept for older clients, exports and reports). */
    source: { type: String, required: true },
    /** Stable code (lib/leadSources.ts); rules key on this. Null only on rows saved before the change-#17 migration. */
    sourceCode: { type: String, default: null },
    referrerUserId: { type: String, default: null },
    referredByCustomerId: { type: String, default: null },
    /** REFERRED_BY_OTHER (Nov 2026): the person who referred, typed (not a client or registered referrer). */
    referredByName: { type: String, default: null },
    referredByMobile: { type: String, default: null },
    campaign: { type: String, default: null },
    /** Module 17: where an imported lead came from (channel, connection, form, the platform's lead ID). */
    adRef: { type: Schema.Types.Mixed, default: null },
    /** The person withdrew the form on the ad platform (LinkedIn DELETED, Q97): their answers are cleared; the advisor keeps or removes the lead. */
    withdrawal: { type: new Schema({ at: Date, channel: String, decision: { type: String, enum: ['KEPT', null], default: null }, decidedAt: { type: Date, default: null } }, { _id: false }), default: null },
    interests: { type: [String], default: [] },
    priority: { type: String, enum: PRIORITIES, default: 'MEDIUM' },
    nextFollowUpAt: { type: Date, default: null },
    notes: { type: String, default: null },
    status: { type: String, enum: LEAD_STATUSES, default: 'NEW' },
    isOpen: { type: Boolean, default: true }, // not CONVERTED or LOST; drives the duplicate rule
    lostReason: { type: String, default: null },
    lostNote: { type: String, default: null },
    customerId: { type: String, default: null },
    convertedAt: { type: Date, default: null },
    createdBy: { type: String, required: true },
    stageHistory: { type: [stageSchema], default: [] },
    contacts: { type: [contactSchema], default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
leadSchema.add(searchIndexFields('name', 'mobile', 'email'));
leadSchema.index({ accountId: 1, number: 1 }, { unique: true });
leadSchema.index({ accountId: 1, 'searchIndex.name': 1 });
leadSchema.index({ accountId: 1, 'searchIndex.mobile': 1 });
leadSchema.index({ accountId: 1, 'searchIndex.email': 1 });
// Exact duplicate = same name and mobile in an open lead: a database rule (P-12, GR-12).
leadSchema.index({ accountId: 1, mobile: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { isOpen: true }, name: 'open_lead_exact_dup' });
leadSchema.index({ accountId: 1, createdAt: -1 });
leadSchema.index({ accountId: 1, pipelineId: 1, status: 1 });
leadSchema.index({ accountId: 1, mobile: 1 });
leadSchema.index({ accountId: 1, sourceCode: 1, createdAt: -1 });

export type LeadDoc = InferSchemaType<typeof leadSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Lead = model('Lead', leadSchema, 'leads');
/** Name, mobiles and email are encrypted in the database (lib/pii.ts); searchIndex holds the keyed search tokens. */
protect(Lead, {
  // adRef.externalId repeats the import key, which for website forms is built from the answers.
  fields: { name: 'name', nameKey: 'nameKey', mobile: 'mobile', altMobile: 'mobile', email: 'email', 'adRef.externalId': 'key', referredByName: 'name', referredByMobile: 'mobile' },
  search: { name: 'name', mobile: 'mobile', email: 'email' },
});