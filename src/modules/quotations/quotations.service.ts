import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ageOn, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId } from '../../lib/messages.js';
import { withTx } from '../../lib/mongo.js';
import { Account } from '../accounts/account.model.js';
import { nextNumber } from '../accounts/numbers.js';
import { audit } from '../audit/audit.service.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { upload as storeFile } from '../files/files.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';
import { can, type AuthContext } from '../rbac/capabilities.js';
import { priceOn } from '../catalogue/prices.service.js';
import { Product, ProductVersion, type ProductDoc, type ProductVersionDoc } from '../catalogue/product.model.js';
import { effectiveStatus, fitsEntryAge, type ProductData } from '../catalogue/products.service.js';
import { InsuranceType, TemplateVersion, type TemplateDoc } from '../catalogue/types.model.js';
import { calculate, EngineError, type Breakdown } from './engine.js';
import { cfgNum } from '../../config/cfg.js';
import { ProductVariant, defaultVariantFor, type VariantDoc } from '../catalogue/variant.model.js';
import { Quotation, type QuotationDoc } from './quotation.model.js';

export interface Inputs {
  typeId?: string; insurerId?: string; productId?: string; people?: string[]; sumInsured?: number; policyTerm?: number; startDate?: string;
  answers?: Record<string, string | number | boolean>; riders?: string[];
  override?: { amount: number; reason: string } | null; discount?: { kind: 'AMOUNT' | 'PERCENT'; value: number; reference: string } | null;
  manual?: { netPremium?: number; taxAmount?: number } | null; paymentLink?: string | null;
  /** P-38: the policy this quotation renews (allowed even when its product is now WITHDRAWN). */
  renewalOf?: string | null;
  // ── Stage G ──
  /** Change #2: the variant quoted; none = the version's default variant. */
  variantId?: string | null;
  /** Change #8 (Q3 default): the base premium typed by the advisor when more than one person is covered (or on a renewal); it replaces the rate-table base, which is kept for reference. */
  typedBasePremium?: number | null;
  /** Change #9: typed prices for chosen riders, by rider name; custom add-ons for this quotation only. */
  riderPrices?: Record<string, number>;
  customAddOns?: Array<{ name: string; price: number }>;
  /** Change #10: additional benefits, information only (not added to the premium; Q-default), printed when showOnPdf. */
  benefits?: Array<{ name: string; description?: string | null; cost?: number | null; showOnPdf: boolean }>;
}
/** Inputs that change the price and are the advisor's (GEN-03 for assistants), like override and discount. */
export const pricingInputs = (i: Inputs) => !!(i.override || (i.discount && i.discount.value) || i.typedBasePremium || (i.riderPrices && Object.keys(i.riderPrices).length) || i.customAddOns?.length);
type Problem = { field: string; messageId: MessageId; params?: Record<string, string | number> };
const CHILD = /^(son|daughter|child|grandson|granddaughter)$/i;
export const DISCLAIMER = "This quotation is based on the details you shared and the insurer's published rates on {date}. The insurer decides the final premium and whether to accept the proposal. Please read the policy wording before you buy.";

async function load(ctx: AuthContext, id: string) {
  const q = await Quotation.findOne({ _id: id, accountId: ctx.accountId }).lean<QuotationDoc>();
  if (!q) throw AppError.notFound();
  return q;
}

