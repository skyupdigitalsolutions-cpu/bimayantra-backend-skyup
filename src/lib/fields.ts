import { z } from 'zod';
import { cfgList, cfgNum, cfgRange } from '../config/cfg.js';
import { clock, istToday } from './clock.js';
import type { MessageId } from './messages.js';
import { normalizeMobile } from './phone.js';
import type { IdPrefix } from './ids.js';

/**
 * FIELD FORMAT DICTIONARY (Section 2A). Each validator reports the exact message ID of its rule; the
 * validate() middleware turns those into field errors with the exact text (GR-03, GR-05).
 * CFG-based limits are read at validation time, so a changed configuration value applies at once.
 * Inputs are cleaned before checking (GR-06).
 */
type Ctx = z.RefinementCtx;
export const fail = (ctx: Ctx, messageId: MessageId, params?: Record<string, string | number>) => {
  ctx.addIssue({ code: 'custom', message: messageId, params });
  return z.NEVER;
};

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

/** Required field: missing or blank → GEN-01 "{Field label} is required." */
export const required = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToUndefined, s);
/** Optional field: missing → undefined (unchanged on edit); blank or null → null (cleared). */
export const optional = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToNull, s.nullable().optional());

const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;
const EMOJI = /\p{Extended_Pictographic}/u;

/** GR-06 for names: trim, collapse inner spaces, reject control characters and emoji. */
export const cleanName = (v: string) => v.trim().replace(/\s+/g, ' ');
/** Duplicate rule key (Section 7): same name ignoring case, spaces and dots. */
export const nameKey = (v: string) => v.toLowerCase().replace(/[\s.]/g, '');

// FLD-01
export const mobile = () =>
  z.string({ invalid_type_error: 'VAL-01' }).transform((v, ctx) => normalizeMobile(v) ?? fail(ctx, 'VAL-01'));

// FLD-02
export const personName = () =>
  z.string({ invalid_type_error: 'VAL-02' }).transform((raw, ctx) => {
    const v = cleanName(raw);
    const min = cfgNum('CFG-11');
    const max = cfgNum('CFG-12');
    const letters = (v.match(/\p{L}/gu) ?? []).length;
    const ok = v.length >= min && v.length <= max && !CONTROL.test(v) && !EMOJI.test(v)
      && /^\p{L}[\p{L}\p{M} .'-]*$/u.test(v) && letters >= 2;
    return ok ? v : fail(ctx, 'VAL-02');
  });

// FLD-03
export const email = () =>
  z.string({ invalid_type_error: 'VAL-03' }).transform((raw, ctx) => {
    const v = raw.trim().toLowerCase();
    const parts = v.split('@');
    const ok = v.length <= cfgNum('CFG-112') && !/\s/.test(v) && parts.length === 2
      && parts[0]!.length >= 1 && parts[0]!.length <= 64 && /^[^@]+\.[a-z]{2,}$/.test(parts[1]!) && !parts[1]!.startsWith('.')
      && !parts[1]!.includes('..');
    return ok ? v : fail(ctx, 'VAL-03');
  });

/** A real calendar date typed as YYYY-MM-DD (API) or DD-MM-YYYY (as typed on screen). Returns ISO. */
function parseDate(raw: string): string | null {
  const v = raw.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v) ?? null;
  const n = m ? null : /^(\d{2})-(\d{2})-(\d{4})$/.exec(v);
  const iso = m ? v : n ? `${n[3]}-${n[2]}-${n[1]}` : null;
  if (!iso) return null;
  const d = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === iso ? iso : null;
}

// FLD-04
export const date = () => z.string({ invalid_type_error: 'VAL-04' }).transform((v, ctx) => parseDate(v) ?? fail(ctx, 'VAL-04'));

// FLD-05
export const dateOfBirth = () =>
  z.string({ invalid_type_error: 'VAL-04' }).transform((v, ctx) => {
    const iso = parseDate(v);
    if (!iso) return fail(ctx, 'VAL-04');
    const today = istToday();
    if (iso > today) return fail(ctx, 'VAL-05');
    const oldest = `${Number(today.slice(0, 4)) - cfgNum('CFG-14')}${today.slice(4)}`;
    if (iso < oldest) return fail(ctx, 'VAL-06');
    return iso;
  });

