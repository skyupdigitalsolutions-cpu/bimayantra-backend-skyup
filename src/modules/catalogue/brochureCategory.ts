/**
 * Which kind of insurance a brochure describes, from its OCR text (client requirement, Nov 2026): a Motor brochure
 * uploaded for a Health product must be stopped with "this brochure is not for this category" (OCR-09), instead of
 * being read against the wrong feature list.
 *
 * Plain keyword scoring, no AI request: each family has terms that are typical of it (strong = 2 points, weak = 1).
 * Every term counts once, however often it appears. The brochure is called the wrong category only when the evidence
 * is clear (CLEAR_SCORE and CLEAR_RATIO below); a short or mixed brochure is read as before. Car and two-wheeler are
 * told apart inside Motor; Term Life and Life Savings are one family (a term plan with return of premium talks about
 * maturity too, so telling them apart would refuse good brochures).
 *
 * PROVISIONAL (OPEN-QUESTIONS Q144): terms and thresholds; tune them with real brochures.
 */
import type { ProductFormCode } from './productForms.js';

export type Family = 'HEALTH' | 'MOTOR' | 'LIFE' | 'TRAVEL' | 'PERSONAL_ACCIDENT' | 'HOME';
export const FAMILY_OF: Record<ProductFormCode, Family | null> = {
  HEALTH: 'HEALTH', TERM_LIFE: 'LIFE', LIFE_SAVINGS: 'LIFE', MOTOR_CAR: 'MOTOR', MOTOR_TWO_WHEELER: 'MOTOR',
  TRAVEL: 'TRAVEL', PERSONAL_ACCIDENT: 'PERSONAL_ACCIDENT', HOME: 'HOME', GENERIC: null,
};

/** A clear call needs at least this score for the detected family … */
export const CLEAR_SCORE = 6;
/** … and the chosen family scoring at most this share of it. */
export const CLEAR_RATIO = 0.4;

type Terms = { strong: string[]; weak: string[] };
const TERMS: Record<Family, Terms> = {
  HEALTH: {
    strong: ['hospitali[sz]ation', 'room rent', 'pre-?existing (?:disease|illness|condition)', 'cashless (?:hospital|treatment)', 'day-? ?care (?:procedure|treatment)', 'ayush', 'domiciliary',
      'mediclaim', 'co-?pay(?:ment)?', 'maternity', 'network hospitals?', 'restoration of (?:the )?sum insured', 'health insurance', 'health check-?up', 'family floater', 'in-?patient', 'icu'],
    weak: ['health', 'medical expenses', 'waiting period', 'hospital', 'illness', 'opd'],
  },
  MOTOR: {
    strong: ['own damage', 'third[- ]party (?:liability|cover|only|insurance)', '\\bidv\\b', 'insured declared value', 'zero dep(?:reciation)?', 'engine protect(?:ion|or)?', 'roadside assistance',
      'motor insurance', 'motor vehicles? act', 'private car', 'two[- ]wheeler', 'garages?', 'return to invoice', 'registration (?:number|certificate)', 'chassis', 'ncb protect(?:ion)?', 'vehicle'],
    weak: ['no[- ]claim bonus', '\\bncb\\b', 'depreciation', 'motor', 'theft', 'driver'],
  },
  LIFE: {
    strong: ['life insurance', 'life assured', 'sum assured', 'death benefit', 'term plan', 'term insurance', 'premium payment term', 'maturity benefit', 'endowment', 'money[- ]back', '\\bulip\\b',
      'fund value', '\\bnav\\b', 'annuity', 'pension', 'surrender value', 'guaranteed additions', 'loyalty additions', 'terminal illness', 'return of premium', 'life cover', 'whole life'],
    weak: ['nominee', 'bonus', 'maturity', 'policyholder', 'tax benefit'],
  },
  TRAVEL: {
    strong: ['trip cancellation', 'overseas', 'baggage', 'passport', 'flight delay', 'schengen', '\\bvisa\\b', 'travel insurance', 'abroad', 'trip (?:delay|curtailment|interruption)', 'emergency evacuation', 'hijack'],
    weak: ['travel', 'trip', 'journey', 'airline'],
  },
  PERSONAL_ACCIDENT: {
    strong: ['accidental death', 'permanent total disab(?:lement|ility)', 'permanent partial disab(?:lement|ility)', 'temporary total disab(?:lement|ility)', 'personal accident', 'weekly (?:benefit|compensation)', 'occupation class'],
    weak: ['accident', 'disability', 'dismemberment'],
  },
  HOME: {
    strong: ['home insurance', 'householder', 'building structure', '(?:home|household) contents', 'burglary', 'earthquake', 'fire and allied', 'reinstatement value', 'alternate accommodation', 'loss of rent', 'dwelling'],
    weak: ['fire', 'flood', 'storm', 'house', 'property', 'jewellery'],
  },
};
const TWO_WHEELER = ['two[- ]wheelers?', '\\bbikes?\\b', 'motorcycles?', 'scooters?', 'scooty', 'moped'];
const CAR = ['private cars?', 'four[- ]wheelers?', '\\bcars?\\b', 'sedan', 'hatchback', '\\bsuvs?\\b'];

