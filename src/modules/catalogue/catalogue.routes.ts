import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { optionalStepUp, requireStepUp } from '../auth/stepUp.js';
import { bareDomain, code, confirmations, date, email, enumOf, notes, optional, percent, phone, recordId, required, rupees, shortText, uin, version, webAddress, wholeNumber } from '../../lib/fields.js';
import { cfgNum } from '../../config/cfg.js';
import { sendData, sendDone } from '../../lib/response.js';
import { INSURER_CATEGORIES } from '../insurers/insurer.model.js';
import * as ins from './insurers.service.js';
import * as types from './types.service.js';
import * as products from './products.service.js';
import * as prices from './prices.service.js';
import * as corrections from './corrections.service.js';
import * as ocr from './ocr.service.js';
import * as priv from './private.service.js';
import * as variants from './variants.service.js';
import { DATA_TYPES, FACTOR_SOURCES, FEATURE_GROUPS } from './types.model.js';

const labels = {
  name: 'Insurer name', shortCode: 'Short code', category: 'Category', irdaiRegNo: 'IRDAI registration number', website: 'Website',
  paymentDomains: 'Payment link domains', careNumber: 'Customer care number', careEmail: 'Customer care email', version: 'Version', reason: 'Reason',
};
const idParam = z.object({ id: z.string().regex(/^ins_[a-f0-9]{28}$/) });
const fields = {
  name: shortText(), shortCode: code(), category: enumOf(INSURER_CATEGORIES), irdaiRegNo: code(),
  website: optional(webAddress()), paymentDomains: z.array(bareDomain()).min(1, { message: 'GEN-01' }).max(20).transform((a) => [...new Set(a)]),
  careNumber: optional(phone()), careEmail: optional(email()),
};
const createBody = z.object({
  name: required(fields.name), shortCode: required(fields.shortCode), category: required(fields.category), irdaiRegNo: required(fields.irdaiRegNo),
  website: fields.website, paymentDomains: required(fields.paymentDomains), careNumber: fields.careNumber, careEmail: fields.careEmail,
  submit: z.boolean().optional(),
}).strict();
const editBody = z.object({
  version: required(version()), name: fields.name.optional(), shortCode: fields.shortCode.optional(), category: fields.category.optional(),
  irdaiRegNo: fields.irdaiRegNo.optional(), website: fields.website, paymentDomains: fields.paymentDomains.optional(),
  careNumber: fields.careNumber, careEmail: fields.careEmail, submit: z.boolean().optional(),
}).strict();
const versionBody = z.object({ version: required(version()) }).strict();

/** Admin → Catalogue → Insurers (P-20). STF or ADM make; a different ADM approves with OTP. */
export function catalogueInsurerRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  r.get('/', validate({ query: z.object({ q: z.string().max(100).optional(), status: z.string().max(30).optional() }) }), async (req, res) =>
    sendData(res, await ins.list(req.query.q ? String(req.query.q) : undefined, req.query.status ? String(req.query.status) : undefined)));
  r.get('/:id', validate({ params: idParam }), async (req, res) => sendData(res, await ins.get(req.auth!, String(req.params.id))));
  r.post('/', optionalStepUp, validate({ body: createBody }, labels), idempotent(), async (req, res) => {
    const out = await ins.create(req.auth!, req.body, req);
    sendDone(res, out.insurer, out.messageId, out.params, 201);
  });
  r.patch('/:id', optionalStepUp, validate({ params: idParam, body: editBody }, labels), async (req, res) => {
    const out = await ins.edit(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.insurer, out.messageId, out.params);
  });
  r.post('/:id/submit', optionalStepUp, validate({ params: idParam, body: versionBody }, labels), async (req, res) => {
    const out = await ins.submit(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.insurer, out.messageId, out.params);
  });
  // Decisions: ADM only, after the step-up OTP (AUTH-26).
  r.post('/:id/approve', allow('catalogue.approve'), requireStepUp, validate({ params: idParam, body: versionBody }, labels), async (req, res) => {
    const out = await ins.approve(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.insurer, out.messageId, out.params);
  });
  r.post('/:id/reject', allow('catalogue.approve'), requireStepUp, validate({ params: idParam, body: z.object({ version: required(version()), reason: required(shortText()) }).strict() }, labels), async (req, res) => {
    const out = await ins.reject(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.insurer, out.messageId, out.params);
  });
  // Change #40 / §9.6: deactivate needs a reason and the OTP
  r.post('/:id/deactivate', allow('catalogue.approve'), requireStepUp, validate({ params: idParam, body: z.object({ version: required(version()), reason: required(shortText()), confirm: confirmations() }).strict() }, { ...labels, reason: 'Reason' }), async (req, res) =>
    sendDone(res, await ins.setActive(req.auth!, String(req.params.id), req.body, 'INACTIVE', req), 'GEN-08', { 'Record type': 'Insurer' }));
  r.post('/:id/activate', allow('catalogue.approve'), validate({ params: idParam, body: versionBody }, labels), async (req, res) =>
    sendDone(res, await ins.setActive(req.auth!, String(req.params.id), req.body, 'ACTIVE', req), 'GEN-08', { 'Record type': 'Insurer' }));
  return r;
}