// FLD-32 Past or today date (anniversary, issue date)
export const pastOrToday = () =>
  z.string({ invalid_type_error: 'VAL-04' }).transform((v, ctx) => {
    const iso = parseDate(v);
    if (!iso) return fail(ctx, 'VAL-04');
    return iso > istToday() ? fail(ctx, 'VAL-35') : iso;
  });

/** FLD-06 + FLD-27 together: a date and time later than now (follow-ups, P-12 / P-13). ISO 8601 with offset. */
export const futureDateTime = () =>
  z.string({ invalid_type_error: 'VAL-32' }).transform((v, ctx) => {
    const d = new Date(v);
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v) || Number.isNaN(d.getTime())) return fail(ctx, 'VAL-32');
    return d.getTime() > clock.nowMs() ? d : fail(ctx, 'DSH-24');
  });

// FLD-21
export const notes = () =>
  z.string({ invalid_type_error: 'VAL-21' }).transform((raw, ctx) => {
    const v = raw.trim();
    return v.length <= cfgNum('CFG-13') ? v : fail(ctx, 'VAL-21');
  });

// FLD-29 Short text (titles, labels, reasons)
export const shortText = () =>
  z.string({ invalid_type_error: 'VAL-34' }).transform((raw, ctx) => {
    const v = raw.trim().replace(/\s+/g, ' ');
    const { min, max } = cfgRange('CFG-109');
    return v.length >= min && v.length <= max && !CONTROL.test(v) ? v : fail(ctx, 'VAL-34');
  });

