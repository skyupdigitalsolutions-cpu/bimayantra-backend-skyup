import { Schema, model } from 'mongoose';
import { logger } from '../lib/logger.js';
import { DEFAULT_OFFERED_SOURCES, offeredSourcesProblem } from '../lib/leadSources.js';

/**
 * CONFIGURATION SERVICE (Section 3.4–3.6, NFR-13: "All CFG values are read from one configuration service").
 *
 * Every business number lives here with the default written in the document. Code never types a number
 * that has a CFG ID; it calls cfg('CFG-xx'). A value changed by a SkyUp Admin (P-49, maker-checker, not yet
 * built) is stored in the config_values table and overrides the default from the next request.
 *
 * Only the values used by the modules built so far are registered. Add each new CFG here, with its
 * documented default, when the module that uses it is built.
 */
/** A min–max pair, for values the document writes as "2 to 200 characters". */
export interface CfgRange { min: number; max: number }
export type CfgValue = number | boolean | string | string[] | number[] | CfgRange | Record<string, number>;
interface CfgDef {
  label: string;
  unit?: 'digits' | 'seconds' | 'minutes' | 'hours' | 'days' | 'working days' | 'days before expiry' | 'characters' | 'years' | 'count' | 'per hour' | 'per minute' | 'MB' | '%' | 'rupees';
  value: CfgValue;
  change: 'ADM' | 'Release';
  /** Smallest and largest allowed values for numbers, used when an override is set. */
  range?: [number, number];
}

