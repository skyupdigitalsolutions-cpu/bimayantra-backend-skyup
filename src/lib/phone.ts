/**
 * FLD-01 Indian mobile number: remove spaces, hyphens and brackets; remove a leading +91, 91 or 0;
 * what remains must be exactly 10 digits starting with 6, 7, 8 or 9. Stored as +91 followed by 10 digits.
 */
export const STORED_MOBILE = /^\+91[6-9]\d{9}$/;

export function normalizeMobile(raw: string): string | null {
  let v = raw.trim().replace(/[\s\-()]/g, '');
  if (v.startsWith('+91')) v = v.slice(3);
  else if (v.length === 12 && v.startsWith('91')) v = v.slice(2);
  else if (v.length === 11 && v.startsWith('0')) v = v.slice(1);
  return /^[6-9]\d{9}$/.test(v) ? `+91${v}` : null;
}

/** GR-31 masking: 98XXXXXX21 (first 2 and last 2 of the 10 digits). */
export function maskMobile(stored: string | null | undefined): string | null {
  if (!stored) return null;
  const d = stored.replace(/^\+91/, '');
  return `${d.slice(0, 2)}XXXXXX${d.slice(-2)}`;
}