/** Admin → Approvals: everything waiting for a decision, oldest first (insurers and template versions). */
export function approvalRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  r.get('/', async (req, res) => {
    const all = [...(await ins.approvals(req.auth!)), ...(await types.templateApprovals(req.auth!)), ...(await products.productApprovals(req.auth!))];
    sendData(res, all.sort((a, b) => new Date(a.at ?? 0).getTime() - new Date(b.at ?? 0).getTime()));
  });
  return r;
}

// ── P-21 insurance types and feature templates ──
const tplLabels = { name: 'Name', features: 'Features', factors: 'Rating factors', questions: 'Quotation questions', rev: 'Version', reason: 'Reason', version: 'Version' };
const num = z.number({ invalid_type_error: 'VAL-12' }).finite().min(0, { message: 'VAL-12' });
const templateBody = z.object({
  rev: required(version()),
  features: z.array(z.object({
    key: z.string().max(60).optional(), name: required(shortText()), group: required(enumOf(FEATURE_GROUPS)), dataType: required(enumOf(DATA_TYPES)),
    requiredToPublish: z.boolean().default(false), order: z.number().int().min(1).max(500).optional(), help: optional(shortText()),
  }).strict()).max(200),
  factors: z.array(z.object({
    key: z.string().max(60).optional(), name: required(shortText()), kind: required(enumOf(['BAND', 'VALUE'] as const)), source: required(enumOf(FACTOR_SOURCES)),
    bands: z.array(z.object({ from: num, to: num }).strict()).max(100).default([]), values: z.array(shortText()).max(100).default([]),
  }).strict()).max(50),
  questions: z.array(z.object({ key: z.string().max(60).optional(), label: required(shortText()), dataType: required(enumOf(DATA_TYPES)), required: z.boolean().default(false) }).strict()).max(50),
}).strict();
const typeId = z.object({ id: z.string().regex(/^typ_[a-f0-9]{28}$/) });
const tplId = z.object({ id: z.string().regex(/^tpl_[a-f0-9]{28}$/) });
const revBody = z.object({ rev: required(version()) }).strict();

