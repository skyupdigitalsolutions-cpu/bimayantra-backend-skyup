import type { Request } from 'express';
import { cfgNum } from '../../config/cfg.js';
import { istDate, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { isDuplicateKey, withTx } from '../../lib/mongo.js';
import { audit } from '../audit/audit.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { PriceVersion, type PriceDoc } from './price.model.js';
import { Product, ProductVersion, type ProductDoc, type ProductVersionDoc } from './product.model.js';
import { TemplateVersion, type TemplateDoc } from './types.model.js';

export const SKYUP = 'SKYUP';
type Factor = TemplateDoc['factors'][number];
export interface RawRow { factors: Record<string, string>; basePremium: number | string }
export interface PriceBody { effectiveFrom: string; taxPercent: number; rows?: RawRow[]; csv?: string; riderPrices?: Array<{ name: string; value: number }>; sourceNote?: string | null }

const dayBefore = (iso: string) => { const d = new Date(`${iso}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
const bandLabel = (b: { from?: number | null; to?: number | null }) => `${b.from}-${b.to}`;
const labelsOf = (f: Factor) => (f.kind === 'BAND' ? f.bands.map(bandLabel) : [...f.values]);

/** Status from the dates (IST today): CANCELLED, CLOSED, SCHEDULED or CURRENT. */
export function statusOf(p: Pick<PriceDoc, 'cancelled' | 'effectiveFrom' | 'effectiveTo'>, today = istToday()) {
  if (p.cancelled) return 'CANCELLED';
  if (p.effectiveTo && p.effectiveTo < today) return 'CLOSED';
  if (p.effectiveFrom > today) return 'SCHEDULED';
  return 'CURRENT';
}
const view = (p: PriceDoc, withRows = false) => ({
  id: p._id, number: p.number, name: `v${p.number}`, effectiveFrom: p.effectiveFrom, effectiveTo: p.effectiveTo, status: statusOf(p),
  taxPercent: p.taxPercent, rowCount: p.rows.length, riderPrices: p.riderPrices, sourceNote: p.sourceNote, createdAt: p.createdAt,
  ...(withRows ? { rows: p.rows } : {}),
});

/**
 * The product and the rating factors its prices follow: the published version's template (or, for a verified product
 * not yet published, its latest version's). Prices need RATE_TABLE pricing (P-24 precondition).
 */
async function productAndFactors(productId: string) {
  const p = await Product.findById(productId).lean<ProductDoc>();
  if (!p) throw AppError.notFound();
  const v = p.publishedVersionId
    ? await ProductVersion.findById(p.publishedVersionId).lean<ProductVersionDoc>()
    : await ProductVersion.findOne({ productId }).sort({ number: -1 }).lean<ProductVersionDoc>();
  if (!v || (v.data as { pricingMode?: string })?.pricingMode !== 'RATE_TABLE') throw AppError.invalidState('product', 'priced by manual entry');
  const tpl = await TemplateVersion.findById(v.templateId, { factors: 1 }).lean<TemplateDoc>();
  return { product: p, templateId: v.templateId, factors: tpl?.factors ?? [], addOns: ((v.data as { addOns?: Array<{ name: string }> })?.addOns ?? []).map((a) => a.name) };
}

/** The CSV template: one column per rating factor key, then base_premium (P-24 step 2). */
export function csvTemplate(factors: Factor[]) {
  const header = [...factors.map((f) => f.key), 'base_premium'].join(',');
  const example = factors.map((f) => labelsOf(f)[0] ?? '').join(',');
  return `${header}\n${example ? `${example},` : ''}\n`;
}

/** A small CSV reader (quoted cells allowed). The header must be exactly the template's (CAT-31). */
function parseCsv(text: string, factors: Factor[]): RawRow[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim() !== '');
  const cells = (l: string) => [...l.matchAll(/(?:^|,)(?:"((?:[^"]|"")*)"|([^,]*))/g)].map((m) => (m[1] !== undefined ? m[1].replace(/""/g, '"') : m[2] ?? '').trim());
  const expected = [...factors.map((f) => f.key), 'base_premium'];
  if (!lines.length || cells(lines[0]!).join(',') !== expected.join(',')) throw new AppError(400, 'VALIDATION_FAILED', 'CAT-31');
  return lines.slice(1).map((l) => {
    const c = cells(l);
    return { factors: Object.fromEntries(factors.map((f, i) => [f.key, c[i] ?? ''])), basePremium: c[factors.length] ?? '' };
  });
}

/**
 * P-24 step 3: check every row. Accepted rows; rows with errors (CAT-19, a downloadable report); repeated factors
 * with different premiums (CAT-22); missing combinations (CAT-21, a warning only); more than CFG-39 rows (CAT-20).
 */
export function checkRows(factors: Factor[], raw: RawRow[]) {
  if (raw.length > cfgNum('CFG-39')) throw new AppError(400, 'VALIDATION_FAILED', 'CAT-20', { 'CFG-39': cfgNum('CFG-39') });
  const errors: Array<{ row: number; problems: string[] }> = [];
  const accepted: Array<{ factors: Record<string, string>; basePremium: number }> = [];
  const seen = new Map<string, { row: number; premium: number }>();
  const repeated = new Set<number>();
  raw.forEach((r, i) => {
    const row = i + 1;
    const problems: string[] = [];
    const clean: Record<string, string> = {};
    for (const f of factors) {
      const v = String(r.factors?.[f.key] ?? '').trim();
      if (!labelsOf(f).includes(v)) problems.push(`${f.name}: "${v}" is not one of ${labelsOf(f).join(', ')}`);
      clean[f.key] = v;
    }
    const prem = typeof r.basePremium === 'number' ? r.basePremium : Number(String(r.basePremium).replace(/[₹,\s]/g, ''));
    if (!Number.isFinite(prem) || prem <= 0 || Math.round(prem * 100) !== prem * 100) problems.push('base premium must be an amount above 0 with up to 2 decimals');
    if (problems.length) { errors.push({ row, problems }); return; }
    const key = factors.map((f) => clean[f.key]).join('|');
    const before = seen.get(key);
    if (before) {
      if (before.premium !== prem) { repeated.add(before.row); repeated.add(row); }
      return; // an identical repeat is simply ignored
    }
    seen.set(key, { row, premium: prem });
    accepted.push({ factors: clean, basePremium: prem });
  });
  // every combination of the factors' bands and values
  let combos: string[][] = [[]];
  for (const f of factors) combos = combos.flatMap((c) => labelsOf(f).map((l) => [...c, l]));
  const missing = factors.length ? combos.filter((c) => !seen.has(c.join('|'))).map((c) => c.join(' / ')) : [];
  return { accepted, errors, repeatedRows: [...repeated].sort((a, b) => a - b), missing };
}

function rowsFrom(b: PriceBody, factors: Factor[]) {
  if (b.csv !== undefined && b.csv !== null) return parseCsv(b.csv, factors);
  return b.rows ?? [];
}
const missingText = (m: string[]) => (m.length > 20 ? `${m.slice(0, 20).join('; ')} and ${m.length - 20} more` : m.join('; '));

/** P-24 step 3 as a dry run: nothing is saved. */
export async function check(productId: string, b: Pick<PriceBody, 'rows' | 'csv'>) {
  const { factors } = await productAndFactors(productId);
  const r = checkRows(factors, rowsFrom(b as PriceBody, factors));
  return {
    accepted: r.accepted.length, errors: r.errors, repeatedRows: r.repeatedRows, missing: r.missing,
    messages: [
      ...(r.errors.length ? [{ messageId: 'CAT-19', message: msg('CAT-19', { n: r.errors.length }) }] : []),
      ...(r.repeatedRows.length ? [{ messageId: 'CAT-22', message: msg('CAT-22', { list: r.repeatedRows.join(', ') }) }] : []),
      ...(r.missing.length ? [{ messageId: 'CAT-21', message: msg('CAT-21', { list: missingText(r.missing) }) }] : []),
    ],
  };
}

export async function list(owner: string, productId: string) {
  return (await PriceVersion.find({ owner, productId }).sort({ number: -1 }).lean<PriceDoc[]>()).map((p) => view(p));
}
export async function getOne(owner: string, id: string) {
  const p = await PriceVersion.findOne({ _id: id, owner }).lean<PriceDoc>();
  if (!p) throw AppError.notFound(); // another account's price is never returned (AC-P24-5)
  return view(p, true);
}

/**
 * Save a new version (P-24 step 4). In one transaction the open version is closed the day before the new start
 * (AC-P24-1) and the new one inserted. Two saves at the same moment: the database allows one open version, so
 * the second fails cleanly with GEN-05 (AC-P24-3). Rows with errors or conflicting repeats save nothing.
 */
export async function create(ctx: AuthContext, owner: string, productId: string, b: PriceBody, req: Request) {
  const today = istToday();
  if (b.effectiveFrom < today) throw AppError.field('effectiveFrom', 'CAT-18');
  const { templateId, factors, addOns } = await productAndFactors(productId);
  const open = await PriceVersion.findOne({ owner, productId, open: true }).lean<PriceDoc>();
  if (open && b.effectiveFrom <= open.effectiveFrom) {
    if (open.effectiveFrom > today) throw AppError.field('effectiveFrom', 'CAT-17', { version: `v${open.number}`, dates: `${istDate(open.effectiveFrom)} onwards` });
    throw AppError.field('effectiveFrom', 'CAT-38', { date: istDate(open.effectiveFrom) }); // AC-P24-2
  }
  const r = checkRows(factors, rowsFrom(b, factors));
  if (r.errors.length) throw new AppError(400, 'VALIDATION_FAILED', 'CAT-19', { n: r.errors.length }, { errors: r.errors });
  if (r.repeatedRows.length) throw new AppError(400, 'VALIDATION_FAILED', 'CAT-22', { list: r.repeatedRows.join(', ') }, { rows: r.repeatedRows });
  if (!r.accepted.length) throw AppError.field('rows', 'GEN-01', { 'Field label': 'Rate table' });
  const riders = (b.riderPrices ?? []).filter((x) => addOns.includes(x.name));
  let saved: PriceDoc;
  try {
    saved = await withTx(async (session) => {
      if (open) {
        const closed = await PriceVersion.findOneAndUpdate({ _id: open._id, open: true }, { $set: { effectiveTo: dayBefore(b.effectiveFrom), open: null } }, { session: session ?? undefined });
        if (!closed) throw AppError.versionConflict('price version', null); // someone saved a price meanwhile
      }
      const last = await PriceVersion.findOne({ owner, productId }, { number: 1 }).sort({ number: -1 }).session(session).lean<{ number: number }>();
      const [p] = await PriceVersion.create([{
        owner, productId, number: (last?.number ?? 0) + 1, templateId, effectiveFrom: b.effectiveFrom, taxPercent: b.taxPercent,
        rows: r.accepted, riderPrices: riders, sourceNote: b.sourceNote ?? null, createdBy: ctx.userId,
      }], { session: session ?? undefined });
      await audit({ entity: 'priceVersion', entityId: p!._id, action: 'PRICE_VERSION_SAVED', after: { productId, number: p!.number, from: b.effectiveFrom, rows: r.accepted.length, owner: owner === SKYUP ? SKYUP : 'ACCOUNT' } }, { req, session });
      return p!.toObject() as PriceDoc;
    });
  } catch (e) {
    if (isDuplicateKey(e)) throw AppError.versionConflict('price version', null); // AC-P24-3
    throw e;
  }
  const warnings = r.missing.length ? [{ messageId: 'CAT-21', message: msg('CAT-21', { list: missingText(r.missing) }) }] : [];
  return {
    price: view(saved), warnings,
    messageId: (open ? 'CAT-37' : 'GEN-08') as 'CAT-37' | 'GEN-08',
    params: (open ? { 'start date': istDate(b.effectiveFrom), 'end date': istDate(dayBefore(b.effectiveFrom)) } : { 'Record type': 'Price version' }) as Record<string, string>,
  };
}

/** Cancel a SCHEDULED version before it starts (P-24 step 5); the version it closed is open again. */
export async function cancel(ctx: AuthContext, owner: string, id: string, req: Request) {
  const p = await PriceVersion.findOne({ _id: id, owner }).lean<PriceDoc>();
  if (!p) throw AppError.notFound();
  if (statusOf(p) !== 'SCHEDULED') throw AppError.invalidState('price version', statusOf(p));
  await withTx(async (session) => {
    const u = await PriceVersion.findOneAndUpdate({ _id: id, cancelled: false, effectiveFrom: { $gt: istToday() } }, { $set: { cancelled: true, open: null } }, { session: session ?? undefined });
    if (!u) throw AppError.invalidState('price version', 'already started or cancelled');
    if (p.open) {
      await PriceVersion.updateOne({ owner, productId: p.productId, effectiveTo: dayBefore(p.effectiveFrom), cancelled: false }, { $set: { effectiveTo: null, open: true } }, { session: session ?? undefined });
    }
    await audit({ entity: 'priceVersion', entityId: id, action: 'PRICE_VERSION_CANCELLED' }, { req, session });
  });
  return { price: view((await PriceVersion.findById(id).lean<PriceDoc>())!), params: { name: `v${p.number}` } };
}

/** The version covering a day (IST) — what a quotation uses and stores (GR-23). */
export async function priceOn(owner: string, productId: string, day = istToday()) {
  return PriceVersion.findOne({ owner, productId, cancelled: false, effectiveFrom: { $lte: day }, $or: [{ effectiveTo: null }, { effectiveTo: { $gte: day } }] }).sort({ effectiveFrom: -1 }).lean<PriceDoc>();
}

/** SkyUp's reference price an advisor can copy: the one covering today, else the next scheduled. */
export async function reference(productId: string) {
  const p = (await priceOn(SKYUP, productId)) ?? (await PriceVersion.findOne({ owner: SKYUP, productId, cancelled: false }).sort({ effectiveFrom: 1 }).lean<PriceDoc>());
  return p ? view(p, true) : null;
}

/** For P-22: a verified RATE_TABLE product needs a SkyUp reference price version before it can be submitted. */
export async function hasReference(productId: string) {
  return !!(await PriceVersion.exists({ owner: SKYUP, productId, cancelled: false }));
}

export { csvTemplate as template, productAndFactors };