import type { Request } from 'express';
import { Schema, model } from 'mongoose';
import { cfgBool, cfgList, cfgNum, cfgRange } from '../../config/cfg.js';
import { ageOn, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { msg } from '../../lib/messages.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { Insurer } from '../insurers/insurer.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { priceOn } from '../catalogue/prices.service.js';
import { Product, ProductVersion, type ProductDoc, type ProductVersionDoc } from '../catalogue/product.model.js';
import { effectiveStatus, fitsEntryAge, type ProductData } from '../catalogue/products.service.js';
import { InsuranceType, TemplateVersion, type TemplateDoc } from '../catalogue/types.model.js';
import { ProductVariant, defaultVariantFor } from '../catalogue/variant.model.js';
import { variantsOf, type FeatureValue } from '../catalogue/variants.service.js';

/**
 * P-26 best-fit ranking. Fixed scores from catalogue facts and the advisor's own prices only (no guesswork); every
 * score carries its reason. An AI summary may only explain, never reorder (AC-P26-5).
 */
export const PRIORITIES = ['LOWEST_PREMIUM', 'BEST_COVERAGE', 'CLAIM_RELIABILITY', 'PRE_EXISTING'] as const;
export type Priority = (typeof PRIORITIES)[number];
const PARTS = ['budget', 'roomRent', 'coPay', 'waiting', 'claimRatio'] as const;
const NOT_STATED = 'Not stated by insurer';

/** CFG-168: five weights per priority, in the PRIORITIES order. */
export function weights(p: Priority): number[] {
  const all = cfgList('CFG-168') as unknown as number[];
  const i = PRIORITIES.indexOf(p) * 5;
  return all.slice(i, i + 5);
}

const logSchema = new Schema({
  _id: { type: String, default: () => newId('rnk') },
  accountId: { type: String, required: true }, userId: { type: String, required: true }, customerId: { type: String, required: true },
  answers: { type: Schema.Types.Mixed, required: true }, results: { type: Schema.Types.Mixed, default: [] },
  chosenProductId: { type: String, default: null },
  chosenVariantId: { type: String, default: null }, // change #2
}, { timestamps: true, versionKey: false, minimize: false });
export const RankingLog = model('RankingLog', logSchema, 'ranking_logs');

// ── CFG-179 part scores. The facts are template features, found by name (OPEN-QUESTIONS Q44). ──
type Fact = { value?: unknown; notStated?: boolean } | undefined;
const findKey = (features: Array<{ key: string; name: string }>, re: RegExp) => features.find((f) => re.test(f.name))?.key;
const missing = (f: Fact) => !f || f.notStated || f.value === undefined || f.value === null || f.value === '';
const num = (v: unknown) => (typeof v === 'number' ? v : Number(String(v ?? '').replace(/[^\d.]/g, '')));

export function budgetScore(premium: number | null, budget: number) {
  if (premium === null) return { score: 0, reason: 'Premium is entered from the insurer portal at quotation' };
  const over = ((premium - budget) / budget) * 100;
  const score = over <= 0 ? 100 : Math.max(0, Math.round(100 - 2 * over));
  return { score, reason: over <= 0 ? `₹${premium.toLocaleString('en-IN')} is within the budget` : `₹${premium.toLocaleString('en-IN')} is ${Math.round(over)}% over the budget` };
}
export function roomRentScore(f: Fact, dataType?: string) {
  if (missing(f)) return { score: 0, reason: `Room rent: ${NOT_STATED}` };
  const v = String(f!.value).toLowerCase();
  if (/no (limit|cap)|unlimited|any room/.test(v)) return { score: 100, reason: 'Room rent: no limit' };
  if (/single|private/.test(v)) return { score: 80, reason: 'Room rent: single private room' };
  if (dataType === 'Percentage' || /%/.test(v)) return { score: 50, reason: `Room rent: ${num(f!.value)}% of sum insured` };
  return { score: 30, reason: `Room rent: capped at ₹${num(f!.value).toLocaleString('en-IN')}` };
}
export function coPayScore(f: Fact) {
  if (missing(f)) return { score: 0, reason: `Co-pay: ${NOT_STATED}` };
  const v = f!.value;
  const pct = typeof v === 'boolean' ? (v ? NaN : 0) : /none|nil|no co/i.test(String(v)) ? 0 : num(v);
  if (!Number.isFinite(pct)) return { score: 0, reason: `Co-pay: ${NOT_STATED}` };
  const score = pct === 0 ? 100 : pct <= 10 ? 60 : pct <= 20 ? 30 : 0;
  return { score, reason: pct === 0 ? 'Co-pay: none' : `Co-pay: ${pct}%` };
}
export function waitingScore(f: Fact, dataType?: string) {
  if (missing(f)) return { score: 0, reason: `Pre-existing waiting period: ${NOT_STATED}` };
  const n = num(f!.value);
  const years = dataType === 'Months' ? n / 12 : dataType === 'Days' ? n / 365 : n;
  const score = years <= 1 ? 100 : years <= 2 ? 75 : years <= 3 ? 50 : years <= 4 ? 25 : 0;
  return { score, reason: `Pre-existing waiting period: ${Math.round(years * 10) / 10} years` };
}
export function claimScore(f: Fact) {
  if (missing(f)) return { score: 0, reason: `Claim settlement ratio: ${NOT_STATED}` };
  const r = num(f!.value);
  return { score: Math.max(0, Math.min(100, Math.round((r - 80) * 5))), reason: `Claim settlement ratio: ${r}%` };
}

interface Person { key: string; name: string; dob: string | null; relationship: string }
const CHILD = /^(son|daughter|child|grandson|granddaughter)$/i;

/** The premium from the advisor's CURRENT price for these people (null when it needs the quotation). */
async function premiumFor(accountId: string, p: ProductDoc, d: ProductData, tpl: TemplateDoc | null, ages: Array<{ age: number; child: boolean }>, sumInsured: number, customerAge: number) {
  if (d.pricingMode !== 'RATE_TABLE') return { premium: null as number | null, priceVersionId: null as string | null };
  const price = await priceOn(accountId, p._id);
  if (!price) return { premium: null, priceVersionId: null, noPrice: true };
  const want: Record<string, number> = {
    'Age of the eldest insured person': Math.max(...ages.map((a) => a.age)), 'Age of the proposer': customerAge,
    'Number of adults': ages.filter((a) => !a.child).length, 'Number of children': ages.filter((a) => a.child).length,
    'Sum insured': sumInsured, 'Policy term': d.policyTerms?.[0] ?? 1,
  };
  const factors = tpl?.factors ?? [];
  if (factors.some((f) => f.source === 'Asked in the quotation')) return { premium: null, priceVersionId: price._id };
  const label = (f: TemplateDoc['factors'][number]) => {
    const v = want[f.source];
    if (f.kind === 'BAND') { const b = f.bands.find((x) => v! >= (x.from ?? 0) && v! <= (x.to ?? -1)); return b ? `${b.from}-${b.to}` : null; }
    return String(v);
  };
  const keys = Object.fromEntries(factors.map((f) => [f.key, label(f)]));
  const row = (price.rows as Array<{ factors: Record<string, string>; basePremium: number }>).find((r) => factors.every((f) => r.factors[f.key] === keys[f.key]));
  if (!row) return { premium: null, priceVersionId: price._id };
  return { premium: Math.round(row.basePremium * (1 + price.taxPercent / 100) * 100) / 100, priceVersionId: price._id };
}

export interface RankBody { typeId: string; people: string[]; budget: number; priority: Priority; sumInsured: number }

export async function rank(ctx: AuthContext, customerId: string, b: RankBody, req: Request) {
  const c = await Customer.findOne({ _id: customerId, accountId: ctx.accountId }).lean<{ _id: string; name: string; dob: string | null; status: string }>();
  if (!c) throw AppError.notFound();
  if (c.status !== 'ACTIVE') throw AppError.invalidState('customer', c.status);
  const acc = await Account.findById(ctx.accountId, { profile: 1 }).lean<{ profile?: { professional?: { categories?: string[]; licenceValidUntil?: string | null } } }>();
  const until = acc?.profile?.professional?.licenceValidUntil;
  if (until && until < istToday()) throw AppError.invalidState('licence', 'EXPIRED');
  // People: the customer and household members; each needs a date of birth (QT-05).
  const fam = await FamilyMember.find({ customerId, accountId: ctx.accountId, status: 'ACTIVE' }, { name: 1, dob: 1, relationship: 1 }).lean<Array<{ _id: string; name: string; dob: string | null; relationship: string }>>();
  const all: Person[] = [{ key: `C:${c._id}`, name: c.name, dob: c.dob, relationship: 'Self' }, ...fam.map((f) => ({ key: `F:${f._id}`, name: f.name, dob: f.dob, relationship: f.relationship }))];
  const people = b.people.map((k) => all.find((p) => p.key === k) ?? (() => { throw AppError.field('people', 'VAL-22'); })());
  for (const p of people) if (!p.dob) throw AppError.field('people', 'QT-05', { name: p.name });
  const ages = people.map((p) => ({ name: p.name, age: ageOn(p.dob!), child: CHILD.test(p.relationship) }));
  const customerAge = c.dob ? ageOn(c.dob) : ages[0]!.age;

  // Change #4: an advisor's private category is not offered in Best fit (it has no SkyUp template to score on)
  const type = await InsuranceType.findOne({ _id: b.typeId, ownerAccountId: null }, { name: 1, status: 1 }).lean<{ name: string; status: string }>();
  if (!type) throw AppError.field('typeId', 'VAL-22');
  const categories = acc?.profile?.professional?.categories ?? [];
  const mapped = new Set((await InsurerMapping.find({ accountId: ctx.accountId, status: 'ACTIVE' }, { insurerId: 1 }).lean<Array<{ insurerId: string }>>()).map((m) => m.insurerId));
  const activeInsurers = new Map((await Insurer.find({ status: 'ACTIVE' }, { name: 1 }).lean<Array<{ _id: string; name: string }>>()).map((i) => [i._id, i.name]));
  const candidates = type.status === 'ACTIVE' && categories.includes(type.name)
    ? await Product.find({ typeId: b.typeId, $or: [{ kind: 'VERIFIED', status: { $in: ['ACTIVE', 'UPCOMING'] } }, { kind: 'OWN', accountId: ctx.accountId }] }).lean<ProductDoc[]>()
    : [];
  const w = weights(b.priority);
  const results = [];
  for (const p of candidates) {
    // AC-P26-1: ACTIVE now, insurer ACTIVE with this advisor's ACTIVE agent code, sum insured on offer, a price.
    if (effectiveStatus(p) !== 'ACTIVE' || !activeInsurers.has(p.insurerId) || !mapped.has(p.insurerId)) continue;
    const v = await ProductVersion.findById(p.publishedVersionId).lean<ProductVersionDoc>();
    if (!v) continue;
    const d = (v.data ?? {}) as ProductData;
    const si = d.sumInsured ?? {};
    if (!(si.options?.includes(b.sumInsured) || (si.min && si.max && b.sumInsured >= si.min && b.sumInsured <= si.max))) continue;
    const tpl = await TemplateVersion.findById(v.templateId, { features: 1, factors: 1 }).lean<TemplateDoc>();
    const pr = await premiumFor(ctx.accountId!, p, d, tpl, ages, b.sumInsured, customerAge);
    if ((pr as { noPrice?: boolean }).noPrice) continue; // RATE_TABLE without a current price is not quotable
    const feats = (tpl?.features ?? []) as Array<{ key: string; name: string; dataType: string }>;
    // Change #2: each variant is ranked on its own values (merged over the product's); a variant whose sum-insured
    // range does not include the answer is left out. Price, ages and terms belong to the product (Q4 default).
    if (!(await ProductVariant.exists({ productVersionId: v._id }))) await defaultVariantFor(v as never);
    const vars = await variantsOf(v._id, (d.features ?? {}) as Record<string, FeatureValue>);
    for (const vr of vars) {
      if ((vr.sumInsuredMin !== null && b.sumInsured < vr.sumInsuredMin) || (vr.sumInsuredMax !== null && b.sumInsured > vr.sumInsuredMax)) continue;
      const fact = (re: RegExp) => { const k = findKey(feats, re); return { f: k ? (vr.features[k] as Fact) : undefined, dt: feats.find((x) => x.key === k)?.dataType }; };
      const rr = fact(/room rent/i); const cp = fact(/co-?pay/i); const wt = fact(/pre-?existing.*wait|waiting.*pre-?existing/i); const cs = fact(/claim settlement/i);
      const parts = {
        budget: budgetScore(pr.premium, b.budget), roomRent: roomRentScore(rr.f, rr.dt), coPay: coPayScore(cp.f),
        waiting: waitingScore(wt.f, wt.dt), claimRatio: claimScore(cs.f),
      };
      const total = Math.round(PARTS.reduce((t, k, i) => t + parts[k].score * w[i]!, 0) / w.reduce((a, x) => a + x, 0) * 10) / 10;
      // Each person against the adult and child bands (AC-P26-3).
      const out = ages.filter((a) => !(fitsEntryAge(d, a.age, 'ADULT') || (a.child && fitsEntryAge(d, a.age, 'CHILD'))));
      const covers = ages.length - out.length;
      const base = d.name ?? p.name ?? p.code;
      results.push({
        productId: p._id, variantId: vr.id, variantName: vr.name, kind: p.kind, name: vars.length > 1 ? `${base} · ${vr.name}` : base, insurer: activeInsurers.get(p.insurerId), premium: pr.premium, priceVersionId: pr.priceVersionId,
        total, parts, covers, of: ages.length,
        ...(out.length ? { coverage: { messageId: 'QT-41', message: msg('QT-41', { n: covers, m: ages.length, names: out.map((o) => o.name).join(', ') }) } } : {}),
      });
    }
  }
  // Full coverage first, then the total, then the lower premium.
  results.sort((x, y) => (Number(y.covers === y.of) - Number(x.covers === x.of)) || (y.total - x.total) || ((x.premium ?? Infinity) - (y.premium ?? Infinity)));
  const log = await RankingLog.create({ accountId: ctx.accountId, userId: ctx.userId, customerId, answers: b, results: results.map((r) => ({ productId: r.productId, variantId: r.variantId, total: r.total, parts: Object.fromEntries(PARTS.map((k) => [k, r.parts[k].score])), covers: r.covers })) });
  await audit({ entity: 'customer', entityId: customerId, action: 'BEST_FIT_RANKED', after: { rankingId: log._id, typeId: b.typeId, products: results.length } }, { req });
  const message = results.length ? { messageId: 'FIT-03', message: msg('FIT-03', { n: results.length }) } : { messageId: 'FIT-02', message: msg('FIT-02') };
  // AI summary (CFG-101): no AI service is connected yet, so the scores stand alone (FIT-05). It could never reorder.
  const summary = cfgBool('CFG-101') ? { text: null, messageId: 'FIT-05', message: msg('FIT-05') } : null;
  return { rankingId: log._id, weights: w, results, summary, ...message };
}

/** The sum insured options on offer for a type (question c), and the people who can be covered. */
export async function options(ctx: AuthContext, customerId: string, typeId: string) {
  const c = await Customer.findOne({ _id: customerId, accountId: ctx.accountId }, { name: 1, dob: 1 }).lean<{ _id: string; name: string; dob: string | null }>();
  if (!c) throw AppError.notFound();
  const fam = await FamilyMember.find({ customerId, accountId: ctx.accountId, status: 'ACTIVE' }, { name: 1, dob: 1, relationship: 1 }).lean<Array<{ _id: string; name: string; dob: string | null; relationship: string }>>();
  const prods = await Product.find({ typeId, $or: [{ kind: 'VERIFIED', status: 'ACTIVE' }, { kind: 'OWN', accountId: ctx.accountId }] }, { publishedVersionId: 1 }).lean<Array<{ publishedVersionId: string | null }>>();
  const versions = await ProductVersion.find({ _id: { $in: prods.map((p) => p.publishedVersionId).filter(Boolean) } }, { data: 1 }).lean<Array<{ data: ProductData }>>();
  const si = [...new Set(versions.flatMap((v) => v.data?.sumInsured?.options ?? []))].sort((a, b) => a - b);
  void cfgRange; void cfgNum;
  return {
    people: [{ key: `C:${c._id}`, name: c.name, relationship: 'Self', hasDob: !!c.dob }, ...fam.map((f) => ({ key: `F:${f._id}`, name: f.name, relationship: f.relationship, hasDob: !!f.dob }))],
    sumInsuredOptions: si, priorities: PRIORITIES,
  };
}

/** The advisor chose a product from the ranking (kept in the log). */
export async function choose(ctx: AuthContext, rankingId: string, productId: string, variantId?: string | null) {
  const u = await RankingLog.findOneAndUpdate({ _id: rankingId, accountId: ctx.accountId }, { $set: { chosenProductId: productId, chosenVariantId: variantId ?? null } }, { new: true }).lean();
  if (!u) throw AppError.notFound();
  return { rankingId, chosenProductId: productId, chosenVariantId: variantId ?? null };
}