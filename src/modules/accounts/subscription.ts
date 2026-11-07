import { cfgNum } from '../../config/cfg.js';

type Stored = { status: string; plan?: string | null; endsAt: Date };
export type EffectiveStatus = 'TRIAL' | 'ACTIVE' | 'GRACE' | 'EXPIRED';

/**
 * The subscription status that applies right now (4.3). The daily job SYS-05 (not yet built) will move
 * stored statuses; until then this derives the same answer from the dates, so a trial that has ended is
 * read-only (GR-33) even before the job runs.
 */
export function effectiveStatus(sub: Stored, now: Date): EffectiveStatus {
  const t = now.getTime();
  const end = new Date(sub.endsAt).getTime();
  if (sub.status === 'EXPIRED') return 'EXPIRED';
  if (sub.status === 'TRIAL') return t < end ? 'TRIAL' : 'EXPIRED';
  if (t < end) return 'ACTIVE';
  return t < end + cfgNum('CFG-79') * 86_400_000 ? 'GRACE' : 'EXPIRED';
}

/** P-53: assistants need a TRIAL, or an ACTIVE or GRACE Premium subscription. */
/** Change #6: advisor brochure reading follows the same plan rule as assistants: Premium (and the trial). */
export const allowsBrochureReading = (status: EffectiveStatus, plan: string | null | undefined) => allowsAssistants(status, plan);
export const allowsAssistants = (status: EffectiveStatus, plan: string | null | undefined) =>
  status === 'TRIAL' || ((status === 'ACTIVE' || status === 'GRACE') && plan === 'PREMIUM');