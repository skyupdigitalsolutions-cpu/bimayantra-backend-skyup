/**
 * Starting feature templates for the starting insurance types (CFG-115), so each category has its features from day one
 * and + Product lists them as soon as the category is chosen.
 *
 * The starting types are created on first use with NO template (types.service ensureStartingTypes), and a type without
 * an ACTIVE template cannot take products (+ Product refuses it with VAL-22; + My product does not list it). This fills
 * that gap: for every SkyUp starting type that has no template version at all, version 1 is created ACTIVE with the
 * features and rating factors below. A type that already has any version (draft, live or retired) is never touched, so
 * running it again is safe and nothing an admin built is overwritten. Admins edit these like any template (P-21).
 *
 * PROVISIONAL (OPEN-QUESTIONS Q143): feature lists, rating factors and bands are a first draft for SkyUp to review.
 */
import { newId } from '../../lib/ids.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { InsuranceType, TemplateVersion, type FACTOR_SOURCES, type FEATURE_GROUPS, type DATA_TYPES } from './types.model.js';
import { formOfType, type ProductFormCode } from './productForms.js';
import { ensureStartingTypes } from './types.service.js';

type Group = (typeof FEATURE_GROUPS)[number];
type DataType = (typeof DATA_TYPES)[number];
type Source = (typeof FACTOR_SOURCES)[number];
interface F { key: string; name: string; group: Group; dataType: DataType; requiredToPublish?: boolean; help?: string }
interface Fa { key: string; name: string; kind: 'BAND' | 'VALUE'; source: Source; bands?: Array<{ from: number; to: number }>; values?: string[] }
interface Q { key: string; label: string; dataType: DataType; required: boolean }
export interface DefaultTemplate { features: F[]; factors: Fa[]; questions: Q[] }

const yes = (key: string, name: string, group: Group, requiredToPublish = false): F => ({ key, name, group, dataType: 'Yes/No', requiredToPublish });

const MOTOR = (cc: string[]): DefaultTemplate => ({
  features: [
    yes('own_damage', 'Own damage cover', 'Coverage', true),
    yes('third_party', 'Third-party liability', 'Coverage', true),
    { key: 'tp_property_limit', name: 'Third-party property damage limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹' },
    yes('zero_dep', 'Zero depreciation', 'Benefits'),
    yes('ncb_protect', 'NCB protection', 'Benefits'),
    yes('roadside', 'Roadside assistance', 'Benefits'),
    yes('consumables', 'Consumables cover', 'Benefits'),
    yes('engine_protect', 'Engine protection', 'Benefits'),
    yes('return_invoice', 'Return to invoice', 'Benefits'),
    { key: 'pa_owner', name: 'PA cover for owner-driver', group: 'Coverage', dataType: 'Amount in ₹' },
    yes('pa_passengers', 'PA cover for passengers', 'Coverage'),
    { key: 'compulsory_deductible', name: 'Compulsory deductible', group: 'Limits and sub-limits', dataType: 'Amount in ₹' },
    { key: 'cashless_garages', name: 'Cashless garages', group: 'Other', dataType: 'Number' },
    { key: 'claim_settlement', name: 'Claim settlement ratio', group: 'Other', dataType: 'Percentage' },
    { key: 'exclusions', name: 'Main exclusions', group: 'Exclusions', dataType: 'Text', help: 'e.g. Drunk driving, no valid licence, wear and tear' },
  ],
  factors: [
    { key: 'engine_cc', name: 'Engine capacity', kind: 'VALUE', source: 'Asked in the quotation', values: cc },
    { key: 'vehicle_age', name: 'Vehicle age', kind: 'VALUE', source: 'Asked in the quotation', values: ['Up to 1 year', '1 to 3 years', '3 to 5 years', 'Above 5 years'] },
  ],
  questions: [
    { key: 'engine_cc', label: 'Engine capacity', dataType: 'Text', required: true },
    { key: 'vehicle_age', label: 'Vehicle age', dataType: 'Text', required: true },
  ],
});

