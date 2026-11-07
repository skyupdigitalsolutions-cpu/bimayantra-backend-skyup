import type { Request } from 'express';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { cfgBool, cfgNum } from '../../config/cfg.js';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { logger } from '../../lib/logger.js';
import { audit } from '../audit/audit.service.js';
import { ocrPages, readerEnabled } from '../documents/reader.js';
import { assertOwnFile, open as openFile } from '../files/files.service.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { ProductVersion, type ProductVersionDoc } from './product.model.js';
import { TemplateVersion, type TemplateDoc } from './types.model.js';

/**
 * P-23 brochure reading. A job reads the brochure and SUGGESTS a value per template feature; nothing reaches the draft
 * without a reviewer's decision (AC-P23-1). OCR reads features only, never premiums. The raw text and every decision
 * are kept. QUEUED → PROCESSING → REVIEW_REQUIRED → REVIEWED, or FAILED (the draft unchanged, AC-P23-3).
 */
const row = new Schema({
  key: String, name: String, dataType: String,
  found: { type: Boolean, default: false }, value: { type: String, default: null }, confidence: { type: Number, default: 0 }, page: { type: Number, default: null },
  decision: { type: String, enum: ['ACCEPT', 'EDIT', 'IGNORE', 'NOT_STATED', null], default: null }, editedValue: { type: String, default: null },
}, { _id: false });
/** Change #6: product details read (name, UIN, sum insured, entry ages, terms), variant names, and AI-suggested features. */
const detailRow = new Schema({
  key: String, label: String, value: { type: String, default: null }, confidence: { type: Number, default: 0 }, page: { type: Number, default: null },
  decision: { type: String, enum: ['ACCEPT', 'EDIT', 'IGNORE', 'NOT_STATED', null], default: null }, editedValue: { type: String, default: null },
}, { _id: false });
const jobSchema = new Schema(
  {
    _id: { type: String, default: () => newId('ocr') },
    /** SKYUP: reads into a verified product's DRAFT (P-23). ADVISOR: Add my product, before the product exists (change #6). */
    kind: { type: String, enum: ['SKYUP', 'ADVISOR'], default: 'SKYUP' },
    accountId: { type: String, default: null }, // ADVISOR only
    typeId: { type: String, default: null }, // ADVISOR only: the category chosen in step 1
    templateId: { type: String, default: null },
    versionId: { type: String, default: null }, // SKYUP only
    productId: { type: String, default: null }, // SKYUP only
    fileId: { type: String, required: true },
    status: { type: String, enum: ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED', 'REVIEWED', 'FAILED'], default: 'QUEUED' },
    startedBy: { type: String, required: true },
    startedAt: { type: Date, required: true },
    rows: { type: [row], default: [] },
    details: { type: [detailRow], default: [] },
    variants: { type: [detailRow], default: [] }, // key = label = the variant name read
    suggestions: { type: [detailRow], default: [] }, // key = cf_…, label = feature name; ACCEPT = ticked to add
    rawText: { type: String, default: null, select: false }, // kept for audit
    error: { type: String, default: null },
    reviewedBy: { type: String, default: null },
    applied: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
);
type JobDoc = InferSchemaType<typeof jobSchema> & { _id: string };
export const OcrJob = model('OcrJob', jobSchema, 'ocr_jobs');

type Feature = TemplateDoc['features'][number];
type Page = { number: number; text: string; confidence: number };

/** Turn found text into the feature's value (as text for review). */
export function extract(dataType: string, rest: string, featureName = ''): string | null {
  const s = rest.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (dataType === 'Yes/No') {
    if (/\b(not covered|excluded|not available|not included|no)\b/i.test(s)) return 'No';
    if (/\b(covered|included|available|yes)\b/i.test(s)) return 'Yes';
    return null;
  }
  if (dataType === 'Amount in ₹') { const m = /(?:₹|rs\.?|inr)?\s*([\d,]+(?:\.\d+)?)/i.exec(s); return m ? m[1]!.replace(/,/g, '') : null; }
  if (dataType === 'Percentage') { const m = /(\d+(?:\.\d+)?)\s*%/.exec(s); return m ? m[1]! : null; }
  if (['Months', 'Days', 'Years'].includes(dataType)) {
    const m = /(\d+(?:\.\d+)?)\s*(months?|days?|years?|yrs?)/i.exec(s);
    if (!m) return null;
    const n = Number(m[1]); const unit = m[2]!.toLowerCase();
    const months = unit.startsWith('y') ? n * 12 : unit.startsWith('d') ? n / 30 : n;
    const out = dataType === 'Months' ? months : dataType === 'Years' ? months / 12 : months * 30;
    return String(Math.round(out * 100) / 100);
  }
  if (dataType === 'Number') { const m = /(\d+(?:\.\d+)?)/.exec(s); return m ? m[1]! : null; }
  void featureName;
  return s.slice(0, 200);
}

/** Find each feature on the pages: the line naming it (or all its main words), value from the rest of that line or the next. */
export function matchFeatures(features: Feature[], pages: Page[]) {
  return features.map((f) => {
    const words = f.name.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    let best: { value: string; confidence: number; page: number } | null = null;
    for (const pg of pages) {
      const lines = pg.text.split(/\r?\n/);
      lines.forEach((line, i) => {
        if (best) return;
        const low = line.toLowerCase();
        const exact = low.includes(f.name.toLowerCase());
        if (!exact && !(words.length && words.every((w) => low.includes(w)))) return;
        const after = exact ? line.slice(low.indexOf(f.name.toLowerCase()) + f.name.length) : line;
        const value = extract(f.dataType, after.replace(/^[\s:–-]+/, ''), f.name) ?? extract(f.dataType, lines[i + 1] ?? '', f.name);
        if (value !== null) best = { value, confidence: Math.round(pg.confidence * (exact ? 1 : 0.8) * 100) / 100, page: pg.number };
      });
      if (best) break;
    }
    const b = best as { value: string; confidence: number; page: number } | null;
    return { key: f.key, name: f.name, dataType: f.dataType, found: !!b, value: b?.value ?? null, confidence: b?.confidence ?? 0, page: b?.page ?? null, decision: null, editedValue: null };
  });
}

const threshold = () => cfgNum('CFG-37') / 100;
const flagged = (r: { found: boolean; confidence: number }) => !r.found || r.confidence < threshold();
const flaggedDetail = (r: { value?: string | null; confidence?: number | null }) => !r.value || (r.confidence ?? 0) < threshold();
const view = (j: JobDoc) => ({
  id: j._id, kind: j.kind ?? 'SKYUP', versionId: j.versionId, typeId: j.typeId ?? null, fileId: j.fileId, status: j.status, startedAt: j.startedAt, error: j.error, applied: j.applied, threshold: cfgNum('CFG-37'),
  rows: j.rows.map((r) => ({ ...r, flagged: flagged(r), ...(r.found ? {} : { messageId: 'OCR-08' }) })),
  details: (j.details ?? []).map((r) => ({ ...r, flagged: flaggedDetail(r) })),
  variants: (j.variants ?? []).map((r) => ({ ...r, flagged: flaggedDetail(r) })),
  // AI-suggested features start unticked; Fix is offered for low and medium confidence
  suggestions: (j.suggestions ?? []).map((r) => ({ ...r, ticked: r.decision === 'ACCEPT' || r.decision === 'EDIT', flagged: flaggedDetail(r) })),
});

/** Pages in a PDF (P-23: more than CFG-30 is refused with OCR-04). Images are one page. */
export function pageCount(bytes: Buffer, mime: string) {
  if (mime !== 'application/pdf') return 1;
  return (bytes.toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length || 1;
}

async function draftOf(vid: string) {
  const v = await ProductVersion.findById(vid).lean<ProductVersionDoc>();
  if (!v) throw AppError.notFound();
  if (v.status !== 'DRAFT') throw AppError.invalidState('product version', v.status.replace('_', ' '));
  return v;
}

/** Brochure → Read with OCR (OCR-01). Running it again on the same file reuses the open job. */
export async function start(ctx: AuthContext, vid: string, fileId: string, req: Request) {
  if (!cfgBool('CFG-102') || !readerEnabled()) throw new AppError(409, 'INVALID_STATE', 'OCR-07');
  const v = await draftOf(vid);
  await assertOwnFile(ctx, fileId, 'BROCHURE', 'fileId');
  const open = await OcrJob.findOne({ versionId: vid, fileId, status: { $in: ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED'] } }).lean<JobDoc>();
  if (open) return view(open);
  const { file, bytes } = await openFile(ctx, fileId, req);
  if (pageCount(bytes, file.mime) > cfgNum('CFG-30')) throw AppError.field('fileId', 'OCR-04', { 'CFG-30': cfgNum('CFG-30') }); // AC-P23-4
  const job = await OcrJob.create({ versionId: vid, productId: v.productId, fileId, startedBy: ctx.userId, startedAt: clock.now() });
  await audit({ entity: 'ocrJob', entityId: job._id, action: 'OCR_STARTED', after: { versionId: vid, fileId } }, { req });
  run(job._id, v.templateId, bytes, file.mime, ctx);
  return view(job.toObject() as JobDoc);
}

/** Try again after FAILED: a new job on the same file. */
export async function retry(ctx: AuthContext, jobId: string, req: Request) {
  const j = await OcrJob.findById(jobId).lean<JobDoc>();
  if (!j) throw AppError.notFound();
  if (j.status !== 'FAILED') throw AppError.invalidState('OCR job', j.status);
  if (j.kind === 'ADVISOR') { if (j.accountId !== ctx.accountId) throw AppError.notFound(); return advisorStart(ctx, j.typeId!, j.fileId, req); }
  if (ctx.accountId) throw AppError.notFound();
  return start(ctx, j.versionId!, j.fileId, req);
}

/** The background job (GR-26): never awaited by the request; CFG-38 limit; failure leaves the draft unchanged. */
function run(jobId: string, templateId: string, bytes: Buffer, mime: string, ctx: AuthContext) {
  void (async () => {
    const tell = (messageId: 'OCR-02' | 'OCR-03', params = {}) => notify({ userId: ctx.userId, accountId: null, kind: messageId === 'OCR-02' ? 'OCR_DONE' : 'OCR_FAILED', messageId, params, dedupeKey: `${messageId}|${jobId}` }).catch(() => undefined);
    try {
      await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'PROCESSING' } });
      const limit = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('OCR time limit (CFG-38) reached')), cfgNum('CFG-38') * 60_000).unref());
      const read = await Promise.race([ocrPages(bytes, mime), limit]);
      const tpl = await TemplateVersion.findById(templateId, { features: 1 }).lean<TemplateDoc>();
      const rows = matchFeatures(tpl?.features ?? [], read.pages);
      const extra = { details: readDetails(read.pages), variants: readVariantNames(read.pages), suggestions: suggestFeatures(read.pages, tpl?.features ?? []) };
      // The bell item first, then the status: whoever sees REVIEW_REQUIRED can already find OCR-02 in the bell.
      await OcrJob.updateOne({ _id: jobId }, { $set: { rows, ...extra, rawText: read.text } });
      await tell('OCR-02', { n: rows.filter((r) => r.found).length, m: rows.filter(flagged).length });
      await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'REVIEW_REQUIRED' } });
    } catch (e) {
      logger.warn({ jobId, reason: (e as Error).message }, 'Brochure OCR failed (OCR-03)');
      await tell('OCR-03'); // the bell item first, then FAILED (same reason as above)
      await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'FAILED', error: (e as Error).message } }).catch(() => undefined);
    }
  })();
}

