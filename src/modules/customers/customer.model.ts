import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { STORED_MOBILE } from '../../lib/phone.js';
import { protect, searchIndexFields } from '../../lib/pii.js';

export const GENDERS = ['MALE', 'FEMALE', 'TRANSGENDER', 'PREFER_NOT_TO_SAY'] as const;
export const PREFERRED_CONTACTS = ['WHATSAPP', 'PHONE_CALL', 'EMAIL'] as const;
export const DEACTIVATION_REASONS = ['Moved to another advisor', 'Not reachable', 'Deceased', 'Duplicate record', 'Other'] as const;

/**
 * Customer (P-15). PAN and Aadhaar are encrypted field by field and never selected unless asked for (GR-36).
 * Name, mobiles and email are encrypted too (lib/pii.ts); searchIndex holds the keyed search tokens.
 */
const customerSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cus') },
    accountId: { type: String, required: true },
    number: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    dob: { type: String, default: null }, // YYYY-MM-DD, no time zone (GR-25)
    gender: { type: String, enum: [...GENDERS, null], default: null },
    mobile: { type: String, required: true, match: STORED_MOBILE },
    altMobile: { type: String, default: null },
    email: { type: String, default: null },
    preferredContact: { type: String, enum: [...PREFERRED_CONTACTS, null], default: null },
    address: {
      line1: { type: String, default: null }, line2: { type: String, default: null }, city: { type: String, default: null },
      state: { type: String, default: null }, pin: { type: String, default: null },
    },
    anniversary: { type: String, default: null },
    occupation: { type: String, default: null },
    source: { type: String, default: 'Direct' },
    /** The converted lead's source code (lib/leadSources.ts); null for customers added directly (source 'Direct'). */
    sourceCode: { type: String, default: null },
    leadId: { type: String, default: null },
    referrerUserId: { type: String, default: null },
    referredByCustomerId: { type: String, default: null },
    notes: { type: String, default: null },
    /** P-35 / B-01: pre-fills the nominee step of a proposal (POL-11 to POL-17 still apply there). */
    defaultNominee: {
      type: new Schema({ name: String, relationship: String, dob: String, appointeeName: { type: String, default: null }, appointeeDob: { type: String, default: null }, savedAt: Date }, { _id: false }),
      default: null,
    },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    statusReason: { type: String, default: null },
    statusNote: { type: String, default: null },
    identity: {
      panEnc: { type: String, default: null, select: false },
      panHash: { type: String, default: null },
      panMasked: { type: String, default: null },
      aadhaarEnc: { type: String, default: null, select: false },
      aadhaarHash: { type: String, default: null },
      aadhaarMasked: { type: String, default: null },
    },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
customerSchema.add(searchIndexFields('name', 'mobile', 'email'));
customerSchema.index({ accountId: 1, number: 1 }, { unique: true });
// Exact duplicate = same name and mobile as an ACTIVE customer (Section 7 rule, P-15).
customerSchema.index({ accountId: 1, mobile: 1, nameKey: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'active_customer_exact_dup' });
customerSchema.index({ accountId: 1, createdAt: -1 });
customerSchema.index({ accountId: 1, mobile: 1 });
customerSchema.index({ accountId: 1, 'identity.panHash': 1 });
customerSchema.index({ accountId: 1, 'searchIndex.name': 1 });
customerSchema.index({ accountId: 1, 'searchIndex.mobile': 1 });
customerSchema.index({ accountId: 1, 'searchIndex.email': 1 });

export type CustomerDoc = InferSchemaType<typeof customerSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const Customer = model('Customer', customerSchema, 'customers');
protect(Customer, {
  fields: { name: 'name', nameKey: 'nameKey', mobile: 'mobile', altMobile: 'mobile', email: 'email' },
  search: { name: 'name', mobile: 'mobile', email: 'email' },
});

