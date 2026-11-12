import type { Request } from 'express';
import { randomBytes } from 'node:crypto';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import { cfgNum, cfgRange } from '../../config/cfg.js';
import { ageOn, clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';
import { printable, wrap } from '../../lib/pdfText.js';
import { newId } from '../../lib/ids.js';
import { msg } from '../../lib/messages.js';
import { withTx } from '../../lib/mongo.js';
import { nextNumber } from '../accounts/numbers.js';
import { audit } from '../audit/audit.service.js';
import { upload as storeFile } from '../files/files.service.js';
import { notify } from '../notifications/notifications.service.js';
import { getProfile } from '../profile/profile.service.js';
import { can, type AuthContext } from '../rbac/capabilities.js';
import { fitsEntryAge, type ProductData } from '../catalogue/products.service.js';
import { TemplateVersion, type TemplateDoc } from '../catalogue/types.model.js';
import { User } from '../users/user.model.js';
import type { Breakdown } from './engine.js';
import { Quotation } from './quotation.model.js';
import { addOnChecks, pricingInputs, quotationChecks, typedBaseChecks, quotationContext, quotationPremium, quotationView, save as saveQuotation, start as startQuotation, DISCLAIMER, type Inputs } from './quotations.service.js';

/**
 * P-30 comparison quotation: 2 to 3 products side by side from catalogue facts, priced on the SAME common inputs.
 * Its own status and sharing never change a quotation made from it, and the reverse (AC-P30-4). Never a payment link.
 * DRAFT → READY → SHARED → PRODUCT_CHOSEN or EXPIRED.
 */
type Option = { productId: string; riders?: string[]; override?: Inputs['override']; discount?: Inputs['discount']; manual?: Inputs['manual'];
  // Change #13: variant, typed base premium and add-ons per option; variants of one product are separate options
  variantId?: string | null; typedBasePremium?: number | null; riderPrices?: Inputs['riderPrices']; customAddOns?: Inputs['customAddOns'] };
const optionKey = (o: { productId: string; variantId?: string | null }) => `${o.productId}|${o.variantId ?? ''}`;
const extras = (o: Option) => ({ variantId: o.variantId ?? null, typedBasePremium: o.typedBasePremium ?? null, riderPrices: o.riderPrices ?? {}, customAddOns: o.customAddOns ?? [] });
const cqSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cq') },
    accountId: { type: String, required: true }, customerId: { type: String, required: true }, createdBy: { type: String, required: true },
    number: { type: String, default: null },
    status: { type: String, enum: ['DRAFT', 'READY', 'SHARED', 'PRODUCT_CHOSEN', 'EXPIRED'], default: 'DRAFT' },
    inputs: { type: Schema.Types.Mixed, default: {} }, // typeId, people, sumInsured, policyTerm, startDate, answers — common to all options
    options: { type: Schema.Types.Mixed, default: [] },
    recommendedProductId: { type: String, default: null }, recommendedReason: { type: String, default: null },
    snapshot: { type: Schema.Types.Mixed, default: null }, pdfFileId: { type: String, default: null },
    sharedAt: { type: Date, default: null }, validUntil: { type: String, default: null }, viewToken: { type: String, default: null },
    views: { type: [Date], default: [] }, shares: { type: Schema.Types.Mixed, default: [] },
    chosenProductId: { type: String, default: null }, chosenVariantId: { type: String, default: null }, linkedQuotationIds: { type: [String], default: [] },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
cqSchema.index({ accountId: 1, number: 1 }, { unique: true, partialFilterExpression: { number: { $type: 'string' } } });
cqSchema.index({ viewToken: 1 }, { sparse: true });
type CqDoc = InferSchemaType<typeof cqSchema> & { _id: string; updatedAt: Date };
export const Comparison = model('Comparison', cqSchema, 'comparisons');

const NOT_STATED = 'Not stated by insurer';
const CHILD = /^(son|daughter|child|grandson|granddaughter)$/i;
const addDays = (iso: string, n: number) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const view = (c: CqDoc) => ({
  id: c._id, customerId: c.customerId, number: c.number, status: c.status, inputs: c.inputs, options: c.options, recommendedProductId: c.recommendedProductId,
  recommendedReason: c.recommendedReason, snapshot: c.snapshot, pdfFileId: c.pdfFileId, sharedAt: c.sharedAt, validUntil: c.validUntil, viewed: (c.views ?? []).length,
  chosenProductId: c.chosenProductId, chosenVariantId: (c as { chosenVariantId?: string | null }).chosenVariantId ?? null, linkedQuotationIds: c.linkedQuotationIds, version: c.version, updatedAt: c.updatedAt,
});
async function load(ctx: AuthContext, id: string) {
  const c = await Comparison.findOne({ _id: id, accountId: ctx.accountId }).lean<CqDoc>();
  if (!c) throw AppError.notFound();
  return c;
}

/**
 * Price every option on the common inputs. An option that covers fewer people is priced for those it covers and
 * labelled QT-41; one that cannot be priced is an error column (QT-32), never dropped. The table follows P-30 step 6.
 */
async function price(ctx: AuthContext, c: Pick<CqDoc, 'customerId' | 'inputs' | 'options'>) {
  const common = c.inputs as Inputs;
  const columns = [];
  for (const o of c.options as Option[]) {
    const all: Inputs = { ...common, productId: o.productId, riders: o.riders ?? [], override: o.override ?? null, discount: o.discount ?? null, manual: o.manual ?? null, ...extras(o) };
    const pc = await quotationContext(ctx, { customerId: c.customerId }, { ...all, insurerId: undefined });
    const insurerId = pc.product?.insurerId;
    const ctxFull = await quotationContext(ctx, { customerId: c.customerId }, { ...all, insurerId });
    const name = ctxFull.data.name ?? ctxFull.product?.code ?? 'This product';
    const chosen = (common.people ?? []).map((k) => ctxFull.everyone.find((e) => e.key === k)).filter(Boolean) as typeof ctxFull.everyone;
    const out = chosen.filter((p) => p.dob && !(fitsEntryAge(ctxFull.data, ageOn(p.dob), 'ADULT') || (CHILD.test(p.relationship) && fitsEntryAge(ctxFull.data, ageOn(p.dob), 'CHILD'))));
    const covered = chosen.filter((p) => !out.includes(p));
    const vName = ctxFull.variant && ctxFull.variant.name !== 'Standard' ? ctxFull.variant.name : null;
    const base = { productId: o.productId, variantId: ctxFull.variant?._id ?? null, variantName: ctxFull.variant?.name ?? null, name: vName ? `${name} · ${vName}` : name, insurer: ctxFull.insurer?.name ?? null, uin: ctxFull.data.uin ?? null, agentCode: ctxFull.mapping?.agentCode ?? null };
    // P-27 checks for this option (steps 1–5 and 7), people/sum insured handled here so a partial cover is labelled, not refused
    const problems = quotationChecks(ctx, ctxFull, { ...all, insurerId, people: covered.map((p) => p.key) }, 5);
    // typed premium and add-ons are checked like a quotation's steps 7 and 8 (QT-47, QT-48, QT-49)
    if (!problems.length) { const ii = { ...all, insurerId, people: covered.map((p) => p.key) }; problems.push(...addOnChecks(ctxFull, ii), ...typedBaseChecks(ctxFull, ii)); }
    if (!problems.length && !covered.length) problems.push({ field: 'people', messageId: 'QT-06', params: { Name: out[0]?.name ?? '', age: 0, min: ctxFull.data.adultMin ?? 0, max: ctxFull.data.adultMax ?? 0 } });
    if (problems.length) { const params = { Product: name, reason: msg(problems[0]!.messageId, problems[0]!.params ?? {}) }; columns.push({ ...base, error: { messageId: 'QT-32', message: msg('QT-32', params), params } }); continue; }
    let r: { breakdown: Breakdown; priceVersionId: string | null };
    try { r = quotationPremium(ctxFull, { ...all, insurerId, people: covered.map((p) => p.key) }); }
    catch (e) { const params = { Product: name, reason: e instanceof AppError ? e.message : (e as Error).message }; columns.push({ ...base, error: { messageId: 'QT-32', message: msg('QT-32', params), params } }); continue; }
    const tpl = await TemplateVersion.findById(ctxFull.version!.templateId, { features: 1 }).lean<TemplateDoc>();
    columns.push({
      ...base, breakdown: r.breakdown, priceVersionId: r.priceVersionId, premium: r.breakdown.final,
      covers: covered.length, of: chosen.length, ...(out.length ? { coverage: { messageId: 'QT-41', message: msg('QT-41', { n: covered.length, m: chosen.length, names: out.map((p) => p.name).join(', ') }) } } : {}),
      data: ctxFull.data, features: tpl?.features ?? [],
    });
  }
  const priced = columns.filter((x) => !('error' in x)) as Array<Record<string, any>>;
  const full = priced.filter((x) => x.covers === x.of);
  const lowest = (full.length ? full : priced).reduce((m: Record<string, any> | null, x) => (!m || x.premium < m.premium ? x : m), null);
  // The table rows in P-30 step 6 order; any missing value shows "Not stated by insurer" (AC-P30-2)
  const fact = (col: Record<string, any>, re: RegExp) => {
    const f = (col.features as TemplateDoc['features']).find((x) => re.test(x.name));
    const v = f ? (col.data as ProductData).features?.[f.key] : undefined;
    return !v || v.notStated || v.value === null || v.value === undefined || v.value === '' ? NOT_STATED : v.value === true ? 'Yes' : v.value === false ? 'No' : String(v.value);
  };
  const FIXED: Array<[string, RegExp]> = [['Room rent', /room rent/i], ['Co-pay', /co-?pay/i], ['Pre-existing disease waiting period', /pre-?existing.*wait|waiting.*pre-?existing/i], ['Restore benefit', /restor/i], ['Claim settlement ratio', /claim settlement/i], ['Network hospitals', /network hospital/i]];
  const rest = [...new Set(priced.flatMap((x) => (x.features as TemplateDoc['features']).map((f) => f.name)))].filter((n) => !FIXED.some(([, re]) => re.test(n)));
  const rows = [
    ...FIXED.map(([label, re]) => ({ label, values: priced.map((x) => fact(x, re)) })),
    ...rest.map((n) => ({ label: n, values: priced.map((x) => fact(x, new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`))) })),
    { label: 'Riders', values: priced.map((x) => ((c.options as Option[]).find((o) => o.productId === x.productId)?.riders ?? []).join(', ') || 'None') },
  ];
  return {
    columns: columns.map((x) => { const { data: _d, features: _f, ...keep } = x as Record<string, unknown>; return { ...keep, lowest: lowest ? (x as Record<string, unknown>).productId === lowest.productId : false }; }),
    rows: [{ label: 'Sum insured', values: priced.map(() => common.sumInsured ?? null) }, ...rows],
  };
}

export async function start(ctx: AuthContext, customerId: string, req: Request) {
  const q = await startQuotation(ctx, customerId, req); // the same step-1 checks (customer ACTIVE, licence)
  await Quotation.deleteOne({ _id: q.id }); // only the checks were needed
  const c = await Comparison.create({ accountId: ctx.accountId, customerId, createdBy: ctx.userId });
  await audit({ entity: 'comparison', entityId: c._id, action: 'COMPARISON_DRAFT_STARTED', after: { customerId } }, { req });
  return view(c.toObject() as CqDoc);
}

/** Save the common inputs, the options and the recommendation (DRAFT only). Override and discount are the advisor's. */
export async function saveDraft(ctx: AuthContext, id: string, b: { version: number; inputs: Inputs; options: Option[]; recommendedProductId?: string | null; recommendedReason?: string | null }) {
  const c = await load(ctx, id);
  if (c.status !== 'DRAFT') throw AppError.invalidState('comparison', c.status);
  if (b.options.some((o) => pricingInputs(o as Inputs)) && !can(ctx.role, 'quotations.pricing')) throw AppError.forbidden();
  const seen = new Set<string>();
  for (const o of b.options) {
    if (seen.has(optionKey(o))) throw AppError.field('options', 'QT-36', { Product: o.productId });
    seen.add(optionKey(o));
  }
  const u = await Comparison.findOneAndUpdate({ _id: id, version: b.version, status: 'DRAFT' }, { $set: { inputs: b.inputs, options: b.options, recommendedProductId: b.recommendedProductId ?? null, recommendedReason: b.recommendedReason ?? null }, $inc: { version: 1 } }, { new: true }).lean<CqDoc>();
  if (!u) throw AppError.versionConflict('comparison', view(c));
  return view(u);
}

export async function preview(ctx: AuthContext, id: string) {
  const c = await load(ctx, id);
  return price(ctx, c);
}

/**
 * The comparison PDF: A4 landscape, a label column and one column per product. Every value is wrapped inside its
 * column and new pages are added as needed (the product names repeat at the top of each). All text goes through
 * pdfText (standard fonts cannot print ₹, ≥… and would fail the PDF, QT-13); amounts print as "Rs.".
 */
export async function buildPdf(snap: Record<string, any>) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const W = 842; const H = 595; const M = 36; const LABEL = 170; const GAP = 10; const SIZE = 8; const LEAD = 10.5;
  const cols = snap.columns as Array<Record<string, any>>;
  const colW = (W - 2 * M - LABEL) / Math.max(cols.length, 1);
  const rs = (n: number) => `Rs. ${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  let page: PDFPage = doc.addPage([W, H]);
  let y = H - M;
  const put = (t: string, x: number, f: PDFFont = font, size = SIZE) => page.drawText(printable(f, t), { x, y, size, font: f });
  const block = (t: unknown, x: number, width: number, f: PDFFont = font, size = SIZE) => { // a wrapped paragraph across the page
    for (const l of wrap(f, t, size, width)) { if (y < M + size) newPage(false); page.drawText(l, { x, y, size, font: f }); y -= size + 3; }
  };
  const names = cols.map((c) => `${c.name}${c.productId === snap.recommendedProductId ? ' (Recommended)' : ''}`);
  // one table row: the label and each value wrapped in its column; the row moves to a new page when it does not fit
  const row = (label: string, values: unknown[], f: PDFFont = font, shade = false) => {
    const lines = [wrap(bold, label, SIZE, LABEL - GAP), ...values.map((v) => wrap(f, v, SIZE, colW - GAP))];
    const h = Math.max(...lines.map((l) => l.length)) * LEAD + 4;
    if (y - h < M + 20) newPage(true);
    if (shade) page.drawRectangle({ x: M - 4, y: y - h + LEAD - 3, width: W - 2 * M + 8, height: h, color: rgb(0.95, 0.96, 0.98) });
    lines.forEach((ls, i) => ls.forEach((l, k) => page.drawText(l, { x: i === 0 ? M : M + LABEL + (i - 1) * colW, y: y - k * LEAD, size: SIZE, font: i === 0 ? bold : f })));
    y -= h;
    page.drawLine({ start: { x: M - 4, y: y + LEAD - 4 }, end: { x: W - M + 4, y: y + LEAD - 4 }, thickness: 0.4, color: rgb(0.85, 0.87, 0.9) });
  };
  function newPage(repeatHeader: boolean) {
    page = doc.addPage([W, H]); y = H - M;
    if (repeatHeader) { put(`Comparison ${snap.number} (continued)`, M, bold, 9); y -= 16; row('Product', names, bold, true); }
  }

  put(snap.advisor.businessName, M, bold, 14); y -= 18;
  put(`Comparison ${snap.number} · ${snap.date} · for ${snap.customer.name}`, M, bold, 11); y -= 22;
  row('Product', names, bold, true);
  row('Insurer / UIN', cols.map((c) => `${c.insurer} / ${c.uin}`));
  row('Agent code', cols.map((c) => c.agentCode ?? '-'));
  row('Annual premium', cols.map((c) => (c.error ? 'Cannot be offered' : `${rs(c.premium)}${c.lowest ? ' (lowest)' : ''}`)), bold);
  row('Members covered', cols.map((c) => (c.coverage ? c.coverage.message : c.error ? '-' : `All ${c.of}`)));
  for (const r of snap.rows as Array<{ label: string; values: unknown[] }>) row(r.label, r.values.map((v) => (typeof v === 'number' ? rs(v) : String(v ?? '-'))));
  y -= 8;
  if (snap.recommendedReason) { block(`Why we recommend ${cols.find((c) => c.productId === snap.recommendedProductId)?.name}: ${snap.recommendedReason}`, M, W - 2 * M); y -= 4; }
  block(`Advisor: ${snap.advisor.name}   Valid for 15 days from the day it is shared.`, M, W - 2 * M);
  y -= 4;
  block(snap.disclaimer, M, W - 2 * M, font, 7);
  return Buffer.from(await doc.save());
}

/** Generate (QT-33): 2 to 3 products of one type, a reason for the recommendation, every option priced. */
export async function generate(ctx: AuthContext, id: string, req: Request) {
  const c = await load(ctx, id);
  if (c.status !== 'DRAFT') throw AppError.invalidState('comparison', c.status);
  const opts = c.options as Option[];
  if (opts.length < cfgNum('CFG-44') || opts.length > cfgNum('CFG-45')) throw new AppError(400, 'VALIDATION_FAILED', 'QT-30', { 'CFG-44': cfgNum('CFG-44'), 'CFG-45': cfgNum('CFG-45') }); // AC-P30-1
  const table = await price(ctx, c);
  const types = new Set<string>();
  for (const o of opts) { const pc = await quotationContext(ctx, { customerId: c.customerId }, { productId: o.productId }); if (pc.product) types.add(pc.product.typeId); }
  if (types.size > 1 || [...types][0] !== (c.inputs as Inputs).typeId) throw new AppError(400, 'VALIDATION_FAILED', 'QT-31');
  const bad = table.columns.find((x) => 'error' in x) as unknown as { error: { params: Record<string, string> } } | undefined;
  if (bad) throw new AppError(400, 'VALIDATION_FAILED', 'QT-32', bad.error.params, { columns: table.columns });
  if (c.recommendedProductId) {
    const { min, max } = cfgRange('CFG-157');
    const len = (c.recommendedReason ?? '').trim().length;
    const name = (table.columns.find((x) => (x as unknown as { productId: string }).productId === c.recommendedProductId) as unknown as { name?: string } | undefined)?.name ?? '';
    if (len < min || len > max) throw AppError.field('recommendedReason', 'QT-40', { product: name }); // AC-P30-6
  }
  const customer = (await quotationContext(ctx, { customerId: c.customerId }, {})).customer!;
  const prof = await getProfile(ctx);
  const user = await User.findById(ctx.userId, { name: 1 }).lean<{ name: string }>();
  const today = istToday();
  const out = await withTx(async (session) => {
    const number = await nextNumber(ctx.accountId!, 'comparison', session);
    const snap = {
      number, date: today.split('-').reverse().join('-'), customer: { id: customer._id, name: customer.name }, inputs: c.inputs, ...table,
      recommendedProductId: c.recommendedProductId, recommendedReason: c.recommendedReason,
      advisor: { name: user?.name ?? ctx.name, businessName: (prof.sections as { business?: { displayName?: string | null } }).business?.displayName ?? user?.name ?? ctx.name },
      disclaimer: DISCLAIMER.replace('{date}', today.split('-').reverse().join('-')),
    };
    let pdf: Buffer;
    try { pdf = await buildPdf(snap); } catch (err) { logger.error({ err, comparison: id }, 'Comparison PDF could not be created'); throw new AppError(500, 'INTERNAL_ERROR', 'QT-13'); }
    const file = await storeFile(ctx, 'QUOTATION_PDF', pdf, `${number}.pdf`, req);
    const u = await Comparison.findOneAndUpdate({ _id: id, version: c.version, status: 'DRAFT' }, { $set: { number, status: 'READY', snapshot: snap, pdfFileId: file.id }, $inc: { version: 1 } }, { new: true, session: session ?? undefined }).lean<CqDoc>();
    if (!u) throw AppError.versionConflict('comparison', null);
    await audit({ entity: 'comparison', entityId: id, action: 'COMPARISON_GENERATED', after: { number, products: opts.map((o) => o.productId) } }, { req, session });
    return u;
  });
  return { comparison: view(out), params: { number: out.number!, customer: customer.name } };
}

/** Share like P-28 (validity CFG-46 from the first share); never a payment link (AC-P30-5). */
export async function share(ctx: AuthContext, id: string, channel: 'EMAIL' | 'WHATSAPP' | 'LINK' | 'DOWNLOAD', req: Request) {
  const c = await load(ctx, id);
  if (!['READY', 'SHARED', 'PRODUCT_CHOSEN'].includes(c.status)) throw AppError.invalidState('comparison', c.status);
  const prof = await getProfile(ctx);
  const missing = prof.completion.missing.filter((g: { section: string }) => ['Personal', 'Contact', 'Professional'].includes(g.section)).flatMap((g: { missing: string[] }) => g.missing);
  if (missing.length) throw new AppError(409, 'INVALID_STATE', 'PRF-03', { 'missing items': missing.join(', ') });
  const first = channel !== 'DOWNLOAD' && !c.sharedAt;
  const token = c.viewToken ?? randomBytes(32).toString('base64url');
  const u = await Comparison.findOneAndUpdate({ _id: id, version: c.version }, { $set: {
    viewToken: token, shares: [...((c.shares as unknown[]) ?? []), { channel, at: clock.now(), by: ctx.userId, status: channel === 'EMAIL' ? 'QUEUED' : 'DONE' }],
    ...(first ? { sharedAt: clock.now(), validUntil: addDays(today(), cfgNum('CFG-46')), ...(c.status === 'READY' ? { status: 'SHARED' } : {}) } : {}),
  }, $inc: { version: 1 } }, { new: true }).lean<CqDoc>();
  if (!u) throw AppError.versionConflict('comparison', view(c));
  await audit({ entity: 'comparison', entityId: id, action: 'COMPARISON_SHARED', after: { channel, first } }, { req });
  const link = `${process.env.PUBLIC_APP_URL ?? 'http://localhost:5173'}/c/${token}`;
  const name = (u.snapshot as { customer: { name: string } }).customer.name;
  return { comparison: view(u), link, pdfFileId: u.pdfFileId, whatsappUrl: channel === 'WHATSAPP' ? `https://wa.me/?text=${encodeURIComponent(`Dear ${name}, here is your insurance comparison ${u.number}: ${link}`)}` : null };
}
const today = () => istToday();

/** The customer's comparison page (no sign-in). Never a payment link. QT-20 once expired. */
export async function publicView(token: string) {
  const c = await Comparison.findOne({ viewToken: token }).lean<CqDoc>();
  if (!c) throw AppError.notFound();
  const adv = await User.findOne({ accountId: c.accountId, role: 'ADV' }, { name: 1, mobile: 1 }).lean<{ name: string; mobile: string }>();
  if (!c.validUntil || c.validUntil < istToday() || c.status === 'EXPIRED') return { valid: false, messageId: 'QT-20', message: msg('QT-20', { 'advisor name': adv?.name ?? '', 'advisor mobile': adv?.mobile ?? '' }) };
  await Comparison.updateOne({ _id: c._id }, { $push: { views: clock.now() } });
  return { valid: true, ...(c.snapshot as object), validUntil: c.validUntil.split('-').reverse().join('-'), advisorMobile: adv?.mobile ?? null };
}

/** Customer chose this (QT-34): PRODUCT_CHOSEN. */
export async function choose(ctx: AuthContext, id: string, b: { version: number; productId: string; variantId?: string | null }, req: Request) {
  const c = await load(ctx, id);
  if (!['SHARED', 'READY', 'PRODUCT_CHOSEN'].includes(c.status)) throw AppError.invalidState('comparison', c.status);
  // With variants as separate options, a product offered more than once needs the variant (else the first option)
  // The screen sends the column's variant, which is the product's default variant when the option had none chosen:
  // an exact match first, else the product's only option (a product offered twice still needs its variant)
  const same = (c.options as Option[]).filter((o) => o.productId === b.productId);
  const opt = same.find((o) => b.variantId === undefined || (o.variantId ?? null) === (b.variantId ?? null)) ?? (same.length === 1 ? same[0] : undefined);
  if (!opt) throw AppError.field(same.length ? 'variantId' : 'productId', 'VAL-22');
  const u = await Comparison.findOneAndUpdate({ _id: id, version: b.version }, { $set: { status: 'PRODUCT_CHOSEN', chosenProductId: b.productId, chosenVariantId: opt.variantId ?? null }, $inc: { version: 1 } }, { new: true }).lean<CqDoc>();
  if (!u) throw AppError.versionConflict('comparison', view(c));
  await audit({ entity: 'comparison', entityId: id, action: 'COMPARISON_PRODUCT_CHOSEN', after: { productId: b.productId } }, { req });
  const name = ((u.snapshot as { columns: Array<{ productId: string; name: string }> }).columns.find((x) => x.productId === b.productId))?.name ?? '';
  return { comparison: view(u), params: { Customer: (u.snapshot as { customer: { name: string } }).customer.name, product: name } };
}

/**
 * Create quotation (AC-P30-3): a separate, separately numbered P-27 quotation with the chosen product and the same inputs.
 * The full P-27 checks run; the premium is never copied — P-27 calculates it. Retrying is safe.
 */
export async function createQuotation(ctx: AuthContext, id: string, req: Request) {
  const c = await load(ctx, id);
  if (c.status !== 'PRODUCT_CHOSEN' || !c.chosenProductId) throw AppError.invalidState('comparison', c.status);
  const chosenVariant = (c as { chosenVariantId?: string | null }).chosenVariantId ?? null;
  const opt = (c.options as Option[]).find((o) => o.productId === c.chosenProductId && (o.variantId ?? null) === chosenVariant) ?? (c.options as Option[]).find((o) => o.productId === c.chosenProductId)!;
  const pc = await quotationContext(ctx, { customerId: c.customerId }, { productId: opt.productId });
  const q = await startQuotation(ctx, c.customerId, req);
  const inputs: Inputs = { ...(c.inputs as Inputs), productId: opt.productId, insurerId: pc.product?.insurerId, riders: opt.riders ?? [], override: opt.override ?? null, discount: opt.discount ?? null, manual: opt.manual ?? null, ...extras(opt) };
  let saved;
  try { saved = await saveQuotation(ctx, q.id, { version: q.version, step: 8, inputs }, req); }
  catch { saved = quotationView((await Quotation.findById(q.id).lean())!); } // the draft keeps its inputs; P-27 shows what to fix
  await Comparison.updateOne({ _id: id }, { $addToSet: { linkedQuotationIds: q.id } });
  await audit({ entity: 'comparison', entityId: id, action: 'COMPARISON_QUOTATION_CREATED', after: { quotationId: q.id } }, { req });
  return saved;
}

/** Comparisons past their validity become EXPIRED (repeat-safe; part of the minute sweep). */
export async function expireComparisons(today_ = istToday()) {
  const r = await Comparison.updateMany({ status: { $in: ['SHARED'] }, validUntil: { $lt: today_ } }, { $set: { status: 'EXPIRED' }, $inc: { version: 1 } });
  return r.modifiedCount;
}

export async function get(ctx: AuthContext, id: string) { return view(await load(ctx, id)); }
export async function list(ctx: AuthContext) { return (await Comparison.find({ accountId: ctx.accountId }).sort({ updatedAt: -1 }).limit(200).lean<CqDoc[]>()).map(view); }
void notify;