export async function latest(vid: string) {
  const j = await OcrJob.findOne({ versionId: vid }).sort({ createdAt: -1 }).lean<JobDoc>();
  return j ? view(j) : null;
}

/** Decisions per row: Accept, Edit (with the typed value), Ignore, Not stated. */
export type Decision = { section?: 'FEATURE' | 'DETAIL' | 'VARIANT' | 'SUGGESTION'; key: string; decision: 'ACCEPT' | 'EDIT' | 'IGNORE' | 'NOT_STATED'; value?: string | null };
export async function decide(ctx: AuthContext, jobId: string, decisions: Decision[]) {
  const j = await loadJob(ctx, jobId);
  if (j.status !== 'REVIEW_REQUIRED') throw AppError.invalidState('OCR job', j.status);
  const rows = j.rows.map((r) => {
    const d = decisions.find((x) => (x.section ?? 'FEATURE') === 'FEATURE' && x.key === r.key);
    if (!d) return r;
    if (d.decision === 'ACCEPT' && !r.found) throw AppError.field(`rows.${r.key}`, 'OCR-08');
    if (d.decision === 'EDIT' && !(d.value ?? '').trim()) throw AppError.field(`rows.${r.key}`, 'GEN-01', { 'Field label': String(r.name ?? r.key ?? '') });
    return { ...r, decision: d.decision, editedValue: d.decision === 'EDIT' ? d.value!.trim() : null };
  });
  // Change #6: the same decisions on product details, variant names and suggested features
  const other = (section: 'DETAIL' | 'VARIANT' | 'SUGGESTION', list: JobDoc['details']) => list.map((r) => {
    const d = decisions.find((x) => x.section === section && x.key === r.key);
    if (!d) return r;
    if (d.decision === 'ACCEPT' && !r.value) throw AppError.field(`${section.toLowerCase()}.${r.key}`, 'OCR-08');
    if (d.decision === 'EDIT' && !(d.value ?? '').trim()) throw AppError.field(`${section.toLowerCase()}.${r.key}`, 'GEN-01', { 'Field label': String(r.label ?? r.key ?? '') });
    return { ...r, decision: d.decision, editedValue: d.decision === 'EDIT' ? d.value!.trim() : null };
  });
  const details = other('DETAIL', j.details ?? []); const variants = other('VARIANT', j.variants ?? []); const suggestions = other('SUGGESTION', j.suggestions ?? []);
  await OcrJob.updateOne({ _id: jobId, status: 'REVIEW_REQUIRED' }, { $set: { rows, details, variants, suggestions } });
  return view({ ...j, rows, details, variants, suggestions } as JobDoc);
}