/** Everything the checks and the calculation need, read once. */
async function context(ctx: AuthContext, q: Pick<QuotationDoc, 'customerId'>, i: Inputs) {
  const customer = await Customer.findOne({ _id: q.customerId, accountId: ctx.accountId }).lean<{ _id: string; name: string; dob: string | null; status: string; number: string; mobile: string }>();
  const acc = await Account.findById(ctx.accountId, { profile: 1, ownerName: 1 }).lean<{ profile?: { professional?: { categories?: string[]; licenceValidUntil?: string | null; licenceNumber?: string | null }; business?: { displayName?: string | null } } }>();
  const type = i.typeId ? await InsuranceType.findById(i.typeId, { name: 1, status: 1 }).lean<{ _id: string; name: string; status: string }>() : null;
  const insurer = i.insurerId ? await Insurer.findById(i.insurerId, { name: 1, status: 1 }).lean<{ _id: string; name: string; status: string }>() : null;
  const mapping = i.insurerId ? await InsurerMapping.findOne({ accountId: ctx.accountId, insurerId: i.insurerId, status: 'ACTIVE' }).lean<{ agentCode: string; validUntil: string | null }>() : null;
  const product = i.productId ? await Product.findOne({ _id: i.productId, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }] }).lean<ProductDoc>() : null;
  const version = product?.publishedVersionId ? await ProductVersion.findById(product.publishedVersionId).lean<ProductVersionDoc>() : null;
  const tpl = version ? await TemplateVersion.findById(version.templateId, { factors: 1, questions: 1 }).lean<TemplateDoc>() : null;
  const fam = await FamilyMember.find({ customerId: q.customerId, accountId: ctx.accountId, status: 'ACTIVE' }, { name: 1, dob: 1, relationship: 1 }).lean<Array<{ _id: string; name: string; dob: string | null; relationship: string }>>();
  const everyone = customer ? [{ key: `C:${customer._id}`, name: customer.name, dob: customer.dob, relationship: 'Self' }, ...fam.map((f) => ({ key: `F:${f._id}`, name: f.name, dob: f.dob, relationship: f.relationship }))] : [];
  const price = product && (version?.data as ProductData | undefined)?.pricingMode === 'RATE_TABLE' ? await priceOn(ctx.accountId!, product._id) : null;
  // Change #2: the chosen variant of the live version (null = not one of them), else the version's default
  const variant = version
    ? (i.variantId ? await ProductVariant.findOne({ _id: i.variantId, productVersionId: version._id, status: 'ACTIVE' }).lean<VariantDoc>() : await defaultVariantFor(version as never))
    : null;
  return { customer, acc, type, insurer, mapping, product, version, data: (version?.data ?? {}) as ProductData, tpl, everyone, price, variant };
}
type Ctx = Awaited<ReturnType<typeof context>>;

/** P-27 "Checks before Next" for steps 1 to `upTo`, in step order; the first failing step stops the list. */
function check(ctx: AuthContext, c: Ctx, i: Inputs, upTo: number): Problem[] {
  const today = istToday();
  const p: Problem[] = [];
  const at = (step: number) => upTo >= step && p.length === 0;
  if (at(1)) {
    if (!c.customer) p.push({ field: 'customerId', messageId: 'GEN-01', params: { 'Field label': 'Customer' } });
    else if (c.customer.status !== 'ACTIVE') p.push({ field: 'customerId', messageId: 'CU-20', params: { Customer: c.customer.name } });
    const until = c.acc?.profile?.professional?.licenceValidUntil;
    if (until && until < today) p.push({ field: 'customerId', messageId: 'PRF-17', params: { date: until.split('-').reverse().join('-') } });
  }
  if (at(3)) {
    if (!c.type) p.push({ field: 'typeId', messageId: 'GEN-01', params: { 'Field label': 'Insurance type' } });
    else if (!(c.acc?.profile?.professional?.categories ?? []).includes(c.type.name)) p.push({ field: 'typeId', messageId: 'PRF-18', params: { 'Insurance type': c.type.name } });
  }
  if (at(4)) {
    if (!c.insurer) p.push({ field: 'insurerId', messageId: 'GEN-01', params: { 'Field label': 'Insurer' } });
    else if (!c.mapping || c.insurer.status !== 'ACTIVE') p.push({ field: 'insurerId', messageId: 'QT-12', params: { insurer: c.insurer.name } });
    else if (c.mapping.validUntil && c.mapping.validUntil < today) p.push({ field: 'insurerId', messageId: 'PRF-11', params: { insurer: c.insurer.name, date: c.mapping.validUntil.split('-').reverse().join('-') } });
  }
  if (at(5)) {
    const name = c.data.name ?? c.product?.code ?? 'This product';
    if (!c.product || !c.version) p.push({ field: 'productId', messageId: 'GEN-01', params: { 'Field label': 'Product' } });
    else if (c.product.typeId !== i.typeId || c.product.insurerId !== i.insurerId) p.push({ field: 'productId', messageId: 'VAL-22' });
    else if (effectiveStatus(c.product) !== 'ACTIVE' && !(i.renewalOf && effectiveStatus(c.product) === 'WITHDRAWN')) p.push({ field: 'productId', messageId: 'QT-11', params: { Product: name } });
    else if (c.data.pricingMode === 'RATE_TABLE' && !c.price && !i.typedBasePremium) p.push({ field: 'productId', messageId: 'QT-07', params: { Product: name } });
    else if (i.variantId && !c.variant) p.push({ field: 'variantId', messageId: 'VAL-22' });
  }
  if (at(6)) {
    const chosen = (i.people ?? []).map((k) => c.everyone.find((e) => e.key === k)).filter(Boolean) as Ctx['everyone'];
    if (!chosen.length) p.push({ field: 'people', messageId: 'GEN-01', params: { 'Field label': 'People to insure' } });
    for (const person of chosen) {
      if (!person.dob) { p.push({ field: 'people', messageId: 'QT-05', params: { name: person.name } }); continue; }
      const age = ageOn(person.dob);
      const child = CHILD.test(person.relationship) && c.data.coversChildren && fitsEntryAge(c.data, age, 'CHILD');
      if (!child && !fitsEntryAge(c.data, age, 'ADULT')) p.push({ field: 'people', messageId: 'QT-06', params: { Name: person.name, age, min: c.data.adultMin ?? 0, max: c.data.adultMax ?? 0 } }); // AC-P27-4
    }
    const si = c.data.sumInsured ?? {};
    if (!i.sumInsured) p.push({ field: 'sumInsured', messageId: 'GEN-01', params: { 'Field label': 'Sum insured' } });
    else if (!(si.options?.includes(i.sumInsured) || (si.min && si.max && i.sumInsured >= si.min && i.sumInsured <= si.max))) p.push({ field: 'sumInsured', messageId: 'VAL-22' });
    else if (c.variant && ((c.variant.sumInsuredMin != null && i.sumInsured < c.variant.sumInsuredMin) || (c.variant.sumInsuredMax != null && i.sumInsured > c.variant.sumInsuredMax))) {
      p.push({ field: 'sumInsured', messageId: 'QT-46', params: { variant: c.variant.name, min: c.variant.sumInsuredMin ?? 0, max: c.variant.sumInsuredMax ?? 0 } });
    }
    if (!i.policyTerm) p.push({ field: 'policyTerm', messageId: 'GEN-01', params: { 'Field label': 'Policy term' } });
    else if (!(c.data.policyTerms ?? []).includes(i.policyTerm)) p.push({ field: 'policyTerm', messageId: 'VAL-22' });
    if (!i.startDate) p.push({ field: 'startDate', messageId: 'GEN-01', params: { 'Field label': 'Planned start date' } });
    else if (i.startDate < today) p.push({ field: 'startDate', messageId: 'VAL-07' });
    for (const qn of c.tpl?.questions ?? []) {
      const a = i.answers?.[qn.key];
      if (qn.required && (a === undefined || a === null || a === '')) p.push({ field: `answers.${qn.key}`, messageId: 'GEN-01', params: { 'Field label': qn.label } });
    }
  }
  if (at(7)) {
    const names = (c.data.addOns ?? []).map((a) => a.name);
    if ((i.riders ?? []).some((r) => !names.includes(r))) p.push({ field: 'riders', messageId: 'VAL-22' });
    p.push(...addOnChecks(c, i));
  }
  if (at(8)) {
    if (c.data.pricingMode === 'MANUAL_ENTRY') {
      if (i.manual?.netPremium === undefined) p.push({ field: 'manual.netPremium', messageId: 'GEN-01', params: { 'Field label': 'Net premium' } });
      if (i.manual?.taxAmount === undefined) p.push({ field: 'manual.taxAmount', messageId: 'GEN-01', params: { 'Field label': 'Tax amount' } });
    }
    if (i.override && !i.override.reason?.trim()) p.push({ field: 'override.reason', messageId: 'GEN-01', params: { 'Field label': 'Override reason' } });
    p.push(...typedBaseChecks(c, i));
  }
  void ctx;
  return p;
}

