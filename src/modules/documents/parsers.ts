/**
 * Pick the P-18 verify fields out of OCR text. OCR (Google Document AI) only turns the image into text;
 * these functions find the fields. Nothing here is trusted: every value is shown on the check screen for
 * the user to correct, and nothing is saved before Confirm (AC-P18-4). A value is only offered when it
 * looks right (an Aadhaar number must pass the Verhoeff check), so a misread is left empty, not wrong.
 * Returned values use the formats the Confirm form takes: dates DD-MM-YYYY, gender as a GENDERS code.
 */
import { verhoeffValid } from '../../lib/fields.js';

export type Parsed = Record<string, string | string[]>;

const lines = (text: string) => text.split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
/** Latin-only line: names are printed in English on PAN and Aadhaar (the Hindi line is skipped). */
const latin = (l: string) => /^[A-Za-z][A-Za-z .']*$/.test(l);
const titleCase = (s: string) => s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase()).replace(/\s+/g, ' ').trim();
/**
 * A date printed as DD/MM/YYYY (also with - or ., one-digit day or month, or spaces around the separators as OCR
 * often reads them), returned as YYYY-MM-DD: the format the check screen's date fields and the API take.
 * Nov 2026 fix: dates were returned as DD-MM-YYYY, which the date fields could not show, so the date of birth
 * looked "not read".
 */