/** "Accept all above CFG-37": only found, high-confidence rows without a decision (AC-P23-2). */
export async function acceptHigh(ctx: AuthContext, jobId: string) {
  const j = await loadJob(ctx, jobId);
  if (j.status !== 'REVIEW_REQUIRED') throw AppError.invalidState('OCR job', j.status);
  const rows = j.rows.map((r) => (!r.decision && !flagged(r) ? { ...r, decision: 'ACCEPT' as const } : r));
  // Suggested features are never ticked for the advisor (each starts unticked); details and variant names are accepted
  const hi = (list: JobDoc['details']) => list.map((r) => (!r.decision && !flaggedDetail(r) ? { ...r, decision: 'ACCEPT' as const } : r));
  const details = hi(j.details ?? []); const variants = hi(j.variants ?? []);
  await OcrJob.updateOne({ _id: jobId }, { $set: { rows, details, variants } });
  return view({ ...j, rows, details, variants } as JobDoc);
}

function typedValue(dataType: string, text: string): unknown {
  if (dataType === 'Yes/No') return /^(yes|y|true|covered)$/i.test(text.trim());
  if (dataType === 'Text') return text.trim();
  const n = Number(text.replace(/[₹,%\s]/g, ''));
  return Number.isFinite(n) ? n : text.trim();
}