const DEFS = {
  'CFG-01': { label: 'OTP length', unit: 'digits', value: 6, change: 'Release', range: [4, 8] },
  'CFG-02': { label: 'OTP validity', unit: 'minutes', value: 5, change: 'ADM', range: [1, 30] },
  'CFG-03': { label: 'Wrong OTP tries per code', unit: 'count', value: 5, change: 'ADM', range: [1, 20] },
  'CFG-04': { label: 'Wait before resend', unit: 'seconds', value: 30, change: 'ADM', range: [0, 600] },
  'CFG-05': { label: 'OTP sends per mobile in any 60 minutes', unit: 'count', value: 5, change: 'ADM', range: [1, 100] },
  'CFG-06': { label: 'Lock time after CFG-03 or CFG-05 is reached', unit: 'minutes', value: 30, change: 'ADM', range: [1, 1440] },
  'CFG-07': { label: 'Session ends after no activity for', unit: 'minutes', value: 30, change: 'ADM', range: [3, 1440] },
  'CFG-08': { label: 'Longest session', unit: 'hours', value: 12, change: 'ADM', range: [1, 72] },
  'CFG-09': { label: 'Active sessions per user', unit: 'count', value: 3, change: 'ADM', range: [1, 20] },
  'CFG-10': { label: 'Registration and login requests per IP address per hour', unit: 'per hour', value: 20, change: 'ADM', range: [1, 100000] },
  'CFG-11': { label: 'Shortest name', unit: 'characters', value: 2, change: 'Release' },
  'CFG-12': { label: 'Longest name', unit: 'characters', value: 100, change: 'Release' },
  'CFG-13': { label: 'Longest notes', unit: 'characters', value: 1000, change: 'ADM', range: [100, 10000] },
  'CFG-14': { label: 'Oldest date of birth', unit: 'years', value: 120, change: 'Release' },
  'CFG-15': { label: 'Longest address line', unit: 'characters', value: 150, change: 'Release' },
  'CFG-23': { label: 'Rows per list page', unit: 'count', value: 25, change: 'ADM', range: [5, 200] },
  'CFG-24': { label: 'Search starts after', unit: 'characters', value: 3, change: 'ADM', range: [1, 10] },
  'CFG-33': {
    label: 'Lead lost reasons',
    value: ['Not interested', 'Bought elsewhere', 'Not reachable', 'Not eligible', 'Premium too high', 'Duplicate', 'Other'],
    change: 'ADM',
  },
  'CFG-35': { label: 'Family members per customer', unit: 'count', value: 15, change: 'ADM', range: [1, 100] },
  'CFG-36': {
    label: 'Relationship list',
    value: ['Spouse', 'Son', 'Daughter', 'Father', 'Mother', 'Father-in-law', 'Mother-in-law', 'Brother', 'Sister',
      'Grandfather', 'Grandmother', 'Grandson', 'Granddaughter', 'Other'],
    change: 'ADM',
  },
  'CFG-78': { label: 'Trial length', unit: 'days', value: 7, change: 'ADM', range: [1, 90] },
  'CFG-79': { label: 'Grace after subscription end', unit: 'days', value: 7, change: 'ADM', range: [0, 90] },
  'CFG-83': { label: 'Extra OTP before approve, publish, plan change, configuration change', value: true, change: 'Release' },
  'CFG-99': { label: 'Requests per user per minute', unit: 'per minute', value: 120, change: 'ADM', range: [10, 100000] },
  'CFG-16': { label: 'Largest amount', unit: 'rupees', value: 999999999.99, change: 'Release' },
  'CFG-25': { label: 'Search results shown', unit: 'count', value: 20, change: 'ADM', range: [5, 100] },
  'CFG-132': { label: 'Fewest digits to search a mobile number', unit: 'digits', value: 4, change: 'ADM', range: [3, 10] },
  'CFG-34': { label: 'Follow-up reminder before due time', unit: 'minutes', value: 30, change: 'ADM', range: [5, 1440] },
  'CFG-72': { label: 'Notifications kept in the bell', unit: 'days', value: 90, change: 'ADM', range: [7, 365] },
  'CFG-149': { label: 'Bell count shown up to (then "{n}+")', unit: 'count', value: 99, change: 'Release' },
  'CFG-150': { label: 'Highest product entry age that can be entered', unit: 'years', value: 99, change: 'Release' },
  'CFG-153': { label: 'Dependent-child entry band if the product sets none', unit: 'years', value: { min: 0, max: 25 }, change: 'ADM' },
  'CFG-58': { label: 'Longest policy period', unit: 'years', value: 100, change: 'Release' },
  'CFG-40': { label: 'Add-ons per product', unit: 'count', value: 30, change: 'ADM', range: [0, 100] },
  'CFG-53': { label: 'Nominees per policy (a product may set fewer)', unit: 'count', value: 4, change: 'ADM', range: [1, 10] },
  'CFG-62': { label: 'Grace period if the product does not set one', unit: 'days', value: 30, change: 'ADM', range: [0, 365] },
  'CFG-29': { label: 'Largest brochure for OCR', unit: 'MB', value: 20, change: 'ADM', range: [1, 50] },
  'CFG-39': { label: 'Rows in one rate table', unit: 'count', value: 20000, change: 'ADM', range: [100, 100000] },
  'CFG-30': { label: 'Most brochure pages for OCR (pages)', unit: 'count', value: 50, change: 'ADM', range: [1, 300] },
  'CFG-37': { label: 'OCR confidence below which a value is flagged', unit: '%', value: 85, change: 'ADM', range: [50, 99] },
  'CFG-102': { label: 'OCR switched on', value: true, change: 'ADM' },
  'CFG-168': { label: 'Best-fit weights: five each (budget, room rent, co-pay, waiting period, claim ratio) for Lowest premium, Best coverage, Claim reliability, Pre-existing condition', value: [50, 10, 10, 10, 20, 15, 30, 20, 20, 15, 15, 10, 10, 15, 50, 15, 10, 15, 45, 15], change: 'ADM' },
  'CFG-101': { label: 'AI-written explanation on', value: true, change: 'ADM' },
  'CFG-44': { label: 'Fewest products in a comparison', unit: 'count', value: 2, change: 'Release' },
  'CFG-45': { label: 'Most products in a comparison', unit: 'count', value: 3, change: 'ADM', range: [2, 5] },
  'CFG-46': { label: 'Quotation valid for (from the day it is first shared)', unit: 'days', value: 15, change: 'ADM', range: [1, 90] },
  'CFG-47': { label: 'Revisions per quotation', unit: 'count', value: 20, change: 'ADM', range: [1, 100] },
  'CFG-117': { label: 'Quotation share messages per advisor per day', unit: 'count', value: 100, change: 'ADM', range: [1, 1000] },
  'CFG-157': { label: 'Recommendation reason length', unit: 'characters', value: { min: 10, max: 500 }, change: 'ADM' },
  'CFG-49': { label: 'Remind advisor to update payment status after', unit: 'days', value: 2, change: 'ADM', range: [1, 30] },
  'CFG-50': { label: 'Payment attempts per quotation', unit: 'count', value: 5, change: 'ADM', range: [1, 20] },
  'CFG-51': { label: 'Receipt upload required when marking Paid', value: false, change: 'ADM' },
  'CFG-52': { label: 'Allowed difference between paid and quoted amount (₹)', unit: 'count', value: 0, change: 'ADM', range: [0, 100000] },
  'CFG-54': { label: 'Total of nominee shares (%)', unit: 'count', value: 100, change: 'Release' },
  'CFG-55': { label: 'Smallest share per nominee (%)', unit: 'count', value: 1, change: 'ADM', range: [1, 50] },
  'CFG-56': { label: 'Nominee needs an appointee under', unit: 'years', value: 18, change: 'Release' },
  'CFG-108': { label: 'Transaction reference length', unit: 'characters', value: { min: 4, max: 50 }, change: 'Release' },
  'CFG-166': { label: 'Premium payment modes', value: ['Insurer payment link', 'UPI', 'Net banking', 'Card', 'Cheque', 'Cash'], change: 'ADM' },
  'CFG-167': { label: 'Payment modes that need a reference number', value: ['Insurer payment link', 'UPI', 'Net banking', 'Card', 'Cheque'], change: 'ADM' },
  'CFG-174': { label: 'Health declaration questions (Health)', value: ['Pre-existing disease', 'Current medicines', 'Hospital stay in the last 4 years', 'Tobacco', 'Alcohol'], change: 'ADM' },
  'CFG-57': { label: 'Remind advisor to record the issued policy after', unit: 'days', value: 3, change: 'ADM', range: [1, 30] },
  'CFG-59': { label: 'Renewal becomes Due this many days before expiry', unit: 'days', value: 60, change: 'ADM', range: [1, 180] },
  'CFG-60': { label: 'Advisor renewal reminders, days before expiry', value: [60, 30, 15, 7, 1], change: 'ADM' },
  'CFG-61': { label: 'Customer renewal reminders, days before expiry (negative = after)', value: [30, 15, 7, 1, -1], change: 'ADM' },
  'CFG-63': { label: 'Daily renewal job time (IST hour)', unit: 'count', value: 8, change: 'ADM', range: [0, 23] },
  'CFG-69': { label: 'Automated WhatsApp messages per account per day', unit: 'count', value: 200, change: 'ADM', range: [1, 10000] },
  'CFG-70': { label: 'Emails per account per day', unit: 'count', value: 500, change: 'ADM', range: [1, 10000] },
  'CFG-137': { label: 'Missed reminder days still sent after a job outage', unit: 'days', value: 1, change: 'ADM', range: [0, 7] },
  'CFG-64': { label: 'WhatsApp sending window (IST hours, from–to)', value: { min: 9, max: 20 }, change: 'ADM' },
  'CFG-65': { label: 'Daily occasion job time (IST hour)', unit: 'count', value: 9, change: 'ADM', range: [0, 23] },
  'CFG-71': { label: 'Wait for a delivery update before showing Status unknown', unit: 'hours', value: 24, change: 'ADM', range: [1, 168] },
  'CFG-138': { label: 'Longest WhatsApp template body', unit: 'characters', value: 1024, change: 'Release' },
  'CFG-139': { label: 'Upcoming greetings shown', unit: 'days', value: 30, change: 'ADM', range: [1, 90] },
  'CFG-140': { label: 'Resends per message', unit: 'count', value: 1, change: 'ADM', range: [0, 5] },
  'CFG-162': { label: 'Wallet debit per automated WhatsApp message (paise)', unit: 'count', value: 100, change: 'ADM', range: [1, 10000] },
  'CFG-163': { label: 'Smallest wallet recharge (₹)', unit: 'count', value: 500, change: 'ADM', range: [1, 100000] },
  'CFG-164': { label: 'Low wallet balance alert below (₹)', unit: 'count', value: 100, change: 'ADM', range: [0, 100000] },
  'CFG-73': { label: 'Referral code length', unit: 'characters', value: 8, change: 'Release' },
  'CFG-74': { label: 'Referral code valid for', unit: 'days', value: 365, change: 'ADM', range: [1, 3650] },
  'CFG-75': { label: 'Referral form submissions per IP address per hour', unit: 'count', value: 5, change: 'ADM', range: [1, 100] },
  'CFG-76': { label: 'Active referrers per account', unit: 'count', value: 25, change: 'ADM', range: [1, 500] },
  'CFG-77': { label: 'Same mobile referred again within', unit: 'days', value: 30, change: 'ADM', range: [1, 365] },
  'CFG-103': { label: 'Referral feature switched on', value: true, change: 'ADM' },
  'CFG-141': { label: 'How the prospect knows the referrer', value: ['Family', 'Friend', 'Colleague', 'Neighbour', 'Customer of the advisor', 'Other'], change: 'ADM' },
  'CFG-80': { label: 'Subscription end reminders, days before', value: [15, 7, 1], change: 'ADM' },
  'CFG-81': { label: 'Read-only access after grace ends, then the account is archived', unit: 'days', value: 90, change: 'ADM', range: [1, 3650] },
  'CFG-82': { label: 'Plan prices in paise before GST: Normal monthly, Normal yearly, Premium monthly, Premium yearly', value: [49900, 499000, 99900, 999000], change: 'ADM' },
  'CFG-87': { label: 'Closed account data kept for', unit: 'years', value: 8, change: 'ADM', range: [1, 20] },
  'CFG-113': { label: 'Account export download valid for', unit: 'hours', value: 24, change: 'ADM', range: [1, 168] },
  'CFG-114': { label: 'Account exports per day', unit: 'count', value: 3, change: 'ADM', range: [1, 20] },
  'CFG-159': { label: 'Support grant valid for', unit: 'hours', value: 24, change: 'ADM', range: [1, 168] },
  'CFG-160': { label: 'GST on subscriptions (%)', unit: 'count', value: 18, change: 'Release' },
  'CFG-161': { label: 'Home state for GST (CGST + SGST inside it, IGST outside)', value: 'Karnataka', change: 'Release' },
  'CFG-165': { label: 'Dedicated WhatsApp number set-up target', unit: 'days', value: 5, change: 'ADM', range: [1, 30] },
  'CFG-178': { label: 'Trial ending reminders, days before', value: [3, 1], change: 'ADM' },
  'CFG-180': { label: 'Payment still unconfirmed after', unit: 'minutes', value: 30, change: 'ADM', range: [5, 1440] },
  'CFG-191': { label: 'A recording matches a call within', unit: 'minutes', value: 20, change: 'ADM', range: [1, 120] },
  'CFG-192': { label: 'Largest call recording', unit: 'MB', value: 50, change: 'ADM', range: [1, 200] },
  'CFG-193': { label: 'Call logs per sync request', unit: 'count', value: 500, change: 'Release' },
  'CFG-194': { label: 'Website form submissions per IP address per hour', unit: 'count', value: 30, change: 'ADM', range: [1, 1000] },
  'CFG-195': { label: 'Follow-up task for a new ad or form lead is due after', unit: 'minutes', value: 60, change: 'ADM', range: [5, 1440] },
  'CFG-196': { label: 'An old connection key keeps working after rotation for', unit: 'days', value: 7, change: 'ADM', range: [0, 30] },
  'CFG-38': { label: 'OCR job time limit', unit: 'minutes', value: 5, change: 'ADM', range: [1, 30] },
  'CFG-110': { label: 'Longest web address', unit: 'characters', value: 2048, change: 'Release' },
  'CFG-111': { label: 'Code length', unit: 'characters', value: { min: 2, max: 20 }, change: 'Release' },
  'CFG-107': { label: 'Policy number length', unit: 'characters', value: { min: 3, max: 40 }, change: 'Release' },
  'CFG-135': { label: 'Uploaded file kept before the form is saved', unit: 'hours', value: 24, change: 'ADM', range: [1, 168] },
  'CFG-154': { label: 'Fewest photos per vehicle', unit: 'count', value: 4, change: 'ADM', range: [1, 20] },
  'CFG-155': { label: 'Vehicle photo slots', value: ['Front', 'Rear', 'Left', 'Right', 'Odometer', 'Chassis number'], change: 'ADM' },
  'CFG-156': { label: 'Vehicles per client', unit: 'count', value: 10, change: 'ADM', range: [1, 100] },
  'CFG-171': { label: 'Document types', value: ['Aadhaar', 'PAN', 'Old policy', 'Vehicle RC', 'Vehicle photo', 'Medical report', 'Address proof', 'Income proof', 'Photo', 'Other'], change: 'ADM' },
  'CFG-172': { label: 'Document label length', unit: 'characters', value: { min: 2, max: 100 }, change: 'Release' },
  'CFG-181': { label: 'Earliest vehicle year of manufacture', unit: 'years', value: 1950, change: 'ADM' },
  'CFG-26': { label: 'Allowed file types', value: ['PDF', 'JPG', 'JPEG', 'PNG'], change: 'ADM' },
  'CFG-27': { label: 'Largest file', unit: 'MB', value: 10, change: 'ADM', range: [1, 50] },
  'CFG-28': { label: 'Files per upload', unit: 'count', value: 5, change: 'ADM', range: [1, 20] },
  'CFG-100': { label: 'KYC must be Verified before sharing a quotation', value: false, change: 'ADM' },
  'CFG-105': { label: 'Licence number length', unit: 'characters', value: { min: 3, max: 30 }, change: 'Release' },
  'CFG-106': { label: 'Agent code length', unit: 'characters', value: { min: 2, max: 30 }, change: 'Release' },
  'CFG-124': {
    label: 'Profile completion weights (total 100)',
    value: { Personal: 15, Contact: 20, Professional: 20, Business: 10, KYC: 20, Insurers: 15 },
    change: 'ADM',
  },
  'CFG-125': { label: 'KYC review target', unit: 'working days', value: 2, change: 'ADM', range: [1, 30] },
  'CFG-126': { label: 'Allowed image types (photos, logos)', value: ['JPG', 'JPEG', 'PNG'], change: 'ADM' },
  'CFG-127': { label: 'Largest image', unit: 'MB', value: 2, change: 'ADM', range: [1, 20] },
  'CFG-128': { label: 'Youngest advisor age', unit: 'years', value: 18, change: 'Release' },
  'CFG-129': { label: 'Profile milestones that create a notification', unit: '%', value: [50, 100], change: 'ADM' },
  'CFG-151': { label: 'Most years of experience that can be entered', unit: 'years', value: 60, change: 'Release' },
  'CFG-152': { label: 'Licence expiry warning starts', unit: 'days before expiry', value: 60, change: 'ADM', range: [1, 365] },
  'CFG-104': { label: 'Longest city name', unit: 'characters', value: 60, change: 'Release' },
  'CFG-109': { label: 'Short text length', unit: 'characters', value: { min: 2, max: 200 }, change: 'Release' },
  'CFG-112': { label: 'Longest email address', unit: 'characters', value: 254, change: 'Release' },
  'CFG-115': {
    label: 'Starting insurance types',
    value: ['Health', 'Term Life', 'Life Savings', 'Motor Private Car', 'Motor Two-wheeler', 'Travel', 'Personal Accident', 'Home'],
    change: 'ADM',
  },
  'CFG-122': { label: 'Referrer invitation valid for', unit: 'days', value: 7, change: 'ADM', range: [1, 90] },
  'CFG-123': { label: 'Idle logout warning shown before logout', unit: 'minutes', value: 2, change: 'ADM', range: [1, 30] },
  'CFG-130': { label: 'Items in dashboard task and activity lists', unit: 'count', value: 10, change: 'ADM', range: [1, 100] },
  // Change #17: stable CODES offered on the new-lead form, in screen order (labels in lib/leadSources.ts).
  'CFG-133': { label: 'Lead sources offered for a new lead (codes, in order)', value: DEFAULT_OFFERED_SOURCES, change: 'ADM' },
  'CFG-158': { label: 'Assistant users per Premium account', unit: 'count', value: 2, change: 'ADM', range: [0, 50] },
  'CFG-169': { label: 'Lead pipelines created at sign-up', value: ['Health', 'Motor', 'Life', 'Term', 'Travel', 'Other'], change: 'ADM' }, // change #18: Life and Term split
  'CFG-170': { label: 'Stages in every pipeline', value: ['New', 'Contacted', 'Qualified', 'Follow-up', 'Converted', 'Lost'], change: 'Release' },
  'CFG-173': { label: 'Features included in the trial', value: 'Everything except the dedicated WhatsApp number and automated WhatsApp messages', change: 'ADM' },
  'CFG-176': { label: 'A revealed Aadhaar or PAN is masked again after', unit: 'seconds', value: 30, change: 'ADM', range: [5, 300] },
} satisfies Record<string, CfgDef>;