const compiled = (list: string[]) => list.map((t) => new RegExp(t.startsWith('\\b') ? t : `\\b${t}`, 'i'));
const COMPILED = Object.fromEntries((Object.keys(TERMS) as Family[]).map((f) => [f, { strong: compiled(TERMS[f].strong), weak: compiled(TERMS[f].weak) }])) as Record<Family, { strong: RegExp[]; weak: RegExp[] }>;
const hits = (text: string, list: RegExp[]) => list.filter((re) => re.test(text)).length;

export const FAMILY_LABEL: Record<Family, string> = { HEALTH: 'Health', MOTOR: 'Motor', LIFE: 'Life', TRAVEL: 'Travel', PERSONAL_ACCIDENT: 'Personal accident', HOME: 'Home' };
const FORM_LABEL: Partial<Record<ProductFormCode, string>> = { MOTOR_CAR: 'Motor (private car)', MOTOR_TWO_WHEELER: 'Motor (two-wheeler)' };

export interface Detected { family: Family | null; form: ProductFormCode | null; label: string | null; scores: Record<Family, number>; clear: boolean }

/** The family with the highest score (null when nothing scores), its form, and whether the call is clear. */
export function detectCategory(text: string): Detected {
  const t = (text ?? '').replace(/\s+/g, ' ');
  const scores = Object.fromEntries((Object.keys(COMPILED) as Family[]).map((f) => [f, hits(t, COMPILED[f].strong) * 2 + hits(t, COMPILED[f].weak)])) as Record<Family, number>;
  const ranked = (Object.keys(scores) as Family[]).sort((a, b) => scores[b] - scores[a]);
  const top = ranked[0]!;
  if (!scores[top]) return { family: null, form: null, label: null, scores, clear: false };
  const second = scores[ranked[1]!];
  let form: ProductFormCode;
  if (top === 'MOTOR') form = motorKind(t) ?? 'MOTOR_CAR';
  else if (top === 'LIFE') form = /\bterm (?:plan|insurance)|pure (?:protection|risk)|return of premium/i.test(t) ? 'TERM_LIFE' : 'LIFE_SAVINGS';
  else form = top as ProductFormCode;
  return { family: top, form, label: FORM_LABEL[form] ?? FAMILY_LABEL[top], scores, clear: scores[top] >= CLEAR_SCORE && second <= scores[top] * CLEAR_RATIO };
}

/** Car or two-wheeler, only when one side is mentioned and the other is not; null when unclear. */
export function motorKind(text: string): 'MOTOR_CAR' | 'MOTOR_TWO_WHEELER' | null {
  const bike = hits(text, compiled(TWO_WHEELER));
  const car = hits(text, compiled(CAR));
  if (bike >= 2 && car === 0) return 'MOTOR_TWO_WHEELER';
  if (car >= 2 && bike === 0) return 'MOTOR_CAR';
  return null;
}

/**
 * Does the brochure clearly belong to another category than the one chosen? Returns what it looks like, or null when it
 * fits, when the chosen category has no family (GENERIC: nothing to compare with) or when the evidence is not clear.
 */
export function categoryMismatch(chosen: ProductFormCode, text: string): Detected | null {
  const fam = FAMILY_OF[chosen];
  if (!fam) return null;
  const d = detectCategory(text);
  if (!d.family) return null;
  if (d.family !== fam) {
    const strongEnough = d.scores[d.family] >= CLEAR_SCORE && d.scores[fam] <= d.scores[d.family] * CLEAR_RATIO;
    return strongEnough ? d : null;
  }
  // Same family: only Motor is split (a car brochure for a two-wheeler category, or the other way round)
  if (fam === 'MOTOR') {
    const kind = motorKind((text ?? '').replace(/\s+/g, ' '));
    if (kind && kind !== chosen) return { ...d, form: kind, label: FORM_LABEL[kind]! };
  }
  return null;
}