/**
 * Apply to draft (OCR-06): accepted and edited values, and Not stated, go into the DRAFT's features, each marked as
 * read by OCR and checked by the reviewer. Every highlighted row needs a decision first (OCR-05).
 */
export async function apply(ctx: AuthContext, jobId: string, req: Request) {
  const j = await loadJob(ctx, jobId);
  if (j.kind === 'ADVISOR') throw AppError.notFound(); // advisors take the result into + My product instead
  if (j.status !== 'REVIEW_REQUIRED') throw AppError.invalidState('OCR job', j.status);
  // Only template features need a decision (P-23); details, variant names and suggestions not decided are just not used
  if (j.rows.some((r) => flagged(r) && !r.decision)) throw new AppError(400, 'VALIDATION_FAILED', 'OCR-05');
  const v = await draftOf(j.versionId!);
  const set: Record<string, unknown> = {};
  let n = 0;
  for (const r of j.rows) {
    if (!r.decision || r.decision === 'IGNORE') continue;
    const value = r.decision === 'NOT_STATED' ? { notStated: true } : { value: typedValue(r.dataType ?? 'Text', (r.decision === 'EDIT' ? r.editedValue : r.value) ?? ''), page: r.page ?? null };
    set[`data.features.${r.key}`] = value;
    set[`ocrMarks.${r.key}`] = { jobId, checkedBy: ctx.name };
    n++;
  }
  // Change #6: accepted product details and ticked suggested features go into the draft too
  const out = decidedResult(j);
  for (const [k, val] of Object.entries(out.data)) { if (k !== 'features') { set[`data.${k}`] = val; n++; } }
  if (out.customFeatures.length) {
    const existing = ((v.data as { customFeatures?: Array<{ key: string }> }).customFeatures ?? []);
    set['data.customFeatures'] = [...existing, ...out.customFeatures.filter((c) => !existing.some((e) => e.key === c.key))];
    for (const c of out.customFeatures) { set[`data.features.${c.key}`] = out.data.features[c.key]; n++; }
  }
  const u = await ProductVersion.updateOne({ _id: v._id, status: 'DRAFT', rev: v.rev }, { $set: set, $inc: { rev: 1 } });
  if (!u.modifiedCount && n) throw AppError.versionConflict('product version', null);
  await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'REVIEWED', reviewedBy: ctx.userId, applied: n } });
  await audit({ entity: 'ocrJob', entityId: jobId, action: 'OCR_APPLIED', after: { versionId: v._id, applied: n, decisions: j.rows.map((r) => ({ key: r.key, decision: r.decision })) } }, { req });
  return { job: view((await OcrJob.findById(jobId).lean<JobDoc>())!), params: { n } };
}
// ════════ Change #6: product details, variant names, suggested features; the advisor flow (Q6 default) ════════
import { Account } from '../accounts/account.model.js';
import { allowsBrochureReading, effectiveStatus as subStatus } from '../accounts/subscription.js';
import { assertVisibleType } from './private.service.js';

