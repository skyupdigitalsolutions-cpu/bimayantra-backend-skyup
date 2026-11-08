/**
 * Category-specific product details (client requirement, Nov 2026).
 *
 * Every insurance type (category) has a PRODUCT FORM. The form decides which product fields the + Product screens show
 * and check, on top of the fields every product has (name, UIN, launch date, sum insured, policy terms, pricing, tax):
 *
 *  - `entryAges`: ADULT_CHILD (adult band + optional child band, e.g. Health), ADULT (adult band only, e.g. Term Life)
 *    or NONE (no entry ages: the vehicle or the property is insured, e.g. Motor, Home).
 *  - `labels`: what the shared fields are called for this category (Sum insured / Sum assured / IDV, Policy term /
 *    Policy period), and the words used in the CAT-13 "cannot be saved yet" list.
 *  - `fields`: the category's own details, stored on the product version as `data.details` ({ [key]: value }).
 *
 * The feature list (Coverage, Waiting periods…) still comes from the type's feature template (P-21); this registry is
 * the fixed product-details part. GENERIC keeps the behaviour from before this change (adult + child bands, no details),
 * so a category without a known form works exactly as it did.
 *
 * PROVISIONAL (OPEN-QUESTIONS Q141–Q143): the field lists and which of them are required to publish are a first draft
 * from common Indian retail products; the client should confirm them. Change a list here; nothing else needs to change.
 */
import type { MessageId } from '../../lib/messages.js';

export const PRODUCT_FORMS = ['HEALTH', 'TERM_LIFE', 'LIFE_SAVINGS', 'MOTOR_CAR', 'MOTOR_TWO_WHEELER', 'TRAVEL', 'PERSONAL_ACCIDENT', 'HOME', 'GENERIC'] as const;
export type ProductFormCode = (typeof PRODUCT_FORMS)[number];

export const DETAIL_TYPES = ['NUMBER', 'AMOUNT', 'PERCENT', 'YEARS', 'DAYS', 'TEXT', 'YES_NO', 'CHOICE', 'CHOICES', 'NUMBER_LIST'] as const;
export type DetailType = (typeof DETAIL_TYPES)[number];

export interface DetailField {
  key: string;
  label: string;
  type: DetailType;
  section: string;
  required?: boolean;
  options?: readonly string[];
  min?: number;
  max?: number;
  help?: string;
}
export interface ProductForm {
  code: ProductFormCode;
  label: string;
  entryAges: 'ADULT_CHILD' | 'ADULT' | 'NONE';
  /** Variants carry Individual / Floater only where the category has family cover. */
  variantCoverTypes: boolean;
  labels: { sumInsured: string; policyTerms: string; adultEntryAge: string };
  /** Words for the CAT-13 list when the shared field is missing. */
  missing: { sumInsured: string; policyTerms: string; adultEntryAge: string };
  sections: string[];
  fields: DetailField[];
}

const STD_MISSING = { sumInsured: 'sum insured options or range', policyTerms: 'policy term options', adultEntryAge: 'adult entry ages' };
const STD_LABELS = { sumInsured: 'Sum insured', policyTerms: 'Policy terms (years)', adultEntryAge: 'Adult entry age' };

const PREMIUM_PAYMENT = ['Regular pay', 'Limited pay', 'Single pay'] as const;