const dateIn = (s: string) => {
  const m = /(?<!\d)(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*(\d{4})(?!\d)/.exec(s);
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (d < 1 || d > 31 || mo < 1 || mo > 12 || y < 1900 || y > 2100) return null;
  return `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
};
const DOB_LABEL = /(\bD\.?O\.?B\b|date\s*of\s*birth|birth\s*date|जन्म)/i;
/** Lines whose date is not the date of birth: issue / print / download dates. */
const NOT_DOB = /issue|issued|print|download|generated|valid|expiry/i;
/** The date of birth: a labelled line (or the line after the label), else the first date that is not an issue date. */
function findDob(ls: string[]): { at: number; value: string } | null {
  for (let i = 0; i < ls.length; i++) {
    if (!DOB_LABEL.test(ls[i]!)) continue;
    const here = dateIn(ls[i]!);
    if (here) return { at: i, value: here };
    const next = ls[i + 1] ? dateIn(ls[i + 1]!) : null;
    if (next) return { at: i + 1, value: next };
  }
  const i = ls.findIndex((l) => !NOT_DOB.test(l) && dateIn(l));
  return i >= 0 ? { at: i, value: dateIn(ls[i]!)! } : null;
}
const HEADER = /income tax|govt|government|india|permanent account|account number|signature|department|unique identification|authority|aadhaar|enrolment|address|vid|help|www|dob|date of birth|year of birth|male|female/i;

export function parsePan(text: string): Parsed {
  const ls = lines(text);
  const out: Parsed = {};
  const pan = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/.exec(text.toUpperCase());
  if (pan) out.pan = pan[1]!;
  const dob = findDob(ls);
  if (dob) out.dob = dob.value;
  const dobLine = dob?.at ?? -1;
  // New layout: labelled lines ("Name", "Father's Name"); the value is the next Latin line.
  const after = (label: RegExp) => {
    const i = ls.findIndex((l) => label.test(l));
    if (i < 0) return null;
    const v = ls.slice(i + 1, i + 4).find((l) => latin(l) && !HEADER.test(l));
    return v ? titleCase(v) : null;
  };
  const father = after(/father'?s?\s*name/i);
  const name = after(/(^|\/|\s)name\b(?!.*father)/i);
  if (name && !/father/i.test(name)) out.name = name;
  if (father) out.fatherName = father;
  // Old layout: no labels; the name and father's name are the first two Latin lines above the date of birth.
  if (!out.name && dobLine > 0) {
    const above = ls.slice(0, dobLine).filter((l) => latin(l) && !HEADER.test(l));
    if (above.length >= 2) { out.name = titleCase(above[above.length - 2]!); out.fatherName ??= titleCase(above[above.length - 1]!); }
    else if (above.length === 1) out.name = titleCase(above[0]!);
  }
  return out;
}

export function parseAadhaar(text: string): Parsed {
  const ls = lines(text).filter((l) => !/\bVID\b/i.test(l)); // a 16-digit VID must never be read as the Aadhaar
  const out: Parsed = {};
  for (const l of ls) {
    const m = /\b(\d{4})\s?(\d{4})\s?(\d{4})\b/.exec(l);
    if (m && !/\d{4}\s?\d{4}\s?\d{4}\s?\d{4}/.test(l)) {
      const n = `${m[1]}${m[2]}${m[3]}`;
      if (/^[2-9]/.test(n) && verhoeffValid(n)) { out.aadhaar = n; break; } // masked copies (XXXX XXXX 1234) never match
    }
  }
  const dob = findDob(ls);
  if (dob) out.dob = dob.value;
  const dobAt = dob?.at ?? -1;
  const g = /\b(FEMALE|MALE|TRANSGENDER)\b/i.exec(text);
  if (g) out.gender = g[1]!.toUpperCase();
  if (dobAt > 0) {
    const name = [...ls.slice(0, dobAt)].reverse().find((l) => latin(l) && !HEADER.test(l) && !DOB_LABEL.test(l) && l.split(' ').length <= 5);
    if (name) out.name = titleCase(name);
  }
  const address = aadhaarAddress(ls);
  if (address) out.address = address;
  if (!out.aadhaar && /\b[X*x]{4}\s?[X*x]{4}\s?\d{4}\b/.test(text)) out.aadhaarMasked = 'true'; // a masked copy: the number cannot be read
  return out;
}

/**
 * Aadhaar address (back side, or the front of an e-Aadhaar): the English text after "Address" up to and including
 * the line with the 6-digit PIN code. Hindi lines, the Aadhaar number, VID and help lines are left out.
 */
function aadhaarAddress(ls: string[]): string | null {
  const start = ls.findIndex((l) => /\baddress\b/i.test(l));
  if (start < 0) return null;
  const parts: string[] = [];
  const first = ls[start]!.replace(/^.*?\baddress\b\s*[:\-]?\s*/i, '');
  const take = (l: string) => {
    const clean = l.replace(/[^A-Za-z0-9,./()\-#&' ]/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[,.\-\s]+|[,\s]+$/g, '');
    if (clean && /[A-Za-z0-9]{2,}/.test(clean)) parts.push(clean);
  };
  if (first) take(first);
  for (const l of ls.slice(start + 1, start + 10)) {
    if (/\d{4}\s?\d{4}\s?\d{4}|\bVID\b|help|www\.|uidai|1947|enrol/i.test(l)) break;
    if (!/[A-Za-z0-9]/.test(l)) continue;
    take(l);
    if (/\b\d{6}\b/.test(l) || /\b\d{3}\s\d{3}\b/.test(l)) break; // the PIN code ends the address
  }
  const address = parts.join(', ').replace(/,\s*,/g, ',').trim();
  return address.length >= 10 ? address.slice(0, 300) : null;
}

const amount = (s: string | undefined) => (s ? s.replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '') : undefined);

export function parseOldPolicy(text: string): Parsed {
  const out: Parsed = {};
  const flat = text.replace(/\s+/g, ' ');
  const pol = /policy\s*(?:no|number|#)\.?\s*[:\-]?\s*([A-Z0-9][A-Z0-9/-]{2,39})/i.exec(flat);
  if (pol) out.policyNumber = pol[1]!.toUpperCase();
  const si = /sum\s*(?:insured|assured)[^\d₹]{0,30}₹?\s*(?:rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)/i.exec(flat);
  if (si) out.sumInsured = amount(si[1])!;
  const pr = /(?:total|net|gross)?\s*premium[^\d₹]{0,30}₹?\s*(?:rs\.?\s*)?([\d,]+(?:\.\d{1,2})?)/i.exec(flat);
  if (pr) out.premium = amount(pr[1])!;
  const period = /(?:period of insurance|policy period|from)\D{0,40}(\d{2}[/.-]\d{2}[/.-]\d{4}).{0,40}?(?:to|till|-)\D{0,20}(\d{2}[/.-]\d{2}[/.-]\d{4})/i.exec(flat);
  if (period) { const a = dateIn(period[1]!); const b = dateIn(period[2]!); if (a) out.startDate = a; if (b) out.endDate = b; }
  const issued = /(?:date of issue|issue date|issued on|policy issuance date)\D{0,20}(\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{4})/i.exec(flat);
  if (issued) { const d = dateIn(issued[1]!); if (d) out.issueDate = d; }
  return out;
}

/**
 * Change #48: the IRDAI licence or POSP certificate. Layouts differ by insurer, so only two values are looked for:
 * a number printed after "Licence / Certificate / Registration / Code No." and a "valid up to" date (YYYY-MM-DD,
 * as the advisor's profile stores it). Shown to the reviewer beside the typed values; never saved over them.
 */
export function parseLicence(text: string): Parsed {
  const t = text.replace(/\s+/g, ' ');
  const out: Parsed = {};
  const num = /\b(?:licen[cs]e|certificate|posp|agent)\s*(?:no\.?|number|code|id)\s*[:.\-]?\s*([A-Z0-9][A-Z0-9/-]{4,29})/i.exec(t);
  if (num) out.licenceNumber = num[1]!.toUpperCase().replace(/[/-]+$/, '');
  const valid = /valid(?:ity)?\s*(?:up\s*to|upto|till|until|to|from\s+\S+\s+to)?\s*[:.\-]?\s*(\d{2})[/.-](\d{2})[/.-](\d{4})/i.exec(t);
  if (valid) out.validUntil = `${valid[3]}-${valid[2]}-${valid[1]}`;
  return out;
}

export function parseFor(type: string, text: string): Parsed {
  if (type === 'PAN') return parsePan(text);
  if (type === 'Aadhaar') return parseAadhaar(text);
  if (type === 'Old policy') return parseOldPolicy(text);
  return {};
}