/** Change #9: typed rider prices only for chosen riders; custom add-ons count toward CFG-40 and need their own names. */
export function addOnChecks(c: Ctx, i: Inputs): Problem[] {
  const p: Problem[] = [];
  const names = (c.data.addOns ?? []).map((a) => a.name);
  for (const k of Object.keys(i.riderPrices ?? {})) if (!(i.riders ?? []).includes(k)) p.push({ field: `riderPrices.${k}`, messageId: 'VAL-22' });
  const custom = i.customAddOns ?? [];
  if ((i.riders ?? []).length + custom.length > cfgNum('CFG-40')) p.push({ field: 'customAddOns', messageId: 'QT-47', params: { n: cfgNum('CFG-40') } }); // custom add-ons count too (default)
  custom.forEach((a, k) => {
    const n = a.name.trim().toLowerCase();
    if (names.some((x) => x.toLowerCase() === n) || custom.findIndex((b) => b.name.trim().toLowerCase() === n) !== k) p.push({ field: `customAddOns.${k}.name`, messageId: 'QT-48' });
  });
  return p;
}
/** Change #8: a typed base is for a rate-table product covering more than one person, or a renewal (the notice's premium). */
export function typedBaseChecks(c: Ctx, i: Inputs): Problem[] {
  return i.typedBasePremium && (c.data.pricingMode !== 'RATE_TABLE' || ((i.people ?? []).length < 2 && !i.renewalOf)) ? [{ field: 'typedBasePremium', messageId: 'QT-49' }] : [];
}