const MOTOR_COMMON = (vehicle: 'car' | 'two-wheeler'): DetailField[] => [
  { key: 'coverTypes', label: 'Cover types offered', type: 'CHOICES', section: 'Cover', required: true, options: ['Comprehensive', 'Third-party only', 'Standalone own damage', 'Bundled (1 year OD + long-term TP)'] },
  { key: 'vehicleCategories', label: vehicle === 'car' ? 'Car segments covered' : 'Two-wheeler kinds covered', type: 'CHOICES', section: 'Vehicle', options: vehicle === 'car' ? ['Hatchback', 'Sedan', 'SUV / MUV', 'Luxury'] : ['Scooter', 'Motorcycle', 'Electric two-wheeler'] },
  { key: 'fuelTypes', label: 'Fuel types covered', type: 'CHOICES', section: 'Vehicle', required: true, options: vehicle === 'car' ? ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'] : ['Petrol', 'Electric'] },
  { key: 'engineCcMin', label: vehicle === 'car' ? 'Smallest engine (cc)' : 'Smallest engine (cc)', type: 'NUMBER', section: 'Vehicle', min: 0, max: 10000 },
  { key: 'engineCcMax', label: 'Largest engine (cc)', type: 'NUMBER', section: 'Vehicle', min: 0, max: 10000 },
  { key: 'maxVehicleAgeYears', label: 'Oldest vehicle accepted', type: 'YEARS', section: 'Vehicle', required: true, min: 0, max: 50 },
  { key: 'maxNcbPercent', label: 'Highest no-claim bonus', type: 'PERCENT', section: 'Discounts' },
  { key: 'ncbProtection', label: 'NCB protection add-on available', type: 'YES_NO', section: 'Add-ons available' },
  { key: 'zeroDepreciation', label: 'Zero depreciation add-on available', type: 'YES_NO', section: 'Add-ons available' },
  { key: 'zeroDepMaxVehicleAge', label: 'Zero depreciation up to vehicle age', type: 'YEARS', section: 'Add-ons available', min: 0, max: 20 },
  { key: 'roadsideAssistance', label: 'Roadside assistance available', type: 'YES_NO', section: 'Add-ons available' },
  ...(vehicle === 'car' ? [
    { key: 'engineProtection', label: 'Engine protection add-on available', type: 'YES_NO', section: 'Add-ons available' } as DetailField,
    { key: 'returnToInvoice', label: 'Return to invoice add-on available', type: 'YES_NO', section: 'Add-ons available' } as DetailField,
  ] : []),
  { key: 'paOwnerDriverCover', label: 'PA cover for owner-driver', type: 'AMOUNT', section: 'Cover' },
  { key: 'cashlessGarages', label: 'Cashless garages', type: 'NUMBER', section: 'Network', min: 0, max: 100000 },
];

const LIFE_COMMON: DetailField[] = [
  { key: 'premiumPaymentOptions', label: 'Premium payment options', type: 'CHOICES', section: 'Premium', required: true, options: PREMIUM_PAYMENT },
  { key: 'premiumPaymentTerms', label: 'Premium payment terms (years)', type: 'NUMBER_LIST', section: 'Premium', min: 1, max: 100, help: 'For limited pay, e.g. 5, 10, 12' },
  { key: 'premiumFrequencies', label: 'Premium frequencies', type: 'CHOICES', section: 'Premium', options: ['Yearly', 'Half-yearly', 'Quarterly', 'Monthly'] },
  { key: 'maxMaturityAge', label: 'Highest age at maturity', type: 'YEARS', section: 'Eligibility', required: true, min: 1, max: 120 },
  { key: 'minAnnualIncome', label: 'Lowest annual income accepted', type: 'AMOUNT', section: 'Eligibility' },
  { key: 'medicalTests', label: 'Medical tests', type: 'TEXT', section: 'Eligibility', help: 'e.g. Not needed up to ₹50 lakh below age 45' },
];

const FORMS: Record<ProductFormCode, ProductForm> = {
  HEALTH: {
    code: 'HEALTH', label: 'Health', entryAges: 'ADULT_CHILD', variantCoverTypes: true,
    labels: STD_LABELS, missing: STD_MISSING,
    sections: ['Plan', 'Members', 'Cost sharing', 'Renewal', 'Network'],
    fields: [
      { key: 'planType', label: 'Plan type', type: 'CHOICE', section: 'Plan', options: ['Individual', 'Family floater', 'Senior citizen', 'Top-up', 'Super top-up', 'Critical illness', 'Disease-specific'] },
      { key: 'maxAdults', label: 'Most adults on one policy', type: 'NUMBER', section: 'Members', min: 1, max: 20 },
      { key: 'maxChildren', label: 'Most children on one policy', type: 'NUMBER', section: 'Members', min: 0, max: 20 },
      { key: 'deductible', label: 'Deductible (top-up / super top-up)', type: 'AMOUNT', section: 'Cost sharing' },
      { key: 'coPaymentPercent', label: 'Co-payment', type: 'PERCENT', section: 'Cost sharing' },
      { key: 'coPaymentFromAge', label: 'Co-payment applies from age', type: 'YEARS', section: 'Cost sharing', min: 0, max: 120 },
      { key: 'lifelongRenewal', label: 'Lifelong renewal', type: 'YES_NO', section: 'Renewal' },
      { key: 'portability', label: 'Portability accepted', type: 'YES_NO', section: 'Renewal' },
      { key: 'networkHospitals', label: 'Network hospitals', type: 'NUMBER', section: 'Network', min: 0, max: 100000 },
    ],
  },
  TERM_LIFE: {
    code: 'TERM_LIFE', label: 'Term life', entryAges: 'ADULT', variantCoverTypes: false,
    labels: { sumInsured: 'Sum assured', policyTerms: 'Policy terms (years)', adultEntryAge: 'Entry age' },
    missing: { sumInsured: 'sum assured options or range', policyTerms: 'policy term options', adultEntryAge: 'entry ages' },
    sections: ['Premium', 'Eligibility', 'Benefit'],
    fields: [
      ...LIFE_COMMON,
      { key: 'payoutOptions', label: 'Death benefit payout options', type: 'CHOICES', section: 'Benefit', required: true, options: ['Lump sum', 'Monthly income', 'Lump sum + monthly income', 'Increasing monthly income'] },
      { key: 'returnOfPremium', label: 'Return of premium variant', type: 'YES_NO', section: 'Benefit' },
      { key: 'smokerRatesDiffer', label: 'Separate rates for tobacco users', type: 'YES_NO', section: 'Premium' },
      { key: 'coverTillAge', label: 'Cover up to age (whole life)', type: 'YEARS', section: 'Benefit', min: 1, max: 120 },
    ],
  },
  LIFE_SAVINGS: {
    code: 'LIFE_SAVINGS', label: 'Life savings', entryAges: 'ADULT', variantCoverTypes: false,
    labels: { sumInsured: 'Sum assured', policyTerms: 'Policy terms (years)', adultEntryAge: 'Entry age' },
    missing: { sumInsured: 'sum assured options or range', policyTerms: 'policy term options', adultEntryAge: 'entry ages' },
    sections: ['Plan', 'Premium', 'Eligibility', 'Benefit'],
    fields: [
      { key: 'planType', label: 'Plan type', type: 'CHOICE', section: 'Plan', required: true, options: ['Endowment', 'Money-back', 'Guaranteed return', 'ULIP', 'Pension / annuity', 'Child plan', 'Whole life'] },
      ...LIFE_COMMON,
      { key: 'minAnnualPremium', label: 'Lowest annual premium', type: 'AMOUNT', section: 'Premium' },
      { key: 'lockInYears', label: 'Lock-in period', type: 'YEARS', section: 'Benefit', min: 0, max: 50 },
      { key: 'maturityBenefit', label: 'Maturity benefit', type: 'TEXT', section: 'Benefit', help: 'e.g. Sum assured + bonuses' },
      { key: 'participating', label: 'Participating (earns bonuses)', type: 'YES_NO', section: 'Benefit' },
      { key: 'fundOptions', label: 'Fund options (ULIP)', type: 'TEXT', section: 'Benefit' },
    ],
  },
  MOTOR_CAR: {
    code: 'MOTOR_CAR', label: 'Motor — private car', entryAges: 'NONE', variantCoverTypes: false,
    labels: { sumInsured: 'IDV range', policyTerms: 'Policy periods (years)', adultEntryAge: 'Owner age' },
    missing: { sumInsured: 'IDV options or range', policyTerms: 'policy period options', adultEntryAge: 'owner ages' },
    sections: ['Cover', 'Vehicle', 'Discounts', 'Add-ons available', 'Network'],
    fields: MOTOR_COMMON('car'),
  },
  MOTOR_TWO_WHEELER: {
    code: 'MOTOR_TWO_WHEELER', label: 'Motor — two-wheeler', entryAges: 'NONE', variantCoverTypes: false,
    labels: { sumInsured: 'IDV range', policyTerms: 'Policy periods (years)', adultEntryAge: 'Owner age' },
    missing: { sumInsured: 'IDV options or range', policyTerms: 'policy period options', adultEntryAge: 'owner ages' },
    sections: ['Cover', 'Vehicle', 'Discounts', 'Add-ons available', 'Network'],
    fields: MOTOR_COMMON('two-wheeler'),
  },
  TRAVEL: {
    code: 'TRAVEL', label: 'Travel', entryAges: 'ADULT_CHILD', variantCoverTypes: true,
    labels: { sumInsured: 'Sum insured', policyTerms: 'Policy terms (years)', adultEntryAge: 'Traveller entry age' },
    missing: STD_MISSING,
    sections: ['Trip', 'Cover'],
    fields: [
      { key: 'tripTypes', label: 'Trip types', type: 'CHOICES', section: 'Trip', required: true, options: ['Single trip', 'Annual multi-trip', 'Student', 'Domestic'] },
      { key: 'regions', label: 'Regions covered', type: 'CHOICES', section: 'Trip', required: true, options: ['Worldwide', 'Worldwide excluding USA and Canada', 'Asia', 'Schengen', 'India (domestic)'] },
      { key: 'maxTripDays', label: 'Longest trip', type: 'DAYS', section: 'Trip', required: true, min: 1, max: 3650 },
      { key: 'maxTravellers', label: 'Most travellers on one policy', type: 'NUMBER', section: 'Trip', min: 1, max: 50 },
      { key: 'currency', label: 'Sum insured currency', type: 'CHOICE', section: 'Cover', options: ['INR', 'USD', 'EUR'] },
      { key: 'medicalCover', label: 'Emergency medical cover', type: 'YES_NO', section: 'Cover' },
      { key: 'baggageCover', label: 'Baggage loss / delay cover', type: 'YES_NO', section: 'Cover' },
      { key: 'tripCancellation', label: 'Trip cancellation cover', type: 'YES_NO', section: 'Cover' },
      { key: 'adventureSports', label: 'Adventure sports covered', type: 'YES_NO', section: 'Cover' },
    ],
  },
  PERSONAL_ACCIDENT: {
    code: 'PERSONAL_ACCIDENT', label: 'Personal accident', entryAges: 'ADULT_CHILD', variantCoverTypes: true,
    labels: STD_LABELS, missing: STD_MISSING,
    sections: ['Cover', 'Eligibility'],
    fields: [
      { key: 'coverages', label: 'Covers', type: 'CHOICES', section: 'Cover', required: true, options: ['Accidental death', 'Permanent total disability', 'Permanent partial disability', 'Temporary total disability'] },
      { key: 'ttdWeeklyBenefit', label: 'Weekly benefit (temporary disability)', type: 'AMOUNT', section: 'Cover' },
      { key: 'incomeMultiple', label: 'Sum insured up to × annual income', type: 'NUMBER', section: 'Eligibility', min: 1, max: 1000 },
      { key: 'occupationClasses', label: 'Occupation classes accepted', type: 'CHOICES', section: 'Eligibility', options: ['Class I', 'Class II', 'Class III'] },
    ],
  },
  HOME: {
    code: 'HOME', label: 'Home', entryAges: 'NONE', variantCoverTypes: false,
    labels: { sumInsured: 'Sum insured', policyTerms: 'Policy terms (years)', adultEntryAge: 'Owner age' },
    missing: { sumInsured: 'sum insured options or range', policyTerms: 'policy term options', adultEntryAge: 'owner ages' },
    sections: ['Property', 'Cover'],
    fields: [
      { key: 'coverFor', label: 'Covers', type: 'CHOICES', section: 'Cover', required: true, options: ['Building structure', 'Home contents', 'Valuables and jewellery'] },
      { key: 'propertyTypes', label: 'Property types', type: 'CHOICES', section: 'Property', required: true, options: ['Independent house', 'Apartment / flat', 'Villa', 'Row house'] },
      { key: 'occupancy', label: 'For', type: 'CHOICES', section: 'Property', options: ['Owner', 'Tenant'] },
      { key: 'maxPropertyAgeYears', label: 'Oldest building accepted', type: 'YEARS', section: 'Property', min: 0, max: 200 },
      { key: 'valuationBasis', label: 'Valuation basis', type: 'CHOICE', section: 'Cover', options: ['Reinstatement value', 'Market value', 'Agreed value'] },
      { key: 'perils', label: 'Perils covered', type: 'CHOICES', section: 'Cover', options: ['Fire', 'Lightning', 'Earthquake', 'Flood and storm', 'Burglary and theft', 'Riot and strike'] },
    ],
  },
  GENERIC: {
    code: 'GENERIC', label: 'Other (no category details)', entryAges: 'ADULT_CHILD', variantCoverTypes: true,
    labels: STD_LABELS, missing: STD_MISSING, sections: [], fields: [],
  },
};

export const productForm = (code: string | null | undefined): ProductForm => FORMS[(code as ProductFormCode) ?? 'GENERIC'] ?? FORMS.GENERIC;

/**
 * The form a category gets when none is set: from its name. Order matters ("Term Life" is Term, "Motor Two-wheeler" is
 * a two-wheeler). Anything else is GENERIC.
 */
export function guessProductForm(name: string | null | undefined): ProductFormCode {
  const n = (name ?? '').toLowerCase();
  if (/two.?wheeler|\bbike\b|scooter|motorcycle/.test(n)) return 'MOTOR_TWO_WHEELER';
  if (/motor|\bcar\b|vehicle/.test(n)) return 'MOTOR_CAR';
  if (/\bterm\b/.test(n)) return 'TERM_LIFE';
  if (/life|endowment|ulip|saving|pension|annuity|money.?back/.test(n)) return 'LIFE_SAVINGS';
  if (/health|medical|mediclaim|critical|hospital/.test(n)) return 'HEALTH';
  if (/travel/.test(n)) return 'TRAVEL';
  if (/accident/.test(n)) return 'PERSONAL_ACCIDENT';
  if (/home|house|property|householder/.test(n)) return 'HOME';
  return 'GENERIC';
}

/** The type's form: the stored one, else from its name (types made before this change have none stored). */
export const formOfType = (t: { productForm?: string | null; name?: string | null } | null | undefined): ProductForm =>
  productForm(t?.productForm ?? guessProductForm(t?.name));

/** What the + Product screens need to draw the category's form. */
export const formView = (f: ProductForm) => ({
  code: f.code, label: f.label, entryAges: f.entryAges, variantCoverTypes: f.variantCoverTypes, labels: f.labels, sections: f.sections,
  fields: f.fields.map((x) => ({ key: x.key, label: x.label, type: x.type, section: x.section, required: !!x.required, options: x.options ? [...x.options] : null, min: x.min ?? null, max: x.max ?? null, help: x.help ?? null })),
});
export const formList = () => PRODUCT_FORMS.map((c) => ({ code: c, label: FORMS[c].label, fieldCount: FORMS[c].fields.length }));

type Problem = { field: string; messageId: MessageId; params?: Record<string, string | number> };
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && v.length === 0);