type Row = { key: string; label: string; value: string | null; confidence: number; page: number | null; decision: null; editedValue: null };
const mk = (key: string, label: string, value: string | null, confidence: number, page: number | null): Row => ({ key, label, value, confidence: Math.round(confidence * 100) / 100, page, decision: null, editedValue: null });

/** Rupees in Indian wording: "5 lakh" = 500000, "1 crore" = 10000000, "₹3,00,000" = 300000. */
export function rupeesIn(text: string): number[] {
  const out: number[] = [];
  const re = /(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d+)?)\s*(lakhs?|lacs?|l\b|crores?|cr\b)?/gi;
  for (const m of text.matchAll(re)) {
    const n = Number(m[1]!.replace(/,/g, ''));
    if (!Number.isFinite(n)) continue;
    const unit = (m[2] ?? '').toLowerCase();
    const v = unit.startsWith('c') ? n * 10_000_000 : unit.startsWith('l') ? n * 100_000 : n;
    if (v >= 10_000) out.push(Math.round(v));
  }
  return [...new Set(out)];
}

/** Product details on the brochure. Each value is a suggestion with the page and a confidence; nothing is trusted. */
export function readDetails(pages: Page[]): Row[] {
  const rows: Row[] = [];
  const first = <T>(fn: (line: string, pg: Page) => T | null) => { for (const pg of pages) for (const line of pg.text.split(/\r?\n/)) { const v = fn(line, pg); if (v !== null) return { v, pg }; } return null; };
  const uin = first((l) => /\b([A-Z]{3,8}[A-Z0-9]{3,}V\d{6})\b/.exec(l.toUpperCase())?.[1] ?? null);
  if (uin) rows.push(mk('uin', 'IRDAI product UIN', uin.v, uin.pg.confidence, uin.pg.number));
  const name = first((l) => { const t = l.trim(); return t.length >= 4 && t.length <= 60 && /\b(plan|policy|insurance|shield|care|health|cover)\b/i.test(t) && !/[:₹%]|\d{3,}/.test(t) ? t.replace(/\s+/g, ' ') : null; });
  if (name) rows.push(mk('name', 'Product name', name.v, name.pg.confidence * 0.6, name.pg.number)); // a guess from a heading: always checked
  const si = first((l) => (/sum (?:insured|assured)/i.test(l) && rupeesIn(l).length ? rupeesIn(l) : null));
  if (si) rows.push(mk('sumInsuredOptions', 'Sum insured options', si.v.sort((a, b) => a - b).join(', '), si.pg.confidence * 0.9, si.pg.number));
  const ages = first((l) => { const m = /entry age[^\d]*(\d{1,2})\s*(?:days?|months?|years?|yrs?)?\s*(?:to|-|–|and)\s*(\d{2,3})/i.exec(l); return m ? [m[1]!, m[2]!] : null; });
  if (ages) { rows.push(mk('adultMin', 'Adult minimum entry age', ages.v[0]!, ages.pg.confidence * 0.9, ages.pg.number)); rows.push(mk('adultMax', 'Adult maximum entry age', ages.v[1]!, ages.pg.confidence * 0.9, ages.pg.number)); }
  const terms = first((l) => { const m = /policy (?:term|tenure|period)[^\d]*((?:\d{1,2}\s*(?:,|or|and|\/|-|–)?\s*)+)\s*years?/i.exec(l); return m ? [...new Set(m[1]!.match(/\d{1,2}/g)!.map(Number))].filter((n) => n >= 1 && n <= 30) : null; });
  if (terms?.v.length) rows.push(mk('policyTerms', 'Policy terms (years)', terms.v.join(', '), terms.pg.confidence * 0.85, terms.pg.number));
  return rows;
}

