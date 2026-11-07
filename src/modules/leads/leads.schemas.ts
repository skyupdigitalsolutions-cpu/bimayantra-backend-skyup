import { z } from 'zod';
import {
  confirmations, editable, email, enumOf, fail, futureDateTime, lists, mobile, notes, oneOf, optional, personName, recordId, required, shortText, version,
} from '../../lib/fields.js';
import { pageQuery } from '../../lib/pagination.js';
import { sourceCodeOf } from '../../lib/leadSources.js';
import { customerExtrasBody } from '../customers/customers.schemas.js';
import { CONTACT_CHANNELS, CONTACT_OUTCOMES, PRIORITIES } from './lead.model.js';
import { LEAD_STATUSES } from './leadStatus.js';

export const labels = {
  pipelineId: 'Pipeline', name: 'Lead name', mobile: 'Primary mobile', altMobile: 'Alternate mobile', email: 'Email', source: 'Source',
  referrerId: 'Referrer', referredByCustomerId: 'Referred by client', campaign: 'Campaign name', interests: 'Insurance interest',
  priority: 'Priority', nextFollowUpAt: 'Next follow-up', notes: 'Notes', status: 'New status', lostReason: 'Lost reason', note: 'Note',
  outcome: 'Outcome', channel: 'Contact method', mode: 'Conversion', customerId: 'Customer', version: 'Version',
};

/**
 * Lead source: a stable code (META_ADS) or, from older clients, its label ("Meta Ads"); always a CODE after parsing.
 * Whether the code may be chosen (CFG-133, retired PAID_ADS) is checked in the service, which knows the lead's
 * current source.
 */
const leadSource = () => z.string({ invalid_type_error: 'VAL-22' }).max(60).transform((v, ctx) => sourceCodeOf(v) ?? fail(ctx, 'VAL-22'));

const interests = () => z.array(oneOf(lists.insuranceTypes)).max(20);

/** P-12 fields. Referrer / Referred by client / Campaign are required by source (checked in the service). */
export const createLeadBody = z.object({
  pipelineId: required(recordId('pip')),
  name: required(personName()),
  mobile: required(mobile()),
  altMobile: optional(mobile()),
  email: optional(email()),
  source: required(leadSource()),
  referrerId: optional(recordId('usr')),
  referredByCustomerId: optional(recordId('cus')),
  campaign: optional(shortText()),
  interests: interests().optional(),
  priority: optional(enumOf(PRIORITIES)),
  nextFollowUpAt: optional(futureDateTime()),
  notes: optional(notes()),
  confirm: confirmations(),
});

export const updateLeadBody = z.object({
  version: required(version()),
  pipelineId: editable(recordId('pip')),
  name: editable(personName()),
  mobile: editable(mobile()),
  altMobile: optional(mobile()),
  email: optional(email()),
  source: editable(leadSource()),
  referrerId: optional(recordId('usr')),
  referredByCustomerId: optional(recordId('cus')),
  campaign: optional(shortText()),
  interests: interests().optional(),
  priority: editable(enumOf(PRIORITIES)),
  nextFollowUpAt: optional(futureDateTime()),
  notes: optional(notes()),
  confirm: confirmations(),
});

export const statusBody = z.object({
  version: required(version()),
  status: required(enumOf(LEAD_STATUSES.filter((s) => s !== 'CONVERTED'))),
  nextFollowUpAt: optional(futureDateTime()),
  lostReason: optional(oneOf(lists.lostReasons)),
  note: optional(notes()),
});

export const contactBody = z.object({ outcome: required(enumOf(CONTACT_OUTCOMES)), channel: optional(enumOf(CONTACT_CHANNELS)), note: optional(notes()) });

/** P-14: "Link to existing" or "Create new customer", with the extra customer fields of the form. */
export const convertBody = z.object({
  version: required(version()),
  mode: required(enumOf(['CREATE', 'LINK'] as const)),
  customerId: optional(recordId('cus')),
  customer: customerExtrasBody.optional(),
  confirm: confirmations(),
});

export const leadIdParam = z.object({ id: z.string().regex(/^led_[a-f0-9]{28}$/) });
export const listLeadsQuery = z.object({
  ...pageQuery,
  pipelineId: recordId('pip').optional(),
  /** Change #19: one status or several, comma-separated (NEW,CONTACTED). */
  status: z.string().max(200).refine((v) => v.split(',').every((s) => (LEAD_STATUSES as readonly string[]).includes(s.trim())), { message: 'VAL-22' }).optional(),
  /** One source or several, comma-separated (codes or labels). */
  source: z.string().max(400).optional(),
  /** Follow-up due today (IST) or already overdue. */
  followUp: z.enum(['today', 'overdue']).optional(),
  /** Leads imported from one campaign connection (cnx_…) or one form (lfm_…). */
  campaignId: z.string().regex(/^(cnx|lfm)_[a-f0-9]{28}$/).optional(),
  priority: enumOf(PRIORITIES).optional(),
  search: z.string().trim().max(100).optional(),
});
/** Change #20: the lead timeline, optionally filtered by item type. */
export const TIMELINE_TYPES = ['CONTACT', 'STATUS', 'FOLLOW_UP', 'TASK', 'MESSAGE', 'QUOTATION', 'CALL'] as const;
export const timelineQuery = z.object({ types: z.string().max(200).refine((v) => v.split(',').every((t) => (TIMELINE_TYPES as readonly string[]).includes(t.trim())), { message: 'VAL-22' }).optional() });
export const duplicateQuery = z.object({ mobile: required(mobile()), name: optional(personName()), excludeId: optional(recordId('led')) });