// FLD-11
export const addressLine = () =>
  z.string({ invalid_type_error: 'VAL-13' }).transform((raw, ctx) => {
    const v = raw.trim().replace(/\s+/g, ' ');
    return v.length >= 3 && v.length <= cfgNum('CFG-15') && /^[\p{L}\p{M}\p{N} ,./\-#&()']+$/u.test(v) ? v : fail(ctx, 'VAL-13');
  });

// FLD-12
export const city = () =>
  z.string({ invalid_type_error: 'VAL-14' }).transform((raw, ctx) => {
    const v = raw.trim().replace(/\s+/g, ' ');
    return v.length >= 2 && v.length <= cfgNum('CFG-104') && /^[\p{L}\p{M} .-]+$/u.test(v) ? v : fail(ctx, 'VAL-14');
  });

/** FLD-13: the fixed list of Indian states and union territories. */
export const INDIAN_STATES = [
  'Andhra Pradesh', 'Arunachal Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Goa', 'Gujarat', 'Haryana', 'Himachal Pradesh',
  'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra', 'Manipur', 'Meghalaya', 'Mizoram', 'Nagaland', 'Odisha',
  'Punjab', 'Rajasthan', 'Sikkim', 'Tamil Nadu', 'Telangana', 'Tripura', 'Uttar Pradesh', 'Uttarakhand', 'West Bengal',
  'Andaman and Nicobar Islands', 'Chandigarh', 'Dadra and Nagar Haveli and Daman and Diu', 'Delhi', 'Jammu and Kashmir',
  'Ladakh', 'Lakshadweep', 'Puducherry',
] as const;
export const state = () => oneOf(() => [...INDIAN_STATES]);

// FLD-14
export const pin = () =>
  z.string({ invalid_type_error: 'VAL-15' }).transform((raw, ctx) => {
    const v = raw.replace(/\s/g, '');
    return /^[1-9]\d{5}$/.test(v) ? v : fail(ctx, 'VAL-15');
  });

// FLD-15: 5 letters, 4 digits, 1 letter; the 4th letter is P for an individual.
export const pan = () =>
  z.string({ invalid_type_error: 'VAL-16' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    return /^[A-Z]{3}P[A-Z]\d{4}[A-Z]$/.test(v) ? v : fail(ctx, 'VAL-16');
  });

// FLD-33: 12 digits, first 2–9, last digit passes the Verhoeff check.
export const aadhaar = () =>
  z.string({ invalid_type_error: 'VAL-38' }).transform((raw, ctx) => {
    const v = raw.replace(/\s/g, '');
    return /^[2-9]\d{11}$/.test(v) && verhoeffValid(v) ? v : fail(ctx, 'VAL-38');
  });

/** FLD-20: the chosen value must be one of the current list (lists are CFG values, so read at check time). */
export const oneOf = (list: () => readonly string[]) =>
  z.string({ invalid_type_error: 'VAL-22' }).transform((v, ctx) => (list().includes(v) ? v : fail(ctx, 'VAL-22')));
export const enumOf = <T extends string>(values: readonly T[]) =>
  z.string({ invalid_type_error: 'VAL-22' }).transform((v, ctx) => ((values as readonly string[]).includes(v) ? (v as T) : fail(ctx, 'VAL-22')));
/** FLD-20 for a record chosen from a list: the ID format; existence and visibility are checked by the service. */
export const recordId = (prefix: IdPrefix) =>
  z.string({ invalid_type_error: 'VAL-22' }).regex(new RegExp(`^${prefix}_[a-f0-9]{28}$`), 'VAL-22');

// FLD-24 Declaration checkbox
export const declaration = () =>
  z.boolean({ invalid_type_error: 'VAL-29' }).transform((v, ctx) => (v === true ? true : fail(ctx, 'VAL-29')));

/** GR-11: the version the form loaded. */
export const version = () => z.number({ invalid_type_error: 'VAL-22' }).int().positive();

/** The idempotent "Save anyway" answer to a warning (LD-03, LD-04, CU-03, CU-21, CU-22). */
export const confirmations = () => z.array(z.string().regex(/^[A-Z]{2,4}-\d{2}$/)).max(10).default([]);

// ── Verhoeff checksum (used by Aadhaar, FLD-33) ──
const D = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 2, 3, 4, 0, 6, 7, 8, 9, 5], [2, 3, 4, 0, 1, 7, 8, 9, 5, 6], [3, 4, 0, 1, 2, 8, 9, 5, 6, 7],
  [4, 0, 1, 2, 3, 9, 5, 6, 7, 8], [5, 9, 8, 7, 6, 0, 4, 3, 2, 1], [6, 5, 9, 8, 7, 1, 0, 4, 3, 2], [7, 6, 5, 9, 8, 2, 1, 0, 4, 3],
  [8, 7, 6, 5, 9, 3, 2, 1, 0, 4], [9, 8, 7, 6, 5, 4, 3, 2, 1, 0],
];
const P = [
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], [1, 5, 7, 6, 2, 8, 3, 0, 9, 4], [5, 8, 0, 3, 7, 9, 6, 1, 4, 2], [8, 9, 1, 6, 0, 4, 3, 5, 2, 7],
  [9, 4, 5, 3, 1, 2, 6, 8, 7, 0], [4, 2, 8, 6, 5, 7, 3, 9, 0, 1], [2, 7, 9, 3, 8, 0, 6, 4, 1, 5], [7, 0, 4, 6, 9, 1, 3, 2, 5, 8],
];
export function verhoeffValid(digits: string): boolean {
  let c = 0;
  const rev = digits.split('').reverse().map(Number);
  for (let i = 0; i < rev.length; i++) c = D[c]![P[i % 8]![rev[i]!]!]!;
  return c === 0;
}
/** Appends the Verhoeff check digit (used by tests and the console to make valid sample numbers). */
export function verhoeffComplete(first11: string): string {
  for (let d = 0; d <= 9; d++) if (verhoeffValid(first11 + d)) return first11 + d;
  throw new Error('unreachable');
}

export const masks = {
  /** GR-36: PAN as ABCXX1234X. */
  pan: (v: string) => `${v.slice(0, 3)}XX${v.slice(5)}`,
  /** GR-36: Aadhaar as XXXX XXXX 1234. */
  aadhaar: (v: string) => `XXXX XXXX ${v.slice(-4)}`,
};

export const lists = {
  lostReasons: () => cfgList('CFG-33'),
  relationships: () => cfgList('CFG-36'),
  insuranceTypes: () => cfgList('CFG-115'),
  documentTypes: () => cfgList('CFG-171'),
  photoSlots: () => cfgList('CFG-155'),
  leadSources: () => cfgList('CFG-133'),
};

/** Edit forms: missing → unchanged; blank or null on a required field → GEN-01 (it cannot be cleared). */
export const editable = <T extends z.ZodTypeAny>(s: T) => z.preprocess(blankToNull, s.optional());


// ── Advisor profile fields (P-05) ──

// FLD-06 Future date: a real date, IST today or later.
export const todayOrLater = () =>
  z.string({ invalid_type_error: 'VAL-04' }).transform((v, ctx) => {
    const iso = parseDate(v);
    if (!iso) return fail(ctx, 'VAL-04');
    return iso < istToday() ? fail(ctx, 'VAL-07') : iso;
  });