const TIERS = ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Titanium', 'Basic', 'Essential', 'Classic', 'Plus', 'Premier', 'Elite', 'Supreme', 'Advantage', 'Value', 'Optima', 'Signature'];
/** Variant names: plan tiers ("Silver", "Gold") or lettered plans ("Plan A") in lines about plans or variants. */
export function readVariantNames(pages: Page[]): Row[] {
  const found: Row[] = [];
  for (const pg of pages) for (const line of pg.text.split(/\r?\n/)) {
    const ctx = /\b(plans?|variants?|options?|tiers?)\b/i.test(line);
    for (const t of TIERS) if (new RegExp(`\\b${t}\\b`, 'i').test(line) && !found.some((f) => f.key === t.toLowerCase())) found.push(mk(t.toLowerCase(), t, t, pg.confidence * (ctx ? 0.9 : 0.6), pg.number));
    for (const m of line.matchAll(/\b(?:plan|variant|option)\s+([A-E1-5])\b/gi)) {
      const label = `Plan ${m[1]!.toUpperCase()}`;
      if (!found.some((f) => f.key === label.toLowerCase())) found.push(mk(label.toLowerCase(), label, label, pg.confidence * 0.85, pg.number));
    }
  }
  return found.slice(0, 10);
}

/** "Name: value" lines that are not template features: offered as features to add (each starts unticked). */
export function suggestFeatures(pages: Page[], features: Feature[]): Row[] {
  const known = features.map((f) => f.name.toLowerCase());
  const covered = (label: string) => known.some((k) => k === label || label.includes(k) || k.includes(label) || k.split(/\s+/).filter((w) => w.length > 3).every((w) => label.includes(w)));
  const out: Row[] = [];
  for (const pg of pages) for (const line of pg.text.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z][A-Za-z ()/&'’-]{3,60}?)\s*[:–-]\s*(.{1,120})$/.exec(line);
    if (!m) continue;
    const label = m[1]!.replace(/\s+/g, ' ').trim();
    const low = label.toLowerCase();
    if (covered(low) || /sum (?:insured|assured)|entry age|policy (?:term|tenure)|uin|premium/i.test(low)) continue;
    const yes = extract('Yes/No', m[2]!);
    const value = yes ?? extract('Text', m[2]!);
    const key = `cf_${low.replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50)}`;
    if (!value || out.some((o) => o.key === key)) continue;
    out.push(mk(key, label.replace(/\b\w/g, (c) => c.toUpperCase()), value, pg.confidence * (yes ? 0.8 : 0.6), pg.number));
  }
  return out.slice(0, 20);
}