const LIFE_FEATURES: F[] = [
  yes('death_benefit', 'Death benefit', 'Coverage', true),
  yes('terminal_illness', 'Terminal illness benefit', 'Benefits'),
  yes('accidental_death_rider', 'Accidental death rider', 'Benefits'),
  yes('critical_illness_rider', 'Critical illness rider', 'Benefits'),
  yes('waiver_of_premium', 'Waiver of premium', 'Benefits'),
  { key: 'grace_period', name: 'Grace period', group: 'Waiting periods', dataType: 'Days' },
  { key: 'free_look', name: 'Free-look period', group: 'Waiting periods', dataType: 'Days' },
  { key: 'suicide_exclusion', name: 'Suicide exclusion period', group: 'Exclusions', dataType: 'Months' },
  { key: 'claim_settlement', name: 'Claim settlement ratio', group: 'Other', dataType: 'Percentage' },
  yes('tax_benefit', 'Tax benefit (80C / 10(10D))', 'Other'),
];

export const DEFAULT_TEMPLATES: Partial<Record<ProductFormCode, DefaultTemplate>> = {
  HEALTH: {
    features: [
      { key: 'room_rent', name: 'Room rent limit', group: 'Limits and sub-limits', dataType: 'Text', requiredToPublish: true, help: 'e.g. Single private room, or ₹5,000 a day' },
      { key: 'icu_limit', name: 'ICU limit', group: 'Limits and sub-limits', dataType: 'Text' },
      { key: 'co_payment', name: 'Co-payment', group: 'Limits and sub-limits', dataType: 'Percentage' },
      { key: 'initial_wait', name: 'Initial waiting period', group: 'Waiting periods', dataType: 'Days', requiredToPublish: true },
      { key: 'ped_wait', name: 'Pre-existing disease waiting period', group: 'Waiting periods', dataType: 'Months', requiredToPublish: true },
      { key: 'specific_illness_wait', name: 'Specific illness waiting period', group: 'Waiting periods', dataType: 'Months' },
      yes('maternity', 'Maternity cover', 'Coverage'),
      { key: 'maternity_wait', name: 'Maternity waiting period', group: 'Waiting periods', dataType: 'Months' },
      { key: 'pre_hosp', name: 'Pre-hospitalisation', group: 'Coverage', dataType: 'Days' },
      { key: 'post_hosp', name: 'Post-hospitalisation', group: 'Coverage', dataType: 'Days' },
      yes('day_care', 'Day-care procedures', 'Coverage'),
      yes('ayush', 'AYUSH treatment', 'Coverage'),
      yes('domiciliary', 'Domiciliary hospitalisation', 'Coverage'),
      { key: 'ambulance', name: 'Ambulance cover', group: 'Coverage', dataType: 'Amount in ₹' },
      yes('restoration', 'Restoration of sum insured', 'Benefits'),
      { key: 'ncb', name: 'No-claim bonus', group: 'Benefits', dataType: 'Percentage' },
      yes('health_checkup', 'Free health check-up', 'Benefits'),
      yes('consumables', 'Consumables cover', 'Benefits'),
      { key: 'exclusions', name: 'Main exclusions', group: 'Exclusions', dataType: 'Text' },
    ],
    factors: [
      { key: 'eldest_age', name: 'Age of the eldest member', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 35 }, { from: 36, to: 45 }, { from: 46, to: 55 }, { from: 56, to: 65 }, { from: 66, to: 99 }] },
      { key: 'sum_insured', name: 'Sum insured', kind: 'VALUE', source: 'Sum insured', values: ['300000', '500000', '1000000', '2500000', '5000000'] },
    ],
    questions: [],
  },
  TERM_LIFE: {
    features: [...LIFE_FEATURES],
    factors: [
      { key: 'proposer_age', name: 'Age of the proposer', kind: 'BAND', source: 'Age of the proposer', bands: [{ from: 18, to: 30 }, { from: 31, to: 40 }, { from: 41, to: 50 }, { from: 51, to: 65 }] },
      { key: 'sum_assured', name: 'Sum assured', kind: 'VALUE', source: 'Sum insured', values: ['5000000', '10000000', '20000000'] },
      { key: 'tobacco', name: 'Tobacco user', kind: 'VALUE', source: 'Asked in the quotation', values: ['Yes', 'No'] },
    ],
    questions: [{ key: 'tobacco', label: 'Does the person use tobacco?', dataType: 'Text', required: true }],
  },
  LIFE_SAVINGS: {
    features: [
      ...LIFE_FEATURES,
      { key: 'guaranteed_additions', name: 'Guaranteed additions', group: 'Benefits', dataType: 'Text' },
      yes('loan_facility', 'Loan against policy', 'Benefits'),
      { key: 'surrender_after', name: 'Surrender allowed after', group: 'Waiting periods', dataType: 'Years' },
    ],
    factors: [
      { key: 'proposer_age', name: 'Age of the proposer', kind: 'BAND', source: 'Age of the proposer', bands: [{ from: 0, to: 30 }, { from: 31, to: 45 }, { from: 46, to: 65 }] },
      { key: 'policy_term', name: 'Policy term', kind: 'VALUE', source: 'Policy term', values: ['10', '15', '20', '25'] },
    ],
    questions: [],
  },
  MOTOR_CAR: MOTOR(['Up to 1000 cc', '1001 to 1500 cc', 'Above 1500 cc']),
  MOTOR_TWO_WHEELER: MOTOR(['Up to 75 cc', '76 to 150 cc', '151 to 350 cc', 'Above 350 cc']),
  TRAVEL: {
    features: [
      { key: 'medical_emergency', name: 'Emergency medical expenses', group: 'Coverage', dataType: 'Amount in ₹', requiredToPublish: true },
      yes('evacuation', 'Medical evacuation', 'Coverage'),
      { key: 'baggage_loss', name: 'Checked baggage loss', group: 'Coverage', dataType: 'Amount in ₹' },
      { key: 'baggage_delay', name: 'Baggage delay', group: 'Coverage', dataType: 'Amount in ₹' },
      { key: 'passport_loss', name: 'Loss of passport', group: 'Coverage', dataType: 'Amount in ₹' },
      yes('trip_cancellation', 'Trip cancellation', 'Coverage'),
      yes('flight_delay', 'Flight delay', 'Coverage'),
      { key: 'personal_liability', name: 'Personal liability', group: 'Coverage', dataType: 'Amount in ₹' },
      { key: 'deductible', name: 'Deductible per claim', group: 'Limits and sub-limits', dataType: 'Amount in ₹' },
      yes('ped_covered', 'Pre-existing diseases covered (emergencies)', 'Benefits'),
      { key: 'exclusions', name: 'Main exclusions', group: 'Exclusions', dataType: 'Text' },
    ],
    factors: [
      { key: 'eldest_age', name: 'Age of the eldest traveller', kind: 'BAND', source: 'Age of the eldest insured person', bands: [{ from: 0, to: 40 }, { from: 41, to: 60 }, { from: 61, to: 70 }, { from: 71, to: 99 }] },
      { key: 'trip_days', name: 'Trip length', kind: 'VALUE', source: 'Asked in the quotation', values: ['Up to 7 days', '8 to 15 days', '16 to 30 days', '31 to 60 days', '61 to 180 days'] },
    ],
    questions: [{ key: 'trip_days', label: 'Trip length', dataType: 'Text', required: true }],
  },
  PERSONAL_ACCIDENT: {
    features: [
      { key: 'accidental_death', name: 'Accidental death', group: 'Coverage', dataType: 'Percentage', requiredToPublish: true, help: '% of sum insured' },
      { key: 'ptd', name: 'Permanent total disability', group: 'Coverage', dataType: 'Percentage' },
      yes('ppd', 'Permanent partial disability', 'Coverage'),
      yes('ttd', 'Temporary total disability', 'Coverage'),
      { key: 'medical_expenses', name: 'Accident medical expenses', group: 'Limits and sub-limits', dataType: 'Text' },
      yes('child_education', 'Children\'s education benefit', 'Benefits'),
      { key: 'cumulative_bonus', name: 'Cumulative bonus', group: 'Benefits', dataType: 'Percentage' },
      { key: 'exclusions', name: 'Main exclusions', group: 'Exclusions', dataType: 'Text' },
    ],
    factors: [
      { key: 'sum_insured', name: 'Sum insured', kind: 'VALUE', source: 'Sum insured', values: ['500000', '1000000', '2500000', '5000000'] },
      { key: 'occupation_class', name: 'Occupation class', kind: 'VALUE', source: 'Asked in the quotation', values: ['Class I', 'Class II', 'Class III'] },
    ],
    questions: [{ key: 'occupation_class', label: 'Occupation class', dataType: 'Text', required: true }],
  },
  HOME: {
    features: [
      yes('fire', 'Fire and allied perils', 'Coverage', true),
      yes('earthquake', 'Earthquake', 'Coverage'),
      yes('flood', 'Flood and storm', 'Coverage'),
      yes('burglary', 'Burglary and theft', 'Coverage'),
      { key: 'contents_limit', name: 'Contents limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹' },
      { key: 'jewellery_limit', name: 'Jewellery and valuables limit', group: 'Limits and sub-limits', dataType: 'Amount in ₹' },
      yes('alternate_accommodation', 'Alternate accommodation', 'Benefits'),
      yes('rent_loss', 'Loss of rent', 'Benefits'),
      { key: 'exclusions', name: 'Main exclusions', group: 'Exclusions', dataType: 'Text' },
    ],
    factors: [
      { key: 'sum_insured', name: 'Sum insured', kind: 'VALUE', source: 'Sum insured', values: ['1000000', '2500000', '5000000', '10000000'] },
      { key: 'cover_for', name: 'Cover for', kind: 'VALUE', source: 'Asked in the quotation', values: ['Building', 'Contents', 'Building and contents'] },
    ],
    questions: [{ key: 'cover_for', label: 'Cover for', dataType: 'Text', required: true }],
  },
};