/** Admin → Catalogue → Insurance types (P-21). */
export function typeRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  r.get('/', async (req, res) => sendData(res, await types.listTypes(req.auth!)));
  r.post('/', validate({ body: z.object({ name: required(shortText()) }).strict() }, tplLabels), idempotent(), async (req, res) =>
    sendData(res, await types.createType(req.auth!, req.body.name, req), 201));
  r.post('/:id/templates', validate({ params: typeId }), async (req, res) => sendData(res, await types.startDraft(req.auth!, String(req.params.id), req), 201));
  r.post('/:id/deactivate', allow('catalogue.approve'), validate({ params: typeId, body: z.object({ version: required(version()), confirm: confirmations() }).strict() }, tplLabels), async (req, res) =>
    sendDone(res, await types.setTypeActive(req.auth!, String(req.params.id), req.body, 'INACTIVE', req), 'GEN-08', { 'Record type': 'Insurance type' }));
  r.post('/:id/activate', allow('catalogue.approve'), validate({ params: typeId, body: z.object({ version: required(version()) }).strict() }, tplLabels), async (req, res) =>
    sendDone(res, await types.setTypeActive(req.auth!, String(req.params.id), req.body, 'ACTIVE', req), 'GEN-08', { 'Record type': 'Insurance type' }));
  return r;
}

