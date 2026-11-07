import { z } from 'zod';
import {
  aadhaar, addressLine, city, confirmations, dateOfBirth, editable, email, enumOf, lists, mobile, notes, oneOf, optional, pan,
  pastOrToday, personName, pin, recordId, required, shortText, state, version,
} from '../../lib/fields.js';
import { pageQuery } from '../../lib/pagination.js';
import { CONSENT_CHANNELS, DEACTIVATION_REASONS, GENDERS, HOW_GIVEN, PREFERRED_CONTACTS, WITHDRAW_REASONS } from './customer.model.js';

export const labels = {
  name: 'Full name', mobile: 'Primary mobile', altMobile: 'Alternate mobile', email: 'Email', dob: 'Date of birth', gender: 'Gender',
  preferredContact: 'Preferred contact', addressLine1: 'Address line 1', addressLine2: 'Address line 2', city: 'City', state: 'State',
  pin: 'PIN code', anniversary: 'Wedding anniversary', occupation: 'Occupation', notes: 'Notes', reason: 'Reason', note: 'Note',
  relationship: 'Relationship', pan: 'PAN', aadhaar: 'Aadhaar number', howGiven: 'How it was given', declaration: 'Declaration',
  personType: 'Person', nominee: 'Nominee', linkedCustomerId: 'Policy holder', appointeeName: 'Appointee name', appointeeDob: 'Appointee date of birth', personId: 'Person', channel: 'Channel', action: 'Action', field: 'Field', version: 'Version', customerId: 'Customer',
};

/** P-15 optional fields, also used by the lead conversion form (P-14 step 3). */
export const customerExtrasBody = z.object({
  dob: optional(dateOfBirth()),
  gender: optional(enumOf(GENDERS)),
  altMobile: optional(mobile()),
  email: optional(email()),
  preferredContact: optional(enumOf(PREFERRED_CONTACTS)),
  addressLine1: optional(addressLine()),
  addressLine2: optional(addressLine()),
  city: optional(city()),
  state: optional(state()),
  pin: optional(pin()),
  anniversary: optional(pastOrToday()),
  occupation: optional(shortText()),
  notes: optional(notes()),
});
export type CustomerExtras = z.infer<typeof customerExtrasBody>;

export const createCustomerBody = customerExtrasBody.extend({ name: required(personName()), mobile: required(mobile()), confirm: confirmations() });
export const updateCustomerBody = customerExtrasBody.extend({ version: required(version()), name: editable(personName()), mobile: editable(mobile()), confirm: confirmations() });
export const statusBody = z.object({ version: required(version()), reason: optional(oneOf(() => [...DEACTIVATION_REASONS])), note: optional(notes()) });
export const identityBody = z.object({ version: required(version()), pan: optional(pan()), aadhaar: optional(aadhaar()) });
export const revealBody = z.object({ field: required(enumOf(['PAN', 'AADHAAR'] as const)) });

export const familyBody = z.object({
  name: required(personName()), relationship: required(oneOf(lists.relationships)), dob: optional(dateOfBirth()), gender: optional(enumOf(GENDERS)),
  anniversary: optional(pastOrToday()), mobile: optional(mobile()), email: optional(email()),
});
export const familyUpdateBody = familyBody.extend({ version: required(version()), name: editable(personName()), relationship: editable(oneOf(lists.relationships)) });
export const versionBody = z.object({ version: required(version()) });

export const consentBody = z.object({
  personType: required(enumOf(['CUSTOMER', 'FAMILY'] as const)),
  personId: required(z.string().regex(/^(cus|fam)_[a-f0-9]{28}$/, 'VAL-22')),
  channel: enumOf(CONSENT_CHANNELS).optional(),
  /** Change #24: several channels in one record; one consent row is still written per channel. */
  channels: z.array(enumOf(CONSENT_CHANNELS)).min(1).max(4).optional(),
  action: required(enumOf(['GIVE', 'WITHDRAW'] as const)),
  howGiven: optional(oneOf(() => [...HOW_GIVEN])),
  declaration: z.boolean().optional(),
  version: z.number().int().positive().optional(),
  evidenceFileId: z.string().regex(/^fil_[a-f0-9]{28}$/).nullish(),
  withdrawReason: z.enum(WITHDRAW_REASONS).nullish(),
  withdrawNote: z.string().trim().max(500).nullish(),
  acknowledgedEffects: z.boolean().optional(),
}).refine((b) => !!b.channel !== !!b.channels, { message: 'GEN-01', path: ['channel'] });

export const customerIdParam = z.object({ id: z.string().regex(/^cus_[a-f0-9]{28}$/) });
export const memberParams = z.object({ id: z.string().regex(/^cus_[a-f0-9]{28}$/), memberId: z.string().regex(/^fam_[a-f0-9]{28}$/) });
export const listCustomersQuery = z.object({ ...pageQuery, status: z.enum(['ACTIVE', 'INACTIVE']).optional(), search: z.string().trim().max(100).optional() });
export const duplicateQuery = z.object({ mobile: required(mobile()), name: optional(personName()), excludeId: optional(recordId('cus')) });

/** B-01 default nominee: PUT with { version, nominee } — nominee null removes it. */
export const defaultNomineeBody = z.object({
  version: required(version()),
  nominee: z.object({
    name: required(personName()), relationship: required(oneOf(lists.relationships)), dob: required(dateOfBirth()),
    appointeeName: optional(personName()), appointeeDob: optional(dateOfBirth()),
  }).strict().nullable(),
}).strict();
export const linkBody = z.object({ linkedCustomerId: required(recordId('cus')), relationship: required(oneOf(lists.relationships)) }).strict();
export const linkParams = z.object({ id: z.string().regex(/^cus_[a-f0-9]{28}$/), linkId: z.string().regex(/^lnk_[a-f0-9]{28}$/) });