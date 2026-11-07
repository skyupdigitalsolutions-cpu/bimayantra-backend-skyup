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
const dateIn = (s: string) => {
  const m = /\b(\d{2})[/.-](\d{2})[/.-](\d{4})\b/.exec(s);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null;
};
const HEADER = /income tax|govt|government|india|permanent account|account number|signature|department|unique identification|authority|aadhaar|enrolment|address|vid|help|www|dob|date of birth|year of birth|male|female/i;

export function parsePan(text: string): Parsed {
  const ls = lines(text);
  const out: Parsed = {};
  const pan = /\b([A-Z]{5}[0-9]{4}[A-Z])\b/.exec(text.toUpperCase());
  if (pan) out.pan = pan[1]!;
  const dobLine = ls.findIndex((l) => dateIn(l));
  if (dobLine >= 0) out.dob = dateIn(ls[dobLine]!)!;
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
  const dobLine = ls.findIndex((l) => /(DOB|date of birth|जन्म)/i.test(l) && dateIn(l));
  const dobAt = dobLine >= 0 ? dobLine : ls.findIndex((l) => dateIn(l));
  if (dobAt >= 0) out.dob = dateIn(ls[dobAt]!)!;
  const g = /\b(FEMALE|MALE|TRANSGENDER)\b/i.exec(text);
  if (g) out.gender = g[1]!.toUpperCase();
  if (dobAt > 0) {
    const name = [...ls.slice(0, dobAt)].reverse().find((l) => latin(l) && !HEADER.test(l) && l.split(' ').length <= 5);
    if (name) out.name = titleCase(name);
  }
  return out;
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
  if (period) { out.startDate = dateIn(period[1]!)!; out.endDate = dateIn(period[2]!)!; }
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