/** Only values with a decision (Accept, Edit, Not stated) become product values (AC-P23-1). */
export function decidedResult(j: Pick<JobDoc, 'rows' | 'details' | 'variants' | 'suggestions'>) {
  const val = (r: { decision?: string | null; value?: string | null; editedValue?: string | null }) => (r.decision === 'EDIT' ? r.editedValue : r.value) ?? '';
  const taken = (r: { decision?: string | null }) => r.decision === 'ACCEPT' || r.decision === 'EDIT';
  const nums = (s: string) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
  const data: Record<string, unknown> & { features: Record<string, unknown> } = { features: {} };
  for (const r of j.details ?? []) {
    if (!taken(r)) continue;
    const v = val(r);
    if (r.key === 'name') data.name = v;
    else if (r.key === 'uin') data.uin = v.toUpperCase().replace(/\s+/g, '');
    else if (r.key === 'adultMin' || r.key === 'adultMax') { const n = nums(v)[0]; if (n !== undefined) data[r.key] = n; }
    else if (r.key === 'policyTerms') data.policyTerms = nums(v).filter((n) => Number.isInteger(n));
    else if (r.key === 'sumInsuredOptions') data.sumInsured = { options: rupeesIn(v).length ? rupeesIn(v) : nums(v.replace(/,/g, '')) };
  }
  for (const r of j.rows) {
    if (!r.decision || r.decision === 'IGNORE') continue;
    data.features[r.key!] = r.decision === 'NOT_STATED' ? { notStated: true } : { value: typedValue(r.dataType ?? 'Text', val(r)), page: r.page ?? null };
  }
  const customFeatures: Array<{ key: string; name: string; origin: 'AI_SUGGESTED'; dataType: string }> = [];
  for (const r of j.suggestions ?? []) {
    if (!taken(r)) continue;
    const v = val(r); const yn = /^(yes|no)$/i.test(v);
    customFeatures.push({ key: r.key!, name: r.label ?? r.key!, origin: 'AI_SUGGESTED', dataType: yn ? 'Yes/No' : 'Text' });
    data.features[r.key!] = { value: typedValue(yn ? 'Yes/No' : 'Text', v), page: r.page ?? null };
  }
  const variants = (j.variants ?? []).filter(taken).map((r) => ({ name: val(r) }));
  return { data, customFeatures, variants };
}

/** A job is SkyUp's (STF/ADM, verified drafts) or one advisor account's; nobody else can open it. */
async function loadJob(ctx: AuthContext, jobId: string) {
  const j = await OcrJob.findById(jobId).lean<JobDoc>();
  if (!j) throw AppError.notFound();
  const advisorJob = j.kind === 'ADVISOR';
  if (advisorJob ? j.accountId !== ctx.accountId : !!ctx.accountId) throw AppError.notFound();
  return j;
}