// FLD-10 Whole number within the field's minimum and maximum.
export const wholeNumber = (minimum: number | (() => number), max: () => number) =>
  z.union([z.number(), z.string()], { invalid_type_error: 'VAL-12' }).transform((raw, ctx) => {
    const v = typeof raw === 'number' ? raw : raw.trim();
    const n = typeof v === 'number' ? v : /^\d+$/.test(v) ? Number(v) : NaN;
    const min = typeof minimum === 'function' ? minimum() : minimum; // read at request time (CFG may change)
    return Number.isInteger(n) && n >= min && n <= max() ? n : fail(ctx, 'VAL-12', { min, max: max() });
  });

// FLD-16 IRDAI licence or POSP certificate number: CFG-105 length; letters, digits, hyphen, slash; uppercased.
export const licenceNumber = () =>
  z.string({ invalid_type_error: 'VAL-17' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    const { min, max } = cfgRange('CFG-105');
    return v.length >= min && v.length <= max && /^[A-Z0-9/-]+$/.test(v) ? v : fail(ctx, 'VAL-17');
  });

/** GSTIN check character (FLD-34): the standard base-36 weighted checksum over the first 14 characters. */
export function gstinChecksumValid(g: string): boolean {
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const p = chars.indexOf(g[i]!) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(p / 36) + (p % 36);
  }
  return chars[(36 - (sum % 36)) % 36] === g[14];
}