/** The rating-factor values for these inputs, as rate-table labels. */
function rowFor(c: Ctx, i: Inputs) {
  const chosen = (i.people ?? []).map((k) => c.everyone.find((e) => e.key === k)!).filter((x) => x?.dob);
  const ages = chosen.map((x) => ({ age: ageOn(x.dob!), child: CHILD.test(x.relationship) }));
  const want: Record<string, number> = {
    'Age of the eldest insured person': Math.max(...ages.map((a) => a.age)), 'Age of the proposer': c.customer?.dob ? ageOn(c.customer.dob) : 0,
    'Number of adults': ages.filter((a) => !a.child).length, 'Number of children': ages.filter((a) => a.child).length,
    'Sum insured': i.sumInsured ?? 0, 'Policy term': i.policyTerm ?? 0,
  };
  const factors = c.tpl?.factors ?? [];
  const labels = Object.fromEntries(factors.map((f) => {
    if (f.source === 'Asked in the quotation') return [f.key, String(i.answers?.[f.key] ?? '')];
    const v = want[f.source]!;
    if (f.kind === 'BAND') { const b = f.bands.find((x) => v >= (x.from ?? 0) && v <= (x.to ?? -1)); return [f.key, b ? `${b.from}-${b.to}` : '']; }
    return [f.key, String(v)];
  }));
  return (c.price!.rows as Array<{ factors: Record<string, string>; basePremium: number }>).find((r) => factors.every((f) => r.factors[f.key] === labels[f.key])) ?? null;
}

/** Steps 7–9: the premium from the engine. Problems (QT-08, QT-09, QT-19, QT-37) come back as field errors. */
function premium(c: Ctx, i: Inputs): { breakdown: Breakdown; priceVersionId: string | null } {
  if (c.data.pricingMode === 'MANUAL_ENTRY') {
    try {
      return { breakdown: calculate({ mode: 'MANUAL_ENTRY', base: i.manual?.netPremium ?? 0, riders: riderLines(c, i, new Map()), taxAmount: i.manual?.taxAmount ?? 0, override: null, discount: i.discount ?? null }), priceVersionId: null };
    } catch (e) { if (e instanceof EngineError) throw AppError.field('discount', e.messageId); throw e; }
  }
  const row = c.price ? rowFor(c, i) : null;
  const typed = i.typedBasePremium ?? null;
  if (!row && !typed) throw AppError.field('premium', 'QT-08');
  const riderPrices = new Map(((c.price?.riderPrices ?? []) as Array<{ name: string; value: number }>).map((r) => [r.name, r.value]));
  const riders = riderLines(c, i, riderPrices);
  // Change #8: with no price version the tax % comes from the product (a typed base needs no rate table)
  const taxPercent = c.price?.taxPercent ?? c.data.taxPercent ?? 0;
  try {
    return { breakdown: calculate({ mode: 'RATE_TABLE', base: typed ?? row!.basePremium, typedBase: !!typed, calculatedBase: row?.basePremium ?? null, riders, taxPercent, override: i.override ?? null, discount: i.discount ?? null }), priceVersionId: c.price?._id ?? null };
  } catch (e) { if (e instanceof EngineError) throw AppError.field('discount', e.messageId); throw e; }
}

/** Rider lines: the chosen product riders (typed price when given) and the custom add-ons (change #9). */
function riderLines(c: Ctx, i: Inputs, prices: Map<string, number>) {
  const product = (c.data.addOns ?? []).filter((a) => (i.riders ?? []).includes(a.name))
    .map((a) => ({ name: a.name, priceType: a.priceType, value: prices.get(a.name) ?? a.value, typed: i.riderPrices?.[a.name] ?? null }));
  const custom = (i.customAddOns ?? []).map((a) => ({ name: a.name.trim(), priceType: 'FIXED' as const, value: a.price, custom: true }));
  return [...product, ...custom];
}

const view = (q: QuotationDoc) => ({
  id: q._id, customerId: q.customerId, number: q.number, status: q.status, step: q.step, inputs: q.inputs, calc: q.calc, version: q.version,
  revisions: q.revisions.map((r) => ({ revision: r.revision, status: r.status, pdfFileId: r.pdfFileId, generatedAt: r.generatedAt, sharedAt: r.sharedAt ?? null, validUntil: r.validUntil ?? null, viewed: (r.views ?? []).length, reason: r.reason ?? null, final: (r.snapshot as { breakdown?: Breakdown }).breakdown?.final ?? null })),
  updatedAt: q.updatedAt,
  renewal: renewalView(q),
});
/** Changes #13–#16: the renewal mode, and "last year vs this year" once a premium is known. */
function renewalView(q: QuotationDoc) {
  const r = (q as { renewal?: { mode: string; previousPremium: number | null; noticeFileId: string | null; portabilityRequested: boolean; fromPolicyId: string } | null }).renewal;
  if (!r) return null;
  const now = (q.calc as { breakdown?: Breakdown } | null)?.breakdown?.final ?? (q.revisions.at(-1)?.snapshot as { breakdown?: Breakdown } | undefined)?.breakdown?.final ?? null;
  const change = r.previousPremium && now !== null ? Math.round(((now - r.previousPremium) / r.previousPremium) * 1000) / 10 : null;
  return { ...r, thisYear: now, changePercent: change };
}

