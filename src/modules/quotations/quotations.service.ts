import type { Request } from 'express';
import { createHash } from 'node:crypto';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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

const LOGO_MARK_PNG = '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';

/** The quotation PDF: branded layout (navy header + logo, bordered cards, accented total). Amounts print as "Rs." (standard PDF fonts have no the rupee glyph). */
async function buildPdf(snap: Record<string, any>) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mark = await doc.embedPng(Buffer.from(LOGO_MARK_PNG, 'base64'));

  // Brand palette
  const NAVY = rgb(0.0745, 0.1608, 0.2941);
  const INK = rgb(0.0902, 0.1686, 0.302);
  const MUTED = rgb(0.478, 0.525, 0.6);
  const PINK = rgb(0.9686, 0.7255, 0.7686);
  const LINE = rgb(0.9098, 0.9255, 0.9529);
  const PANEL = rgb(0.9686, 0.9765, 0.9882);
  const WHITE = rgb(1, 1, 1);

  const W = 595, M = 50, R = 545;
  const rs = (n: number) => `Rs. ${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const txt = (str: string, x: number, y: number, o: { f?: any; size?: number; color?: any; right?: boolean } = {}) => {
    const f = o.f ?? font, size = o.size ?? 10, color = o.color ?? INK;
    const w = f.widthOfTextAtSize(str, size);
    page.drawText(str, { x: o.right ? x - w : x, y, size, font: f, color });
    return w;
  };
  const wrap = (str: string, f: any, size: number, maxW: number) => {
    const words = String(str).split(/\s+/); const lines: string[] = []; let cur = '';
    for (const wd of words) { const t = cur ? cur + ' ' + wd : wd; if (f.widthOfTextAtSize(t, size) > maxW && cur) { lines.push(cur); cur = wd; } else cur = t; }
    if (cur) lines.push(cur); return lines.length ? lines : [''];
  };

  // ---------- Header band ----------
  page.drawRectangle({ x: 0, y: 742, width: W, height: 100, color: NAVY });
  page.drawRectangle({ x: 0, y: 737, width: W, height: 5, color: PINK });
  page.drawImage(mark, { x: M, y: 768, width: 46, height: 46 });
  txt('Bimayantra', M + 60, 798, { f: bold, size: 23, color: WHITE });
  txt('Insurance advisory', M + 61, 782, { f: font, size: 9.5, color: PINK });
  txt('QUOTATION', R, 812, { f: bold, size: 10, color: PINK, right: true });
  txt(`${snap.number}  R${snap.revision}`, R, 792, { f: bold, size: 15, color: WHITE, right: true });
  txt(String(snap.calculationDate), R, 776, { f: font, size: 9.5, color: rgb(0.78, 0.82, 0.88), right: true });

  let y = 706;
  // Prepared-by row
  txt('PREPARED BY', M, y, { f: bold, size: 8.5, color: MUTED });
  txt(String(snap.advisor.businessName), M + 80, y - 1, { f: bold, size: 12, color: INK });
  y -= 30;

  const sectionLabel = (s: string) => { txt(s, M, y, { f: bold, size: 9, color: MUTED }); y -= 15; };
  const card = (h: number) => { page.drawRectangle({ x: M, y: y - h, width: 495, height: h, color: PANEL, borderColor: LINE, borderWidth: 1 }); };

  // ---------- Quotation details ----------
  sectionLabel('QUOTATION  DETAILS');
  const prod = `${snap.product.name}${snap.product.variantName && snap.product.variantName !== 'Standard' ? ' - ' + snap.product.variantName : ''}`;
  const rows: [string, string][] = [
    ['Customer', `${snap.customer.name} (${snap.customer.number})`],
    ['Insured', snap.people.map((x: any) => `${x.name} (${x.age})`).join(', ')],
    ['Product', `${prod}    UIN ${snap.product.uin}`],
    ['Insurer', String(snap.insurer.name)],
    ['Agent code', String(snap.advisor.agentCode)],
    ['Sum insured', rs(snap.inputs.sumInsured)],
    ['Policy term', `${snap.inputs.policyTerm} year(s)`],
    ['Start date', String(snap.startDate)],
  ];
  const valX = M + 140, valMaxW = 529 - valX, rowGap = 7;
  const rowH = rows.map(([, v]) => wrap(v, font, 10, valMaxW).length * 13 + rowGap);
  const cardH = rowH.reduce((a: number, b: number) => a + b, 0) + 16;
  card(cardH);
  let cy = y - 16;
  rows.forEach(([k, v], i) => {
    const lines = wrap(v, font, 10, valMaxW);
    const rh = rowH[i] ?? 0;
    txt(k, M + 16, cy - 10, { f: font, size: 9.5, color: MUTED });
    lines.forEach((ln, j) => txt(ln, valX, cy - 10 - j * 13, { f: j === 0 ? bold : font, size: 10, color: INK }));
    if (i < rows.length - 1) page.drawLine({ start: { x: M + 16, y: cy - rh + 3 }, end: { x: 529, y: cy - rh + 3 }, thickness: 0.6, color: LINE });
    cy -= rh;
  });
  y -= cardH + 26;

  // ---------- Premium ----------
  sectionLabel('PREMIUM');
  const b = snap.breakdown;
  const items: [string, string, boolean][] = [];
  items.push([`Base premium${b.entryMode === 'TYPED' ? ' (as per insurer)' : ''}`, rs(b.base), false]);
  for (const rdr of b.riders) items.push([`${rdr.name}${rdr.custom ? ' (add-on)' : ''}`, rs(rdr.amount), false]);
  if (b.override !== null && b.override !== undefined) items.push(['Premium used (override)', rs(b.override), false]);
  if (b.discount) items.push(['Discount', '- ' + rs(b.discount), false]);
  items.push([`Tax${b.taxPercent !== null && b.taxPercent !== undefined ? ` (${b.taxPercent}%)` : ''}`, rs(b.tax), false]);
  const itemsH = items.length * 20 + 14;
  const totalH = 40;
  page.drawRectangle({ x: M, y: y - itemsH - totalH, width: 495, height: itemsH + totalH, color: PANEL, borderColor: LINE, borderWidth: 1 });
  let py = y - 20;
  for (const [k, v] of items) { txt(k, M + 16, py, { f: font, size: 10, color: INK }); txt(v, 529, py, { f: font, size: 10, color: INK, right: true }); py -= 20; }
  // total band
  page.drawRectangle({ x: M, y: y - itemsH - totalH, width: 495, height: totalH, color: NAVY });
  txt('Total payable', M + 16, y - itemsH - 25, { f: bold, size: 12, color: WHITE });
  txt(rs(b.final), 529, y - itemsH - 27, { f: bold, size: 15, color: WHITE, right: true });
  y -= itemsH + totalH + 26;

  // ---------- Additional features ----------
  const shown = (snap.benefits ?? []).filter((x: any) => x.showOnPdf);
  if (shown.length) {
    sectionLabel('ADDITIONAL FEATURES  -  INCLUDED');
    for (const x of shown) {
      const s2 = `${x.name}${x.description ? ': ' + x.description : ''}${x.cost ? ' (value ' + rs(x.cost) + ')' : ''}`;
      for (const ln of wrap(s2, font, 9.5, 470)) { page.drawCircle({ x: M + 4, y: y - 4, size: 1.6, color: PINK }); txt(ln, M + 14, y - 7, { f: font, size: 9.5, color: INK }); y -= 15; }
    }
    y -= 12;
  }

  // ---------- Renewal ----------
  if (snap.renewal) {
    if (snap.renewal.previousPremium) { txt(`Last year's premium: ${rs(snap.renewal.previousPremium)}`, M, y - 7, { f: font, size: 9.5, color: MUTED }); y -= 16; }
    if (snap.renewal.portabilityRequested) { for (const ln of wrap('Portability requested: waiting periods already served carry over (subject to the new insurer). Portability form due 45 days before renewal.', font, 9, 495)) { txt(ln, M, y - 7, { f: font, size: 9, color: MUTED }); y -= 13; } }
    y -= 10;
  }

  // ---------- Footer ----------
  let fy = 118;
  page.drawLine({ start: { x: M, y: fy + 14 }, end: { x: R, y: fy + 14 }, thickness: 1, color: LINE });
  txt(`Advisor: ${snap.advisor.name}`, M, fy, { f: bold, size: 9.5, color: INK });
  txt(`Licence ${snap.advisor.licenceNumber ?? '-'}`, R, fy, { f: font, size: 9.5, color: MUTED, right: true });
  fy -= 15;
  txt('Valid for 15 days from the day it is shared.', M, fy, { f: font, size: 9, color: MUTED });
  fy -= 16;
  for (const ln of wrap(String(snap.disclaimer), font, 7.5, 495)) { txt(ln, M, fy, { f: font, size: 7.5, color: MUTED }); fy -= 10; }
  // bottom accent
  page.drawRectangle({ x: 0, y: 0, width: W, height: 6, color: NAVY });
  page.drawRectangle({ x: 0, y: 6, width: W, height: 2, color: PINK });

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