/** The default template for a form, with display order filled in (none for GENERIC). */
export function defaultTemplateFor(code: ProductFormCode) {
  const t = DEFAULT_TEMPLATES[code];
  if (!t) return null;
  return {
    features: t.features.map((f, i) => ({ key: f.key, name: f.name, group: f.group, dataType: f.dataType, requiredToPublish: !!f.requiredToPublish, order: i + 1, help: f.help ?? null })),
    factors: t.factors.map((f) => ({ key: f.key, name: f.name, kind: f.kind, source: f.source, bands: f.kind === 'BAND' ? f.bands ?? [] : [], values: f.kind === 'VALUE' ? f.values ?? [] : [] })),
    questions: t.questions.map((q) => ({ ...q })),
  };
}

/**
 * Seed (dry run unless `apply`): for every SkyUp type with no template version, version 1 ACTIVE from its form's
 * default. Returns what was (or would be) created and what was skipped and why.
 */
export async function seedCategoryTemplates(opts: { apply: boolean; makerId?: string }) {
  await ensureStartingTypes();
  const report: { apply: boolean; created: Array<{ type: string; form: string; features: number }>; skipped: Array<{ type: string; reason: string }> } = { apply: opts.apply, created: [], skipped: [] };
  const types = await InsuranceType.find({ ownerAccountId: null }, { name: 1, productForm: 1 }).sort({ name: 1 }).lean<Array<{ _id: string; name: string; productForm?: string | null }>>();
  for (const t of types) {
    const form = formOfType(t);
    if (await TemplateVersion.exists({ typeId: t._id })) { report.skipped.push({ type: t.name, reason: 'already has a template' }); continue; }
    const tpl = defaultTemplateFor(form.code);
    if (!tpl) { report.skipped.push({ type: t.name, reason: `no default for form ${form.code}` }); continue; }
    if (opts.apply) {
      try {
        await TemplateVersion.create({
          _id: newId('tpl'), typeId: t._id, number: 1, status: 'ACTIVE', isOpen: null, ...tpl,
          makerId: opts.makerId ?? 'system:seed', approvedBy: opts.makerId ?? 'system:seed', approvedAt: new Date(),
        });
        if (!t.productForm) await InsuranceType.updateOne({ _id: t._id, productForm: null }, { $set: { productForm: form.code } });
      } catch (e) {
        if (isDuplicateKey(e)) { report.skipped.push({ type: t.name, reason: 'a template was created at the same time' }); continue; }
        throw e;
      }
    }
    report.created.push({ type: t.name, form: form.code, features: tpl.features.length });
  }
  return report;
}