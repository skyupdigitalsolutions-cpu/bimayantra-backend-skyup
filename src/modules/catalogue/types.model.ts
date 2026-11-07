import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * P-21 Insurance types and their feature templates. A type is ACTIVE or INACTIVE. Each change to its template is
 * a new template VERSION: DRAFT → PENDING_APPROVAL → ACTIVE (the earlier ACTIVE one becomes RETIRED). Products keep
 * the version they were built on until their next edit (AC-P21-1, CAT-28).
 */
export const FEATURE_GROUPS = ['Coverage', 'Waiting periods', 'Limits and sub-limits', 'Benefits', 'Exclusions', 'Other'] as const;
export const DATA_TYPES = ['Yes/No', 'Number', 'Amount in ₹', 'Percentage', 'Days', 'Months', 'Years', 'Text'] as const;
export const FACTOR_SOURCES = ['Asked in the quotation', 'Age of the eldest insured person', 'Age of the proposer', 'Number of adults', 'Number of children', 'Sum insured', 'Policy term'] as const;

const typeSchema = new Schema(
  {
    _id: { type: String, default: () => newId('typ') },
    name: { type: String, required: true },
    nameKey: { type: String, required: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    /** Change #4: null = a SkyUp category for every advisor; an account ID = that advisor's private category. */
    ownerAccountId: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
// Change #4: names unique per owner (SkyUp's categories, or one advisor's private ones)
typeSchema.index({ ownerAccountId: 1, nameKey: 1 }, { unique: true, name: 'name_per_owner' });
export type InsuranceTypeDoc = InferSchemaType<typeof typeSchema> & { _id: string };
export const InsuranceType = model('InsuranceType', typeSchema, 'insurance_types');

const feature = new Schema({
  key: { type: String, required: true }, // stable id of the feature across versions (values in products refer to it)
  name: { type: String, required: true },
  group: { type: String, enum: FEATURE_GROUPS, required: true },
  dataType: { type: String, enum: DATA_TYPES, required: true },
  requiredToPublish: { type: Boolean, default: false },
  order: { type: Number, required: true },
  help: { type: String, default: null },
}, { _id: false });
const factor = new Schema({
  key: { type: String, required: true },
  name: { type: String, required: true },
  kind: { type: String, enum: ['BAND', 'VALUE'], required: true },
  source: { type: String, enum: FACTOR_SOURCES, required: true },
  bands: { type: [new Schema({ from: Number, to: Number }, { _id: false })], default: [] },
  values: { type: [String], default: [] },
}, { _id: false });
const question = new Schema({
  key: { type: String, required: true },
  label: { type: String, required: true },
  dataType: { type: String, enum: DATA_TYPES, required: true },
  required: { type: Boolean, default: false },
}, { _id: false });

const templateSchema = new Schema(
  {
    _id: { type: String, default: () => newId('tpl') },
    typeId: { type: String, required: true },
    number: { type: Number, required: true }, // template version 1, 2, 3 …
    status: { type: String, enum: ['DRAFT', 'PENDING_APPROVAL', 'ACTIVE', 'RETIRED'], default: 'DRAFT' },
    features: { type: [feature], default: [] },
    factors: { type: [factor], default: [] },
    questions: { type: [question], default: [] },
    makerId: { type: String, required: true },
    submittedAt: { type: Date, default: null },
    rejectReason: { type: String, default: null },
    approvedBy: { type: String, default: null },
    approvedAt: { type: Date, default: null },
    /** true while DRAFT or PENDING_APPROVAL (set by the service); null once ACTIVE or RETIRED. */
    isOpen: { type: Boolean, default: true },
    rev: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
templateSchema.index({ typeId: 1, number: 1 }, { unique: true });
/** At most one ACTIVE version and one open (DRAFT or PENDING) version per type; the database enforces both. */
templateSchema.index({ typeId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: 'one_active_template' });
templateSchema.index({ typeId: 1, isOpen: 1 }, { unique: true, partialFilterExpression: { isOpen: true }, name: 'one_open_template' });
export type TemplateDoc = InferSchemaType<typeof templateSchema> & { _id: string; createdAt: Date };
export const TemplateVersion = model('TemplateVersion', templateSchema, 'template_versions');