/** Step 1: a new DRAFT for an ACTIVE customer (licence valid). */
export async function start(ctx: AuthContext, customerId: string, req: Request) {
  const c = await context(ctx, { customerId }, {});
  if (!c.customer) throw AppError.notFound();
  const p = check(ctx, c, {}, 1);
  if (p.length) throw AppError.fields(p);
  const q = await Quotation.create({ accountId: ctx.accountId, customerId, createdBy: ctx.userId, step: 2 });
  await audit({ entity: 'quotation', entityId: q._id, action: 'QUOTATION_DRAFT_STARTED', after: { customerId } }, { req });
  return view(q.toObject() as QuotationDoc);
}

/**
 * Save a step (each step saves the draft, AC-P27-7). The checks of every step before `step` must pass to move on.
 * Override and discount are the advisor's (GEN-03 for assistants). Any change before the premium clears it (AC-P27-3).
 */
export async function save(ctx: AuthContext, id: string, b: { version: number; step: number; inputs: Inputs }, req: Request) {
  const q = await load(ctx, id);
  if (q.status !== 'DRAFT') throw AppError.invalidState('quotation', q.status);
  if (pricingInputs(b.inputs) && !can(ctx.role, 'quotations.pricing')) throw AppError.forbidden(); // Stage G inputs too (default)
  const inputs = { ...(q.inputs as Inputs), ...b.inputs };
  const c = await context(ctx, q, inputs);
  const problems = check(ctx, c, inputs, b.step - 1);
  let calc = q.calc as { inputsKey: string } | null;
  const key = JSON.stringify({ ...inputs, paymentLink: undefined });
  if (calc && calc.inputsKey !== key) calc = null; // something changed: the premium is worked out again
  const step = problems.length ? Math.min(q.step, b.step) : b.step;
  const u = await Quotation.findOneAndUpdate({ _id: id, version: b.version }, { $set: { inputs, step, calc }, $inc: { version: 1 } }, { new: true }).lean<QuotationDoc>();
  if (!u) throw AppError.versionConflict('quotation', view(q));
  if (problems.length) throw AppError.fields(problems);
  void req;
  return view(u);
}

/** Step 8: show the premium (stored with the price version it used, for QT-10 at Generate). */
export async function calc(ctx: AuthContext, id: string) {
  const q = await load(ctx, id);
  const inputs = q.inputs as Inputs;
  const c = await context(ctx, q, inputs);
  const p = check(ctx, c, inputs, 8);
  if (p.length) throw AppError.fields(p);
  const r = premium(c, inputs);
  const stored = { ...r, at: new Date(), inputsKey: JSON.stringify({ ...inputs, paymentLink: undefined }) };
  const u = await Quotation.findOneAndUpdate({ _id: id }, { $set: { calc: stored, step: Math.max(q.step, 8) }, $inc: { version: 1 } }, { new: true }).lean<QuotationDoc>();
  const warnings = inputs.override ? [{ messageId: 'QT-38', message: msg('QT-38', { amount: r.breakdown.calculated.toLocaleString('en-IN', { maximumFractionDigits: 2 }) }) }] : [];
  return { quotation: view(u!), warnings };
}