// FLD-34 GSTIN: optional; uppercased; 2-digit state code, 10-character PAN, 1 letter or digit, Z, 1 check
// letter or digit. The BPD specifies the SHAPE only (its own example 29ABCDE1234F1Z5 fails the official check
// character), so the check character is not verified. OPEN-QUESTIONS Q25 proposes enforcing gstinChecksumValid().
export const gstin = () =>
  z.string({ invalid_type_error: 'VAL-39' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    return /^\d{2}[A-Z]{5}\d{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(v) ? v : fail(ctx, 'VAL-39');
  });

// FLD-17 Agent code: CFG-106 length; letters, digits, hyphen, slash; uppercased.
export const agentCode = () =>
  z.string({ invalid_type_error: 'VAL-18' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    const { min, max } = cfgRange('CFG-106');
    return v.length >= min && v.length <= max && /^[A-Z0-9/-]+$/.test(v) ? v : fail(ctx, 'VAL-18');
  });

// FLD-08 Amount in rupees: digits with optional Indian commas, up to 2 decimals; > 0 (or >= 0 where allowed); <= CFG-16.
export const rupees = (opts: { allowZero?: boolean } = {}) =>
  z.union([z.number(), z.string()], { invalid_type_error: 'VAL-09' }).transform((raw, ctx) => {
    const s = typeof raw === 'number' ? String(raw) : raw.trim().replace(/^₹\s*/, '');
    if (!/^(\d{1,3}(,\d{2,3})*|\d+)(\.\d{1,2})?$/.test(s)) return fail(ctx, 'VAL-09');
    const n = Number(s.replace(/,/g, ''));
    const min = opts.allowZero ? 0 : 0.01;
    const max = cfgNum('CFG-16');
    return n >= min && n <= max ? n : fail(ctx, 'VAL-10', { min: opts.allowZero ? 0 : 1, max });
  });

// FLD-19 Policy number: CFG-107 length; letters, digits, hyphen and slash; uppercased.
export const policyNumber = () =>
  z.string({ invalid_type_error: 'VAL-20' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    const { min, max } = cfgRange('CFG-107');
    return v.length >= min && v.length <= max && /^[A-Z0-9/-]+$/.test(v) ? v : fail(ctx, 'VAL-20');
  });

// FLD-37 Document label: CFG-172 characters after trimming; letters, digits, spaces and - _ . , ( ) /.
export const documentLabel = () =>
  z.string({ invalid_type_error: 'VAL-42' }).transform((raw, ctx) => {
    const v = raw.trim().replace(/\s+/g, ' ');
    const { min, max } = cfgRange('CFG-172');
    return v.length >= min && v.length <= max && /^[\p{L}\p{N} _.,()\/-]+$/u.test(v) ? v : fail(ctx, 'VAL-42');
  });

// FLD-35 Vehicle registration: uppercased, spaces and hyphens removed. Either 2 letters, 1 or 2 digits,
// 0 to 3 letters and 4 digits (KA01AB1234), or the Bharat series: 2 digits, BH, 4 digits, 1 or 2 letters (22BH1234AA).
export const vehicleRegistration = () =>
  z.string({ invalid_type_error: 'VAL-40' }).transform((raw, ctx) => {
    const v = raw.toUpperCase().replace(/[\s-]+/g, '');
    return /^[A-Z]{2}\d{1,2}[A-Z]{0,3}\d{4}$/.test(v) || /^\d{2}BH\d{4}[A-Z]{1,2}$/.test(v) ? v : fail(ctx, 'VAL-40');
  });

// FLD-27 Time of day: "10:30 AM" (shown as hh:mm AM/PM); 24-hour "14:30" is accepted too. Returns "HH:mm" (24h).
export const timeOfDay = () =>
  z.string({ invalid_type_error: 'VAL-32' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase().replace(/\s+/g, ' ');
    let m = /^(\d{1,2}):([0-5]\d) ?(AM|PM)$/.exec(v);
    if (m) {
      const h = Number(m[1]);
      if (h < 1 || h > 12) return fail(ctx, 'VAL-32');
      return `${String((h % 12) + (m[3] === 'PM' ? 12 : 0)).padStart(2, '0')}:${m[2]}`;
    }
    m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(v);
    return m ? `${m[1]!.padStart(2, '0')}:${m[2]}` : fail(ctx, 'VAL-32');
  });

// FLD-23 Web address: starts with https://, up to CFG-110, no spaces.
export const webAddress = () =>
  z.string({ invalid_type_error: 'VAL-28' }).transform((raw, ctx) => {
    const v = raw.trim();
    return /^https:\/\/[^\s]+\.[^\s]+$/i.test(v) && v.length <= cfgNum('CFG-110') ? v : fail(ctx, 'VAL-28');
  });

// FLD-28 Product or company code: CFG-111, uppercase letters, digits and hyphen (uppercased).
export const code = () =>
  z.string({ invalid_type_error: 'VAL-33' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    const { min, max } = cfgRange('CFG-111');
    return v.length >= min && v.length <= max && /^[A-Z0-9-]+$/.test(v) ? v : fail(ctx, 'VAL-33');
  });

// FLD-30 Indian phone: spaces and hyphens removed. Toll-free 1800/1860 + 7 digits; landline 0 + area code
// + number, 11 digits; or a mobile (FLD-01, stored +91).
export const phone = () =>
  z.string({ invalid_type_error: 'VAL-36' }).transform((raw, ctx) => {
    const v = raw.replace(/[\s-]+/g, '');
    if (/^18(00|60)\d{7}$/.test(v) || /^0\d{10}$/.test(v)) return v;
    const m = /^(?:\+?91)?([6-9]\d{9})$/.exec(v);
    return m ? `+91${m[1]}` : fail(ctx, 'VAL-36');
  });

// P-20 Payment link domain: a bare domain (insurer.com); subdomains of it are accepted at payment time.
export const bareDomain = () =>
  z.string({ invalid_type_error: 'CAT-10' }).transform((raw, ctx) => {
    const v = raw.trim().toLowerCase();
    return /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(v) ? v : fail(ctx, 'CAT-10');
  });

// FLD-09 Percentage: 0 to 100 with up to 2 decimals.
export const percent = () =>
  z.union([z.number(), z.string()], { invalid_type_error: 'VAL-11' }).transform((raw, ctx) => {
    const v = typeof raw === 'number' ? String(raw) : raw.trim();
    if (!/^\d{1,3}(\.\d{1,2})?$/.test(v)) return fail(ctx, 'VAL-11');
    const n = Number(v);
    return n >= 0 && n <= 100 ? n : fail(ctx, 'VAL-11');
  });

// FLD-31 IRDAI product UIN: uppercased letters and digits, CFG-105 length, no spaces.
export const uin = () =>
  z.string({ invalid_type_error: 'VAL-37' }).transform((raw, ctx) => {
    const v = raw.trim().toUpperCase();
    const { min, max } = cfgRange('CFG-105');
    return v.length >= min && v.length <= max && /^[A-Z0-9]+$/.test(v) ? v : fail(ctx, 'VAL-37');
  });