/** Add my product step 3: read the brochure for the chosen category (Premium, or the trial; Normal → CAT-45). */
export async function advisorStart(ctx: AuthContext, typeId: string, fileId: string, req: Request) {
  const acc = await Account.findById(ctx.accountId, { subscription: 1 }).lean<{ subscription: Parameters<typeof subStatus>[0] & { plan: string | null } }>();
  if (!acc || !allowsBrochureReading(subStatus(acc.subscription, clock.now()), acc.subscription.plan)) throw new AppError(403, 'PLAN_REQUIRED', 'CAT-45');
  if (!cfgBool('CFG-102') || !readerEnabled()) throw new AppError(409, 'INVALID_STATE', 'OCR-07');
  await assertVisibleType(ctx.accountId, typeId);
  const tpl = await TemplateVersion.findOne({ typeId, status: 'ACTIVE' }, { _id: 1 }).lean<{ _id: string }>();
  if (!tpl) throw AppError.field('typeId', 'VAL-22');
  await assertOwnFile(ctx, fileId, 'BROCHURE', 'fileId');
  const open = await OcrJob.findOne({ kind: 'ADVISOR', accountId: ctx.accountId, typeId, fileId, status: { $in: ['QUEUED', 'PROCESSING', 'REVIEW_REQUIRED'] } }).lean<JobDoc>();
  if (open) return view(open);
  const { file, bytes } = await openFile(ctx, fileId, req);
  if (pageCount(bytes, file.mime) > cfgNum('CFG-30')) throw AppError.field('fileId', 'OCR-04', { 'CFG-30': cfgNum('CFG-30') });
  const job = await OcrJob.create({ kind: 'ADVISOR', accountId: ctx.accountId, typeId, templateId: tpl._id, fileId, startedBy: ctx.userId, startedAt: clock.now() });
  await audit({ entity: 'ocrJob', entityId: job._id, action: 'OCR_STARTED', after: { typeId, fileId, by: 'ADVISOR' } }, { req });
  run(job._id, tpl._id, bytes, file.mime, ctx);
  return view(job.toObject() as JobDoc);
}
export async function advisorJob(ctx: AuthContext, jobId: string) { return view(await loadJob(ctx, jobId)); }
export const decideAny = decide;
export const acceptHighAny = acceptHigh;

/**
 * "Use these values": the decided values as a + My product payload (data, variants, own features). Nothing is saved:
 * the advisor reviews the form and publishes it, sending ocrJobId so the version records what was read and checked.
 */
export async function advisorResult(ctx: AuthContext, jobId: string) {
  const j = await loadJob(ctx, jobId);
  if (j.kind !== 'ADVISOR') throw AppError.notFound();
  if (!['REVIEW_REQUIRED', 'REVIEWED'].includes(j.status)) throw AppError.invalidState('OCR job', j.status);
  if (j.rows.some((r) => flagged(r) && !r.decision)) throw new AppError(400, 'VALIDATION_FAILED', 'OCR-05');
  const out = decidedResult(j);
  return { ocrJobId: j._id, typeId: j.typeId, data: { ...out.data, ...(out.customFeatures.length ? { customFeatures: out.customFeatures } : {}) }, variants: out.variants };
}

/** On publish with ocrJobId: which values were read and checked (kept on the version), and the job is closed. */
export async function ocrMarksFor(ctx: AuthContext, jobId: string, typeId: string) {
  const j = await OcrJob.findOne({ _id: jobId, kind: 'ADVISOR', accountId: ctx.accountId, typeId, status: { $in: ['REVIEW_REQUIRED', 'REVIEWED'] } }).lean<JobDoc>();
  if (!j) throw AppError.field('ocrJobId', 'VAL-22');
  const marks: Record<string, { jobId: string; checkedBy: string }> = {};
  for (const r of [...j.rows, ...(j.suggestions ?? [])]) if (r.decision && r.decision !== 'IGNORE') marks[r.key!] = { jobId, checkedBy: ctx.name };
  await OcrJob.updateOne({ _id: jobId }, { $set: { status: 'REVIEWED', reviewedBy: ctx.userId, applied: Object.keys(marks).length } });
  return marks;
}