/** Household roster (P-16). A member never becomes a nominee or insured person automatically. */
const familySchema = new Schema(
  {
    _id: { type: String, default: () => newId('fam') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    relationship: { type: String, required: true },
    dob: { type: String, default: null },
    gender: { type: String, enum: [...GENDERS, null], default: null },
    anniversary: { type: String, default: null },
    mobile: { type: String, default: null },
    email: { type: String, default: null },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
familySchema.add(searchIndexFields('name', 'mobile'));
familySchema.index({ accountId: 1, 'searchIndex.name': 1 });
familySchema.index({ accountId: 1, 'searchIndex.mobile': 1 });
familySchema.index({ customerId: 1, nameKey: 1, relationship: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'active_member_dup' });
familySchema.index({ accountId: 1, customerId: 1, status: 1 });
export type FamilyDoc = InferSchemaType<typeof familySchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const FamilyMember = model('FamilyMember', familySchema, 'family_members');
protect(FamilyMember, { fields: { name: 'name', nameKey: 'nameKey', mobile: 'mobile', email: 'email' }, search: { name: 'name', mobile: 'mobile' } });

/**
 * B-01 / PF2: another policy holder of the same account linked to this one (e.g. spouse who is also a customer).
 * One row per direction pair is kept (a-b); it is listed from either side.
 */
const linkSchema = new Schema(
  {
    _id: { type: String, default: () => newId('lnk') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    linkedCustomerId: { type: String, required: true },
    relationship: { type: String, required: true },
    createdBy: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
linkSchema.index({ accountId: 1, customerId: 1, linkedCustomerId: 1 }, { unique: true, name: 'one_link_per_pair' });
linkSchema.index({ accountId: 1, linkedCustomerId: 1 });
export type LinkDoc = InferSchemaType<typeof linkSchema> & { _id: string; createdAt: Date };
export const CustomerLink = model('CustomerLink', linkSchema, 'customer_links');

export const CONSENT_CHANNELS = ['WHATSAPP', 'EMAIL', 'SMS', 'PERSONAL_DATA'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];
/** Change #24 adds "Verbal on a call" and "Reply on WhatsApp or email"; the earlier values stay valid for existing records. */
export const HOW_GIVEN = ['Told me in person or by phone', 'Signed form', 'Replied on WhatsApp', 'Ticked on referral form', 'Verbal on a call', 'Reply on WhatsApp or email'] as const;
/** Written only by imports (Campaigns): a consent question in the form, ticked yes. */
export const IMPORT_HOW_GIVEN = ['Website form tick', 'Ad form tick'] as const;
export const WITHDRAW_REASONS = ['ASKED_TO_STOP', 'REPLIED_STOP', 'OTHER'] as const;

/**
 * Consent (P-17): one current record per person and channel, with every change kept in history.
 * personKey is 'C:<customer id>', 'F:<family member id>' or 'L:<lead id>' (copied to the customer on P-14).
 * PERSONAL_DATA is the customer's consent to store identity numbers and documents (GR-37).
 */
const consentChangeSchema = new Schema(
  {
    from: { type: String, default: null }, to: { type: String, required: true }, address: { type: String, default: null },
    howGiven: { type: String, default: null }, note: { type: String, default: null },
    source: { type: String, enum: ['USER', 'SYSTEM', 'LEAD_CONVERSION'], required: true },
    by: { type: String, default: null }, at: { type: Date, required: true },
  },
  { _id: false },
);
const consentSchema = new Schema(
  {
    _id: { type: String, default: () => newId('con') },
    accountId: { type: String, required: true },
    personKey: { type: String, required: true },
    customerId: { type: String, default: null },
    channel: { type: String, enum: CONSENT_CHANNELS, required: true },
    status: { type: String, enum: ['NOT_RECORDED', 'GIVEN', 'WITHDRAWN'], required: true },
    address: { type: String, default: null }, // the exact mobile or email it was given for
    howGiven: { type: String, default: null },
    /** Change #24: why consent was withdrawn, a note, and (personal-data consent) that the effects were understood. */
    evidenceFileId: { type: String, default: null }, // change #24: proof (e.g. the signed form), optional until the client decides (Q107)
    withdrawReason: { type: String, enum: [...WITHDRAW_REASONS, null], default: null }, withdrawNote: { type: String, default: null }, acknowledgedEffects: { type: Boolean, default: null },
    termsVersion: { type: String, default: null },
    recordedBy: { type: String, default: null },
    recordedAt: { type: Date, required: true },
    history: { type: [consentChangeSchema], default: [] },
    version: { type: Number, default: 1 },
  },
  { versionKey: false },
);
consentSchema.index({ accountId: 1, personKey: 1, channel: 1 }, { unique: true });
consentSchema.index({ accountId: 1, customerId: 1 });
export type ConsentDoc = InferSchemaType<typeof consentSchema> & { _id: string };
export const Consent = model('Consent', consentSchema, 'consents');
/** The mobile or email consent was given for, in the record and its history. */
protect(Consent, { fields: { address: 'contact', 'history.address': 'contact' } });