/**
 * Format checks on `data.details` for this form. Unknown keys and wrong values are field problems; empty values are
 * dropped from the clean copy. Completeness (required fields) is `missingDetails`, checked on publish only.
 */
export function checkDetails(form: ProductForm, details: Record<string, unknown> | null | undefined): { problems: Problem[]; clean: Record<string, unknown> } {
  const problems: Problem[] = [];
  const clean: Record<string, unknown> = {};
  const byKey = new Map(form.fields.map((f) => [f.key, f]));
  for (const [key, raw] of Object.entries(details ?? {})) {
    const f = byKey.get(key);
    const at = `details.${key}`;
    if (!f) { problems.push({ field: at, messageId: 'VAL-22' }); continue; }
    if (isEmpty(raw)) continue;
    const whole = (lo: number, hi: number) => {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < lo || raw > hi) { problems.push({ field: at, messageId: 'VAL-12', params: { min: lo, max: hi } }); return; }
      clean[key] = raw;
    };
    switch (f.type) {
      case 'NUMBER': whole(f.min ?? 0, f.max ?? 1_000_000); break;
      case 'AMOUNT': whole(f.min ?? 0, f.max ?? 1_000_000_000_000); break;
      case 'YEARS': whole(f.min ?? 0, f.max ?? 120); break;
      case 'DAYS': whole(f.min ?? 0, f.max ?? 3650); break;
      case 'PERCENT':
        if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 100 || Math.round(raw * 100) !== raw * 100) problems.push({ field: at, messageId: 'VAL-11' });
        else clean[key] = raw;
        break;
      case 'YES_NO':
        if (typeof raw !== 'boolean') problems.push({ field: at, messageId: 'VAL-22' }); else clean[key] = raw;
        break;
      case 'TEXT': {
        const s = typeof raw === 'string' ? raw.trim() : null;
        if (s === null || s.length > 500) problems.push({ field: at, messageId: 'VAL-22' }); else if (s) clean[key] = s;
        break;
      }
      case 'CHOICE':
        if (typeof raw !== 'string' || !f.options?.includes(raw)) problems.push({ field: at, messageId: 'VAL-22' }); else clean[key] = raw;
        break;
      case 'CHOICES': {
        const list = Array.isArray(raw) ? raw : null;
        if (!list || list.some((x) => typeof x !== 'string' || !f.options?.includes(x))) problems.push({ field: at, messageId: 'VAL-22' });
        else clean[key] = f.options!.filter((o) => list.includes(o)); // de-duplicated, in the form's order
        break;
      }
      case 'NUMBER_LIST': {
        const lo = f.min ?? 0; const hi = f.max ?? 1_000_000;
        const list = Array.isArray(raw) ? raw : null;
        if (!list || list.some((x) => typeof x !== 'number' || !Number.isInteger(x) || x < lo || x > hi)) problems.push({ field: at, messageId: 'VAL-12', params: { min: lo, max: hi } });
        else clean[key] = [...new Set(list as number[])].sort((a, b) => a - b);
        break;
      }
    }
  }
  // Pairs that must be in order (smallest ≤ largest)
  if (typeof clean.engineCcMin === 'number' && typeof clean.engineCcMax === 'number' && clean.engineCcMin > clean.engineCcMax) problems.push({ field: 'details.engineCcMax', messageId: 'CAT-16' });
  return { problems, clean };
}

/** Required category details that have no value (CAT-13 list entries, in the form's order). */
export const missingDetails = (form: ProductForm, details: Record<string, unknown> | null | undefined) =>
  form.fields.filter((f) => f.required && isEmpty((details ?? {})[f.key])).map((f) => f.label.charAt(0).toLowerCase() + f.label.slice(1));