/** Template versions: edit the DRAFT, submit, and the decision (a different ADM, with OTP). */
export function templateRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  r.get('/:id', validate({ params: tplId }), async (req, res) => sendData(res, await types.getTemplate(req.auth!, String(req.params.id))));
  r.put('/:id', validate({ params: tplId, body: templateBody }, tplLabels), async (req, res) =>
    sendDone(res, await types.saveDraft(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Template' }));
  r.post('/:id/submit', requireStepUp, validate({ params: tplId, body: revBody }, tplLabels), async (req, res) => {
    const out = await types.submit(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.template, 'CAT-42', out.params); // published at once (no admin approval)
  });
  r.post('/:id/approve', allow('catalogue.approve'), requireStepUp, validate({ params: tplId, body: revBody }, tplLabels), async (req, res) => {
    const out = await types.approve(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.template, 'CAT-03', out.params);
  });
  r.post('/:id/reject', allow('catalogue.approve'), requireStepUp, validate({ params: tplId, body: z.object({ rev: required(version()), reason: required(shortText()) }).strict() }, tplLabels), async (req, res) => {
    const out = await types.reject(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.template, 'CAT-04', out.params);
  });
  return r;
}

// ── P-22 / P-25 products ──
const prodLabels = {
  insurerId: 'Insurer', typeId: 'Insurance type', code: 'Product code', name: 'Product name', description: 'Short description', uin: 'IRDAI product UIN',
  launchDate: 'Launch date', adultMin: 'Adult minimum entry age', adultMax: 'Adult maximum entry age', childMin: 'Child minimum entry age', childMax: 'Child maximum entry age',
  sumInsured: 'Sum insured', policyTerms: 'Policy terms', addOns: 'Add-ons', pricingMode: 'Pricing mode', taxPercent: 'Tax %', maxNominees: 'Most nominees',
  gracePeriodDays: 'Grace period', sourceLink: 'Insurer page link', sourceCheckedOn: 'Date checked', commissionPercent: 'Commission %', notes: 'Notes',
  rev: 'Version', version: 'Version', reason: 'Reason', status: 'Status', data: 'Product',
};
const age = () => wholeNumber(0, () => cfgNum('CFG-150'));
/** One product version's values. Everything optional here: completeness is checked on submit or save (P-22). */
export const productData = z.object({
  name: optional(shortText()), description: optional(shortText()), uin: optional(uin()), launchDate: optional(date()),
  adultMin: age().optional(), adultMax: age().optional(), coversChildren: z.boolean().optional(), childMin: optional(age()), childMax: optional(age()),
  sumInsured: z.object({ options: z.array(rupees()).max(50).optional(), min: optional(rupees()), max: optional(rupees()) }).strict().optional(),
  policyTerms: z.array(wholeNumber(1, () => cfgNum('CFG-58'))).max(50).optional(),
  features: z.record(z.string().max(60), z.object({ value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(), page: z.number().int().min(1).max(2000).nullable().optional(), notStated: z.boolean().optional() }).strict()).optional(),
  addOns: z.array(z.object({ name: required(shortText()), description: optional(shortText()), priceType: required(enumOf(['FIXED', 'PERCENT'] as const)), value: required(z.number().min(0).max(10_000_000)) }).strict()).max(200).optional(),
  pricingMode: enumOf(['RATE_TABLE', 'MANUAL_ENTRY'] as const).optional(), taxPercent: percent().optional(),
  nomineeRequired: z.boolean().optional(), maxNominees: wholeNumber(1, () => cfgNum('CFG-53')).optional(), gracePeriodDays: optional(wholeNumber(0, () => 365)),
  brochureFileId: optional(recordId('fil')), sourceLink: optional(webAddress()), sourceCheckedOn: optional(date()),
  // Change #5: features outside the template (✓/✗ or a short text per variant)
  customFeatures: z.array(z.object({ key: z.string().regex(/^cf_[a-z0-9_]{1,50}$/).optional(), name: required(shortText()), origin: enumOf(['ADVISOR', 'AI_SUGGESTED', 'SKYUP'] as const).optional(), group: optional(shortText()), dataType: enumOf(['Yes/No', 'Text'] as const).optional() }).strict()).max(50).optional(),
}).strict();
const featureValues = z.record(z.string().max(60), z.object({ value: z.union([z.string().max(500), z.number(), z.boolean(), z.null()]).optional(), page: z.number().int().min(1).max(2000).nullable().optional(), notStated: z.boolean().optional(), included: z.boolean().optional() }).strict());
/** Change #2: one variant (Silver, Gold…): its cover type, sum-insured range inside the product's, and its own values. */
export const variantInput = z.object({
  name: required(shortText()), coverType: optional(enumOf(['INDIVIDUAL', 'FLOATER'] as const)),
  sumInsuredMin: optional(rupees()), sumInsuredMax: optional(rupees()), features: featureValues.optional(),
}).strict();
const variantsList = z.array(variantInput).max(50);
const prdId = z.object({ id: z.string().regex(/^prd_[a-f0-9]{28}$/) });
const pvId = z.object({ id: z.string().regex(/^pv_[a-f0-9]{28}$/) });

/** Admin → Catalogue → Products: verified products (STF/ADM make; P-25 approval by a different ADM). */
export function adminProductRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  r.get('/', validate({ query: z.object({ q: z.string().max(100).optional() }) }), async (req, res) => sendData(res, await products.adminList(req.query.q ? String(req.query.q) : undefined)));
  r.get('/:id', validate({ params: prdId }), async (req, res) => sendData(res, await products.adminGet(String(req.params.id))));
  r.post('/', validate({ body: z.object({ insurerId: required(recordId('ins')), typeId: required(z.string().regex(/^typ_[a-f0-9]{28}$/)), code: required(code()) }).strict() }, prodLabels), idempotent(),
    async (req, res) => sendData(res, await products.adminCreate(req.auth!, req.body, req), 201));
  r.post('/:id/versions', validate({ params: prdId }), async (req, res) => {
    const out = await products.adminStartEdit(req.auth!, String(req.params.id), req);
    sendDone(res, out.version, out.messageId, {}, 201);
  });
  // Change #37 / §9.6: withdraw needs the OTP (the reason was already required)
  r.post('/:id/withdraw', allow('catalogue.approve'), requireStepUp, validate({ params: prdId, body: z.object({ version: required(version()), reason: required(shortText()) }).strict() }, prodLabels), async (req, res) => {
    const out = await products.adminWithdraw(req.auth!, String(req.params.id), req.body, 'WITHDRAWN', req);
    sendDone(res, out, 'CAT-26', { Product: out.name ?? 'The product' });
  });
  r.post('/:id/make-available', allow('catalogue.approve'), validate({ params: prdId, body: z.object({ version: required(version()) }).strict() }, prodLabels), async (req, res) =>
    sendDone(res, await products.adminWithdraw(req.auth!, String(req.params.id), req.body, 'AVAILABLE', req), 'GEN-08', { 'Record type': 'Product' }));
  return r;
}

export function productVersionRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  r.put('/:id', validate({ params: pvId, body: z.object({ rev: required(version()), data: productData }).strict() }, prodLabels), async (req, res) =>
    sendDone(res, await products.adminSaveDraft(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Product version' }));
  // Change #2: the draft's variants, replaced as a set
  r.get('/:id/variants', validate({ params: pvId }), async (req, res) => sendData(res, await variants.variantsOf(String(req.params.id))));
  r.put('/:id/variants', validate({ params: pvId, body: z.object({ rev: required(version()), variants: variantsList }).strict() }, prodLabels), async (req, res) =>
    sendDone(res, await products.adminSaveVariants(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Product version' }));
  r.post('/:id/use-current-template', validate({ params: pvId, body: z.object({ rev: required(version()) }).strict() }, prodLabels), async (req, res) =>
    sendDone(res, await products.adminUseCurrentTemplate(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Product version' }));
  r.post('/:id/submit', requireStepUp, validate({ params: pvId, body: z.object({ rev: required(version()) }).strict() }, prodLabels), async (req, res) => {
    const out = await products.adminSubmit(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.version, 'CAT-42', out.params); // "Publish to all advisors": live at once (no admin approval)
  });
  r.post('/:id/approve', allow('catalogue.approve'), requireStepUp, validate({ params: pvId, body: z.object({ rev: required(version()) }).strict() }, prodLabels), async (req, res) => {
    const out = await products.adminApprove(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.version, 'CAT-03', out.params);
  });
  // P-23 brochure reading on a DRAFT version
  r.post('/:id/ocr', validate({ params: pvId, body: z.object({ fileId: required(recordId('fil')) }).strict() }, { fileId: 'Brochure' }), async (req, res) =>
    sendDone(res, await ocr.start(req.auth!, String(req.params.id), req.body.fileId, req), 'OCR-01', { 'CFG-38': cfgNum('CFG-38') }, 202));
  r.get('/:id/ocr', validate({ params: pvId }), async (req, res) => sendData(res, await ocr.latest(String(req.params.id))));
  r.post('/:id/reject', allow('catalogue.approve'), requireStepUp, validate({ params: pvId, body: z.object({ rev: required(version()), reason: required(shortText()) }).strict() }, prodLabels), async (req, res) => {
    const out = await products.adminReject(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.version, 'CAT-04', out.params);
  });
  return r;
}

/** Advisors and assistants: the catalogue they can quote (verified + own); own products and commercials. */
export function productRoutes() {
  const r = Router();
  r.use(authenticate, allow('products.view'));
  r.get('/', validate({ query: z.object({ typeId: z.string().regex(/^typ_[a-f0-9]{28}$/).optional(), quotable: z.enum(['true', 'false']).optional() }) }), async (req, res) =>
    sendData(res, await products.advisorList(req.auth!, { typeId: req.query.typeId ? String(req.query.typeId) : undefined, quotableOnly: req.query.quotable === 'true' })));
  r.get('/:id', validate({ params: prdId }), async (req, res) => sendData(res, await products.advisorGet(req.auth!, String(req.params.id))));
  // P-58: suggest a correction to a verified product (the advisor never edits it, AC-P58-1).
  r.get('/:id/corrections/fields', allow('corrections.suggest'), validate({ params: prdId }), async (req, res) => sendData(res, await corrections.correctableFields(String(req.params.id))));
  r.get('/:id/corrections', allow('corrections.suggest'), validate({ params: prdId }), async (req, res) => sendData(res, await corrections.mine(req.auth!, String(req.params.id))));
  r.post('/:id/corrections', allow('corrections.suggest'), writable, validate({ params: prdId, body: z.object({ field: required(z.string().max(80)), proposedValue: required(shortText()), reason: required(shortText()), attachmentFileId: optional(recordId('fil')) }).strict() }, { field: 'Field', proposedValue: 'Proposed value', reason: 'Reason', attachmentFileId: 'Attachment' }), idempotent(),
    async (req, res) => sendDone(res, await corrections.suggest(req.auth!, String(req.params.id), req.body, req), 'CAT-35', {}, 201));
  // My commercials: the advisor only (AC-P22-6), private (AC-P22-2).
  r.get('/:id/commercials', allow('commercials.manage'), validate({ params: prdId }), async (req, res) => sendData(res, await products.getCommercials(req.auth!, String(req.params.id))));
  r.put('/:id/commercials', allow('commercials.manage'), writable, validate({ params: prdId, body: z.object({ commissionPercent: optional(percent()), notes: optional(notes()) }).strict() }, prodLabels), async (req, res) => {
    const out = await products.saveCommercials(req.auth!, String(req.params.id), { commissionPercent: req.body.commissionPercent ?? null, notes: req.body.notes ?? null }, req);
    sendDone(res, out.commercials, 'CAT-36', out.params);
  });
  return r;
}

/** + My product (ADV): published at once in this account (P-22 step 2). */
export function ownProductRoutes() {
  const r = Router();
  r.use(authenticate, allow('products.own'));
  // Read-only lookups for the + My product form: types with a live template, and that template's features.
  r.get('/types', async (req, res) => sendData(res, await types.ownProductTypes(req.auth!.accountId)));
  r.get('/types/:id/template', validate({ params: typeId }), async (req, res) => sendData(res, await types.liveFeatures(String(req.params.id), req.auth!.accountId ?? null)));
  // Changes #3, #4: step 1 "create a category" and step 2 "add a company", private to this account
  r.get('/insurers', validate({ query: z.object({ q: z.string().max(100).optional() }) }), async (req, res) => sendData(res, await priv.insurerChoices(req.auth!, (res.locals.query as { q?: string }).q)));
  r.post('/insurers', writable, validate({ body: z.object({ name: required(shortText()) }).strict() }, { name: 'Company name' }), idempotent(), async (req, res) =>
    sendDone(res, await priv.addInsurer(req.auth!, req.body, req), 'GEN-08', { 'Record type': 'Company' }, 201));
  r.post('/types', writable, validate({ body: z.object({ name: required(shortText()) }).strict() }, { name: 'Category name' }), idempotent(), async (req, res) =>
    sendDone(res, await priv.addCategory(req.auth!, req.body, req), 'GEN-08', { 'Record type': 'Category' }, 201));
  // Change #6: brochure reading for the advisor (Premium or trial; Normal → CAT-45). Nothing is saved to a product here.
  const jobId = z.object({ id: z.string().regex(/^ocr_[a-f0-9]{28}$/) });
  r.post('/brochure-reading', writable, validate({ body: z.object({ typeId: required(z.string().regex(/^typ_[a-f0-9]{28}$/)), fileId: required(recordId('fil')) }).strict() }, { typeId: 'Category', fileId: 'Brochure' }), async (req, res) =>
    sendDone(res, await ocr.advisorStart(req.auth!, req.body.typeId, req.body.fileId, req), 'OCR-01', { 'CFG-38': cfgNum('CFG-38') }, 202));
  r.get('/brochure-reading/:id', validate({ params: jobId }), async (req, res) => sendData(res, await ocr.advisorJob(req.auth!, String(req.params.id))));
  r.put('/brochure-reading/:id/decisions', writable, validate({ params: jobId, body: decisionsBody }), async (req, res) => sendData(res, await ocr.decideAny(req.auth!, String(req.params.id), req.body.decisions)));
  r.post('/brochure-reading/:id/accept-high', writable, validate({ params: jobId }), async (req, res) => sendData(res, await ocr.acceptHighAny(req.auth!, String(req.params.id))));
  r.post('/brochure-reading/:id/result', validate({ params: jobId }), async (req, res) => sendData(res, await ocr.advisorResult(req.auth!, String(req.params.id))));
  r.post('/brochure-reading/:id/retry', writable, validate({ params: jobId }), async (req, res) => sendDone(res, await ocr.retry(req.auth!, String(req.params.id), req), 'OCR-01', { 'CFG-38': cfgNum('CFG-38') }, 202));
  r.post('/', writable, validate({ body: z.object({ insurerId: required(recordId('ins')), typeId: required(z.string().regex(/^typ_[a-f0-9]{28}$/)), code: required(code()), data: productData, variants: variantsList.optional(), ocrJobId: optional(z.string().regex(/^ocr_[a-f0-9]{28}$/)) }).strict() }, prodLabels), idempotent(),
    async (req, res) => sendDone(res, await products.ownCreate(req.auth!, req.body, req), 'GEN-08', { 'Record type': 'Product' }, 201));
  r.put('/:id', writable, validate({ params: prdId, body: z.object({ version: required(version()), data: productData, variants: variantsList.optional() }).strict() }, prodLabels), async (req, res) =>
    sendDone(res, await products.ownEdit(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Product' }));
  r.post('/:id/status', writable, validate({ params: prdId, body: z.object({ version: required(version()), status: required(enumOf(['UPCOMING', 'ACTIVE', 'WITHDRAWN'] as const)) }).strict() }, prodLabels), idempotent(), async (req, res) =>
    sendDone(res, await products.ownSetStatus(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Product' }));
  return r;
}

// ── P-24 price versions ──
const priceLabels = { effectiveFrom: 'Effective from', taxPercent: 'Tax %', rows: 'Rate table', csv: 'Rate table file', riderPrices: 'Rider prices', sourceNote: 'Source note' };
const rawRows = z.array(z.object({ factors: z.record(z.string().max(60), z.string().max(100)), basePremium: z.union([z.number(), z.string().max(30)]) }).strict()).max(100_000);
const priceBody = z.object({
  effectiveFrom: required(date()), taxPercent: required(percent()), rows: rawRows.optional(), csv: z.string().max(5_000_000).optional(),
  riderPrices: z.array(z.object({ name: required(shortText()), value: required(z.number().min(0).max(10_000_000)) }).strict()).max(100).optional(),
  sourceNote: optional(shortText()),
}).strict();
const checkBody = z.object({ rows: rawRows.optional(), csv: z.string().max(5_000_000).optional() }).strict();
const prcParams = z.object({ id: z.string().regex(/^prd_[a-f0-9]{28}$/), pid: z.string().regex(/^prc_[a-f0-9]{28}$/) });

/** Shared by advisors (owner = their account) and SkyUp (owner = SKYUP reference price). */
function priceRoutes(r: Router, owner: (req: Express.Request) => string, guard: (req: Express.Request, id: string) => Promise<void>, writes: Array<import('express').RequestHandler>) {
  r.get('/:id/prices', validate({ params: prdId }), async (req, res) => { await guard(req, String(req.params.id)); sendData(res, await prices.list(owner(req), String(req.params.id))); });
  r.get('/:id/prices/template', validate({ params: prdId }), async (req, res) => {
    await guard(req, String(req.params.id));
    const { factors } = await prices.productAndFactors(String(req.params.id));
    sendData(res, { csv: prices.template(factors), columns: [...factors.map((f) => f.key), 'base_premium'], factors: factors.map((f) => ({ key: f.key, name: f.name, kind: f.kind, choices: f.kind === 'BAND' ? f.bands.map((b) => `${b.from}-${b.to}`) : f.values })) });
  });
  r.get('/:id/prices/reference', validate({ params: prdId }), async (req, res) => { await guard(req, String(req.params.id)); sendData(res, await prices.reference(String(req.params.id))); });
  r.get('/:id/prices/:pid', validate({ params: prcParams }), async (req, res) => { await guard(req, String(req.params.id)); sendData(res, await prices.getOne(owner(req), String(req.params.pid))); });
  r.post('/:id/prices/check', validate({ params: prdId, body: checkBody }, priceLabels), async (req, res) => { await guard(req, String(req.params.id)); sendData(res, await prices.check(String(req.params.id), req.body)); });
  r.post('/:id/prices', ...writes, validate({ params: prdId, body: priceBody }, priceLabels), idempotent(), async (req, res) => {
    await guard(req, String(req.params.id));
    const out = await prices.create(req.auth!, owner(req), String(req.params.id), req.body, req);
    sendDone(res, out.price, out.messageId, out.params, 201, out.warnings.length ? { warnings: out.warnings } : undefined);
  });
  r.post('/:id/prices/:pid/cancel', ...writes, validate({ params: prcParams }), idempotent(), async (req, res) => {
    await guard(req, String(req.params.id));
    const out = await prices.cancel(req.auth!, owner(req), String(req.params.pid), req);
    sendDone(res, out.price, 'CAT-25', out.params);
  });
}

/** My prices (P-24): the advisor's private price versions; any product the advisor can quote. */
export function advisorPriceRoutes() {
  const r = Router();
  // Only the /prices paths: a router-wide check would also block assistants from the product routes mounted after this.
  r.use('/:id/prices', authenticate, allow('prices.manage'));
  priceRoutes(r, (req) => req.auth!.accountId!, async (req, id) => { await products.advisorGet(req.auth!, id); }, [writable]);
  return r;
}

/** SkyUp reference prices (P-24): verified products only. */
export function referencePriceRoutes() {
  const r = Router();
  r.use('/:id/prices', authenticate, allow('catalogue.make'));
  priceRoutes(r, () => prices.SKYUP, async (_req, id) => { await products.adminGet(id); }, []);
  return r;
}

/** Admin → Approvals → Product corrections (P-58): STF or ADM review; Accept opens a DRAFT that still needs P-25. */
export function correctionRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  const id = z.object({ id: z.string().regex(/^cor_[a-f0-9]{28}$/) });
  r.get('/', async (_req, res) => sendData(res, await corrections.queue()));
  r.post('/:id/accept', optionalStepUp, validate({ params: id }), async (req, res) => sendData(res, await corrections.accept(req.auth!, String(req.params.id), req)));
  r.post('/:id/reject', validate({ params: id, body: z.object({ reason: required(shortText()) }).strict() }, { reason: 'Reason' }), async (req, res) =>
    sendData(res, await corrections.reject(req.auth!, String(req.params.id), req.body.reason, req)));
  return r;
}

/** Decisions on a reading: template features (default), product details, variant names, suggested features (change #6). */
const decisionsBody = z.object({ decisions: z.array(z.object({ section: enumOf(['FEATURE', 'DETAIL', 'VARIANT', 'SUGGESTION'] as const).optional(), key: z.string().max(60), decision: enumOf(['ACCEPT', 'EDIT', 'IGNORE', 'NOT_STATED'] as const), value: z.string().max(500).nullable().optional() }).strict()).max(300) }).strict();

/** P-23 OCR jobs: decisions, bulk accept above CFG-37, apply to draft, try again. */
export function ocrJobRoutes() {
  const r = Router();
  r.use(authenticate, allow('catalogue.make'));
  const id = z.object({ id: z.string().regex(/^ocr_[a-f0-9]{28}$/) });
  r.put('/:id/decisions', validate({ params: id, body: decisionsBody }), async (req, res) =>
    sendData(res, await ocr.decide(req.auth!, String(req.params.id), req.body.decisions)));
  r.post('/:id/accept-high', validate({ params: id }), async (req, res) => sendData(res, await ocr.acceptHigh(req.auth!, String(req.params.id))));
  r.post('/:id/apply', validate({ params: id }), async (req, res) => {
    const out = await ocr.apply(req.auth!, String(req.params.id), req);
    sendDone(res, out.job, 'OCR-06', out.params);
  });
  r.post('/:id/retry', validate({ params: id }), async (req, res) => sendDone(res, await ocr.retry(req.auth!, String(req.params.id), req), 'OCR-01', { 'CFG-38': cfgNum('CFG-38') }, 202));
  return r;
}