/** The quotation PDF (standard design, the advisor's business name). Amounts print as "Rs." (standard PDF fonts have no ₹). */
async function buildPdf(snap: Record<string, any>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  let y = 800;
  const line = (t: string, f = font, size = 10) => { for (const part of t.match(/.{1,95}(\s|$)/g) ?? [t]) { page.drawText(part.trim(), { x: 50, y, size, font: f }); y -= size + 6; } };
  const rs = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  line(snap.advisor.businessName, bold, 16);
  line(`Quotation ${snap.number} R${snap.revision}   ·   ${snap.calculationDate}`, bold, 12);
  y -= 6;
  line(`Customer: ${snap.customer.name} (${snap.customer.number})`);
  line(`Insured: ${snap.people.map((x: { name: string; age: number }) => `${x.name} (${x.age})`).join(', ')}`);
  line(`Product: ${snap.product.name}${snap.product.variantName && snap.product.variantName !== 'Standard' ? ` - ${snap.product.variantName}` : ''}   UIN ${snap.product.uin}`);
  line(`Insurer: ${snap.insurer.name}   Agent code ${snap.advisor.agentCode}`);
  line(`Sum insured ${rs(snap.inputs.sumInsured)}   Policy term ${snap.inputs.policyTerm} year(s)   Start ${snap.startDate}`);
  y -= 6;
  const b = snap.breakdown;
  line('Premium', bold, 12);
  line(`Base premium${b.entryMode === 'TYPED' ? ' (as per insurer)' : ''}: ${rs(b.base)}`);
  for (const r of b.riders) line(`${r.name}${r.custom ? ' (additional add-on)' : ''}: ${rs(r.amount)}`);
  if (b.override !== null) line(`Premium used (override): ${rs(b.override)}`);
  if (b.discount) line(`Discount: - ${rs(b.discount)}`);
  line(`Tax${b.taxPercent !== null ? ` (${b.taxPercent}%)` : ''}: ${rs(b.tax)}`);
  line(`Total payable: ${rs(b.final)}`, bold, 12);
  const shown = (snap.benefits ?? []).filter((x: { showOnPdf: boolean }) => x.showOnPdf);
  if (shown.length) { // change #10
    y -= 6; line('Additional features - included', bold, 11);
    for (const x of shown) line(`${x.name}${x.description ? `: ${x.description}` : ''}${x.cost ? ` (value ${rs(x.cost)})` : ''}`);
  }
  if (snap.renewal) { // changes #15, #16
    y -= 6;
    if (snap.renewal.previousPremium) line(`Last year's premium: ${rs(snap.renewal.previousPremium)}`);
    if (snap.renewal.portabilityRequested) line('Portability requested: waiting periods already served carry over (subject to the new insurer). Portability form due 45 days before renewal.');
  }
  y -= 6;
  line(`Advisor: ${snap.advisor.name}   Licence ${snap.advisor.licenceNumber ?? '-'}`);
  line('Valid for 15 days from the day it is shared.');
  y -= 6;
  line(snap.disclaimer, font, 8);
  return Buffer.from(await doc.save());
}

/**
 * Generate (P-27): everything is checked again and the premium recalculated. If it differs from what was shown, QT-10
 * with old and new (AC-P27-6); anything else invalid, QT-04 with the list. Then the QT number and R1, a frozen snapshot
 * and the PDF (AC-P27-1). A PDF failure keeps the draft (QT-13). A double click gives one quotation (idempotent route).
 */