export type CfgId = keyof typeof DEFS;

/** Values changed from the documented default. Written by P-49 (not yet built) or the dev tools. */
export const ConfigValue = model(
  'ConfigValue',
  new Schema({ _id: String, value: Schema.Types.Mixed, updatedBy: { type: String, default: null } }, { timestamps: true, versionKey: false }),
  'config_values',
);
const overrides = new Map<string, CfgValue>();

export function cfg(id: CfgId): CfgValue {
  return overrides.has(id) ? overrides.get(id)! : DEFS[id].value;
}
export const cfgNum = (id: CfgId) => cfg(id) as number;
export const cfgList = (id: CfgId) => cfg(id) as string[];
export const cfgBool = (id: CfgId) => cfg(id) as boolean;
export const cfgRange = (id: CfgId) => cfg(id) as CfgRange;
export const isCfgId = (id: string): id is CfgId => id in DEFS;

/** Every registered value with its default and current value (shown in the console's test tools). */
export function listCfg() {
  return (Object.entries(DEFS) as Array<[CfgId, CfgDef]>).map(([id, d]) => ({
    id, label: d.label, unit: d.unit ?? null, change: d.change, default: d.value, value: cfg(id), overridden: overrides.has(id),
  }));
}

/** Checks a proposed value has the same shape as the default and sits inside the allowed range. */
export function validateCfgValue(id: CfgId, value: unknown): string | null {
  if (id === 'CFG-133') return offeredSourcesProblem(value);
  const d: CfgDef = DEFS[id];
  if (typeof d.value === 'object' && !Array.isArray(d.value)) {
    const v = value as Partial<CfgRange> | null;
    return v && typeof v === 'object' && Number.isInteger(v.min) && Number.isInteger(v.max) && v.min! <= v.max! ? null : 'Must be { min, max } with min ≤ max.';
  }
  if (Array.isArray(d.value)) {
    if (typeof d.value[0] === 'number') return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'number' && Number.isFinite(v)) ? null : 'Must be a non-empty list of numbers.';
    return Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === 'string' && v.trim()) ? null : 'Must be a non-empty list of text values.';
  }
  if (typeof d.value !== typeof value) return `Must be a ${typeof d.value}.`;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return 'Must be a number.';
    if (d.range && (value < d.range[0] || value > d.range[1])) return `Enter a value from ${d.range[0]} to ${d.range[1]}.`;
  }
  return null;
}

export async function loadConfigOverrides() {
  const rows = await ConfigValue.find().lean<Array<{ _id: string; value: CfgValue }>>();
  overrides.clear();
  for (const r of rows) if (isCfgId(r._id) && validateCfgValue(r._id, r.value) === null) overrides.set(r._id, r.value);
}

let timer: NodeJS.Timeout | undefined;
/** Other API instances pick up a change within 30 seconds; the instance that made it applies it at once. */
export function startConfigRefresh() {
  timer ??= setInterval(() => {
    loadConfigOverrides().catch((err) => logger.warn({ err }, 'Configuration refresh failed; keeping current values'));
  }, 30_000);
  timer.unref();
}
export function stopConfigRefresh() {
  if (timer) clearInterval(timer);
  timer = undefined;
}