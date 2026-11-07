/**
 * The one source of "now" for business rules. NFR-13 requires a test-only clock override in
 * non-production so date-based rules (OTP expiry, trial end, read-only mode) can be tested.
 * The offset is only ever changed by the dev tools route, which does not exist in production.
 */
let offsetMs = 0;

export const clock = {
  now: () => new Date(Date.now() + offsetMs),
  nowMs: () => Date.now() + offsetMs,
  offsetMs: () => offsetMs,
  setOffset(ms: number) { offsetMs = ms; },
};

const IST_OFFSET_MS = 330 * 60_000; // UTC+05:30, no daylight saving

/** IST today as YYYY-MM-DD (GR-25: "today" always means IST today). */
export function istToday(at = clock.now()): string {
  return new Date(at.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** A moment shown as IST "DD-MM-YYYY hh:mm AM" (Section 1.2 date format, GR-25 12-hour times). */
export function istDateTime(at: Date): string {
  const d = new Date(at.getTime() + IST_OFFSET_MS);
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const h24 = d.getUTCHours();
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${dd}-${mm}-${d.getUTCFullYear()} ${String(h12).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`;
}

/** An ISO date (YYYY-MM-DD) shown as DD-MM-YYYY. */
export const istDate = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;

/** Age in completed years on a date (GR-38): always calculated by the server, never typed. */
export function ageOn(dobIso: string, onIso = istToday()): number {
  const [by, bm, bd] = dobIso.split('-').map(Number) as [number, number, number];
  const [oy, om, od] = onIso.split('-').map(Number) as [number, number, number];
  return oy - by - (om < bm || (om === bm && od < bd) ? 1 : 0);
}

/** "{time} IST" in AUTH-04 / AUTH-06: "03:45 PM", or "22-10-2026 03:45 PM" when it is not today. */
export function istTime(at: Date): string {
  const full = istDateTime(at);
  return istToday(at) === istToday() ? full.slice(11) : full;
}