export async function generate(ctx: AuthContext, id: string, req: Request) {
  const q = await load(ctx, id);
  if (q.status !== 'DRAFT') throw AppError.invalidState('quotation', q.status);
  const inputs = q.inputs as Inputs;
  const c = await context(ctx, q, inputs);
  const problems = check(ctx, c, inputs, 9);
  if (problems.length) throw new AppError(400, 'VALIDATION_FAILED', 'QT-04', { list: problems.map((x) => msg(x.messageId, x.params ?? {})).join(' ') }, { fields: problems });
  let fresh;
  try { fresh = premium(c, inputs); } catch (e) { if (e instanceof AppError) throw new AppError(400, 'VALIDATION_FAILED', 'QT-04', { list: e.message }); throw e; }
  const shown = q.calc as { breakdown: Breakdown; priceVersionId: string | null } | null;
  if (!shown || shown.priceVersionId !== fresh.priceVersionId || shown.breakdown.final !== fresh.breakdown.final) {
    await Quotation.updateOne({ _id: id }, { $set: { calc: { ...fresh, at: new Date(), inputsKey: JSON.stringify({ ...inputs, paymentLink: undefined }) }, step: 8 }, $inc: { version: 1 } });
    throw new AppError(409, 'VERSION_CONFLICT', 'QT-10', {}, { old: shown?.breakdown.final ?? null, new: fresh.breakdown.final, breakdown: fresh.breakdown });
  }
  const today = istToday();
  const people = (inputs.people ?? []).map((k) => c.everyone.find((e) => e.key === k)!).map((x) => ({ name: x.name, relationship: x.relationship, dob: x.dob, age: ageOn(x.dob!, today) }));
  const user = await import('../users/user.model.js').then((m) => m.User.findById(ctx.userId, { name: 1 }).lean<{ name: string }>());
  const out = await withTx(async (session) => {
    const number = q.number ?? (await nextNumber(ctx.accountId!, 'quotation', session));
    const revision = q.revisions.length + 1;
    const snapshot = {
      number, revision, calculationDate: today.split('-').reverse().join('-'), startDate: inputs.startDate!.split('-').reverse().join('-'),
      customer: { id: c.customer!._id, name: c.customer!.name, number: c.customer!.number, mobile: c.customer!.mobile }, people,
      product: { id: c.product!._id, versionId: c.version!._id, versionNumber: c.version!.number, name: c.data.name, uin: c.data.uin, kind: c.product!.kind, variantName: c.variant?.name ?? null },
      benefits: inputs.benefits ?? [], renewal: (q as { renewal?: unknown }).renewal ?? null,
      insurer: { id: c.insurer!._id, name: c.insurer!.name }, priceVersionId: fresh.priceVersionId, inputs: { ...inputs, paymentLink: undefined },
      breakdown: fresh.breakdown, taxPercent: fresh.breakdown.taxPercent,
      advisor: { name: user?.name ?? ctx.name, businessName: c.acc?.profile?.business?.displayName ?? user?.name ?? ctx.name, licenceNumber: c.acc?.profile?.professional?.licenceNumber ?? null, agentCode: c.mapping!.agentCode },
      disclaimer: DISCLAIMER.replace('{date}', today.split('-').reverse().join('-')),
    };
    let pdf: Buffer;
    try { pdf = await buildPdf(snapshot); } catch { throw new AppError(500, 'INTERNAL_ERROR', 'QT-13'); }
    const file = await storeFile(ctx, 'QUOTATION_PDF', pdf, `${number}-R${revision}.pdf`, req);
    const earlier = q.revisions.map((r) => (['READY', 'SHARED', 'ACCEPTED', 'REJECTED', 'EXPIRED'].includes(r.status) ? { ...r, status: 'SUPERSEDED' } : r));
    const u = await Quotation.findOneAndUpdate({ _id: id, status: 'DRAFT', version: q.version }, {
      $set: { number, status: 'READY', step: 10, revisions: [...earlier, { revision, status: 'READY', variantId: c.variant?._id ?? null, snapshot, pdfFileId: file.id, pdfSha256: createHash('sha256').update(pdf).digest('hex'), generatedAt: new Date(), generatedBy: ctx.userId, sharedAt: null, validUntil: null, viewToken: null, views: [], shares: [], reason: null }] },
      $inc: { version: 1 },
    }, { new: true, session: session ?? undefined }).lean<QuotationDoc>();
    if (!u) throw AppError.versionConflict('quotation', null);
    await (await import('../payments/payments.service.js')).cancelAwaiting(id, q.revisions.map((r) => r.revision));
    await audit({ entity: 'quotation', entityId: id, action: 'QUOTATION_GENERATED', after: { number, revision, final: fresh.breakdown.final, priceVersionId: fresh.priceVersionId, override: inputs.override ?? null } }, { req, session });
    return u;
  });
  return { quotation: view(out), params: { number: out.number!, revision: out.revisions.length, customer: c.customer!.name } };
}

export async function get(ctx: AuthContext, id: string) { return view(await load(ctx, id)); }
export { view as quotationView, load as loadQuotation, context as quotationContext, check as quotationChecks, premium as quotationPremium, type Ctx as QuotationCtx };
export const QUOTATION_STATUSES = ['DRAFT', 'READY', 'SHARED', 'ACCEPTED', 'REJECTED', 'CANCELLED', 'EXPIRED'] as const;
/**
 * Gap fix (07L Quotations list): status filter (one or several), search by quotation number or customer name /
 * mobile, paging, the count per status for the tabs, and the customer and product on each row.
 * Without page/limit it still returns the newest 200 (older clients).
 */
export async function listFor(ctx: AuthContext, q: { customerId?: string; status?: string; search?: string; page?: number; limit?: number } = {}) {
  const filter: Record<string, unknown> = { accountId: ctx.accountId, ...(q.customerId ? { customerId: q.customerId } : {}) };
  if (q.search?.trim()) {
    const text = q.search.trim();
    const { piiSearch } = await import('../../lib/pii.js');
    const { escapeRegex } = await import('../../lib/pagination.js');
    const people = await Customer.find({ accountId: ctx.accountId, $or: piiSearch(text, { name: true, mobile: 4 }).concat([{ _id: null }]) }, { _id: 1 }).limit(500).lean<Array<{ _id: string }>>();
    filter.$or = [{ number: new RegExp(escapeRegex(text), 'i') }, { customerId: { $in: people.map((p) => p._id) } }];
  }
  const countsRows = await Quotation.aggregate<{ _id: string; n: number }>([{ $match: filter }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
  const counts = Object.fromEntries(QUOTATION_STATUSES.map((s) => [s, countsRows.find((r) => r._id === s)?.n ?? 0]));
  const statuses = q.status?.split(',').map((s) => s.trim()).filter(Boolean) ?? [];
  if (statuses.length) filter.status = statuses.length === 1 ? statuses[0] : { $in: statuses };
  const paged = q.page !== undefined || q.limit !== undefined;
  const limit = Math.min(q.limit ?? cfgNum('CFG-23'), 100);
  const page = q.page ?? 1;
  const [rows, total] = await Promise.all([
    Quotation.find(filter).sort({ updatedAt: -1 }).skip(paged ? (page - 1) * limit : 0).limit(paged ? limit : 200).lean<QuotationDoc[]>(),
    Quotation.countDocuments(filter),
  ]);
  const ids = (k: 'customerId' | 'productId' | 'insurerId') => [...new Set(rows.map((r) => (k === 'customerId' ? r.customerId : (r.inputs as Record<string, string> | null)?.[k])).filter(Boolean) as string[])];
  const [customers, prods, insurers] = await Promise.all([
    Customer.find({ _id: { $in: ids('customerId') }, accountId: ctx.accountId }, { name: 1, number: 1, mobile: 1 }).lean<Array<{ _id: string; name: string; number: string; mobile: string }>>(),
    Product.find({ _id: { $in: ids('productId') } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
    Insurer.find({ _id: { $in: ids('insurerId') } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>(),
  ]);
  const cm = new Map(customers.map((c) => [c._id, c])); const pm = new Map(prods.map((p) => [p._id, p.name])); const im = new Map(insurers.map((i) => [i._id, i.name]));
  const items = rows.map((r) => {
    const v = view(r);
    const c = cm.get(r.customerId);
    const inp = (r.inputs as Record<string, string> | null) ?? {};
    const last = v.revisions.at(-1);
    return {
      ...v,
      customer: c ? { id: c._id, name: c.name, number: c.number, mobile: c.mobile } : null,
      productName: inp.productId ? pm.get(inp.productId) ?? null : null,
      insurerName: inp.insurerId ? im.get(inp.insurerId) ?? null : null,
      premium: last?.final ?? (r.calc as { breakdown?: Breakdown } | null)?.breakdown?.final ?? null,
      validUntil: last?.validUntil ?? null,
    };
  });
  return { items, meta: { page, limit: paged ? limit : 200, total, pages: paged ? Math.max(1, Math.ceil(total / limit)) : 1, counts } };
}
/** The frozen snapshot of a revision (what the PDF shows). */
export async function snapshot(ctx: AuthContext, id: string, revision: number) {
  const q = await load(ctx, id);
  const r = q.revisions.find((x) => x.revision === revision);
  if (!r) throw AppError.notFound();
  return r.snapshot;
}

/** Wizard pick lists: types the advisor may quote, insurers with an ACTIVE agent code (AC-P27-8), products. */
export async function choices(ctx: AuthContext, typeId?: string, insurerId?: string) {
  const acc = await Account.findById(ctx.accountId, { profile: 1 }).lean<{ profile?: { professional?: { categories?: string[] } } }>();
  const cats = acc?.profile?.professional?.categories ?? [];
  // SkyUp categories the advisor works in, and the advisor's own private categories (change #4)
  const types = (await InsuranceType.find({ status: 'ACTIVE', $or: [{ ownerAccountId: null, name: { $in: cats } }, { ownerAccountId: ctx.accountId }] }, { name: 1 }).sort({ name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((t) => ({ id: t._id, name: t.name }));
  const today = istToday();
  const maps = await InsurerMapping.find({ accountId: ctx.accountId, status: 'ACTIVE' }, { insurerId: 1, validUntil: 1 }).lean<Array<{ insurerId: string; validUntil: string | null }>>();
  const okIds = maps.filter((m) => !m.validUntil || m.validUntil >= today).map((m) => m.insurerId);
  const insurers = (await Insurer.find({ _id: { $in: okIds }, status: 'ACTIVE' }, { name: 1 }).sort({ name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((i) => ({ id: i._id, name: i.name }));
  let products: Array<{ id: string; name: string; pricingMode: string; addOns: unknown[]; sumInsured: unknown; policyTerms: unknown; questions: unknown[] }> = [];
  if (typeId && insurerId) {
    const rows = await Product.find({ typeId, insurerId, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId: ctx.accountId }] }).lean<ProductDoc[]>();
    for (const p of rows.filter((x) => effectiveStatus(x) === 'ACTIVE')) {
      const v = await ProductVersion.findById(p.publishedVersionId).lean<ProductVersionDoc>();
      if (!v) continue;
      const d = (v.data ?? {}) as ProductData;
      const tpl = await TemplateVersion.findById(v.templateId, { questions: 1 }).lean<TemplateDoc>();
      products.push({ id: p._id, name: d.name ?? p.code, pricingMode: d.pricingMode ?? '', addOns: d.addOns ?? [], sumInsured: d.sumInsured ?? {}, policyTerms: d.policyTerms ?? [], questions: tpl?.questions ?? [] });
    }
  }
  return { types, insurers, products };
}