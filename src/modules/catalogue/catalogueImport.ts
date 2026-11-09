/**
 * Import the SkyUp catalogue workbook (bimayantra-catalogue.xlsx: Insurers, Insurance types, Feature templates, Rating
 * factors, Products, Product features, Add-ons) into MongoDB. Run by `npm run catalogue:import`.
 *
 *  - Dry run unless `apply`: reports what would be created, writes nothing.
 *  - Never overwrites: an insurer (same short code or name), a product (same insurer and code) or a template identical
 *    to the live one is skipped, so running it again is safe.
 *  - Insurers are created ACTIVE (SkyUp library). Each type's feature list and rating factors become a NEW live
 *    template version (the earlier one is retired; products already made keep theirs, CAT-28).
 *  - Products are created as SkyUp-verified DRAFTS. With `publish`, each draft that passes the normal publish checks
 *    (publishCheck) is published at once; the rest stay drafts with what is missing in the report.
 *  - No notifications are sent (a bulk load is not "a new product" for every advisor).
 */
import ExcelJS from 'exceljs';
import { cfgNum } from '../../config/cfg.js';
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { withTx } from '../../lib/mongo.js';
import { Insurer, INSURER_CATEGORIES } from '../insurers/insurer.model.js';
import { Product, ProductVersion } from './product.model.js';
import { prepareData, publishCheck, type ProductData } from './products.service.js';
import { DATA_TYPES, FACTOR_SOURCES, FEATURE_GROUPS, InsuranceType, TemplateVersion, type TemplateDoc } from './types.model.js';
import { ensureStartingTypes } from './types.service.js';
import { formOfType, guessProductForm } from './productForms.js';
import { detailValue } from './ocr.service.js';
import { writeVariants } from './variants.service.js';

type Row = Record<string, unknown>;
const MAKER = 'system:import';

// ── Reading the workbook ──
function cellValue(v: ExcelJS.CellValue): unknown {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('result' in v) return cellValue(v.result as ExcelJS.CellValue); // formula
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return (v as { text: string }).text; // hyperlink
    if ('error' in v) return null;
  }
  return v;
}
export async function readCatalogue(path: string): Promise<Record<string, Row[]>> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out: Record<string, Row[]> = {};
  wb.eachSheet((ws) => {
    const header = (ws.getRow(1).values as ExcelJS.CellValue[]).map((x) => (x === null || x === undefined ? null : String(cellValue(x)).trim()));
    const rows: Row[] = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const r: Row = {};
      header.forEach((h, i) => { if (h) r[h] = cellValue(row.getCell(i).value); });
      if (Object.values(r).some((x) => x !== null && x !== '')) rows.push(r);
    });
    out[ws.name] = rows;
  });
  return out;
}

// ── Value helpers ──
const str = (v: unknown) => (v === null || v === undefined ? null : String(v).trim() || null);
const num = (v: unknown) => { const s = str(v); if (s === null) return null; const n = Number(s.replace(/[₹,%\s]/g, '')); return Number.isFinite(n) ? n : null; };
const bool = (v: unknown) => /^(true|yes|y|1)$/i.test(String(v ?? '').trim());
const short = (v: unknown, max = 200) => { const s = str(v); return s && s.length > max ? `${s.slice(0, max - 1)}…` : s; };
const ints = (v: unknown) => (String(v ?? '').match(/\d+/g) ?? []).map(Number);
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'item';
const isoDate = (v: unknown) => { const s = str(v); if (!s) return null; const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s) ?? null; if (m) return `${m[1]}-${m[2]}-${m[3]}`; const d = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s); return d ? `${d[3]}-${d[2]}-${d[1]}` : null; };

const DATA_TYPE_MAP: Record<string, (typeof DATA_TYPES)[number]> = {
  YES_NO: 'Yes/No', NUMBER: 'Number', AMOUNT: 'Amount in ₹', PERCENT: 'Percentage', DAYS: 'Days', MONTHS: 'Months', YEARS: 'Years', TEXT: 'Text',
};
/** "nivabupa.com (Downloads)" → https://nivabupa.com ; a full link stays as it is. */
export function sourceLink(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const url = /https:\/\/[^\s)]+/i.exec(s)?.[0];
  if (url) return url;
  const dom = /([a-z0-9-]+(?:\.[a-z0-9-]+)+)(\/[^\s)]*)?/i.exec(s);
  return dom ? `https://${dom[1]!.toLowerCase()}${dom[2] ?? ''}` : null;
}
/** Product codes are unique per insurer, so a code longer than CFG-111 drops the insurer prefix ("HDFCERGO-OPTIMASECURE" → "OPTIMASECURE"). */
export function appCode(code: string, insurerCode: string) {
  const max = 20;
  const c = code.trim().toUpperCase();
  if (c.length <= max) return c;
  const pre = `${insurerCode.trim().toUpperCase()}-`;
  const rest = c.startsWith(pre) ? c.slice(pre.length) : c;
  return rest.slice(0, max).replace(/-$/, '');
}
function bands(text: string) {
  if (/one band per year/i.test(text)) return Array.from({ length: 65 - 18 + 1 }, (_, i) => ({ from: 18 + i, to: 18 + i }));
  return [...text.matchAll(/(\d+)\s*-\s*(\d+)/g)].map((m) => ({ from: Number(m[1]), to: Number(m[2]) }));
}

export interface ImportReport {
  apply: boolean; publish: boolean;
  insurers: { created: string[]; skipped: string[]; problems: Array<{ code: string; problem: string }> };
  types: { created: string[] };
  templates: Array<{ type: string; result: 'created' | 'unchanged' | 'would create'; version?: number; features: number; factors: number }>;
  products: Array<{ code: string; savedAs: string; type: string; result: string; missing?: string[]; warnings: string[] }>;
  totals: Record<string, number>;
}

export async function importCatalogue(sheets: Record<string, Row[]>, opts: { apply: boolean; publish?: boolean }): Promise<ImportReport> {
  const publish = !!opts.publish && opts.apply;
  const report: ImportReport = { apply: opts.apply, publish, insurers: { created: [], skipped: [], problems: [] }, types: { created: [] }, templates: [], products: [], totals: {} };
  const need = (name: string) => { const s = sheets[name]; if (!s) throw new Error(`The workbook has no "${name}" sheet`); return s; };
  const ageCap = cfgNum('CFG-150');

  // 1. Insurers (SkyUp library, ACTIVE)
  const insurerIds = new Map<string, string>();
  for (const r of need('Insurers')) {
    const code = str(r.code)?.toUpperCase(); const name = str(r.name);
    if (!code || !name) continue;
    const found = await Insurer.findOne({ ownerAccountId: null, $or: [{ shortCode: code }, { nameKey: name.toLowerCase() }] }, { _id: 1 }).lean<{ _id: string }>();
    if (found) { insurerIds.set(code, found._id); report.insurers.skipped.push(code); continue; }
    const category = str(r.category) as (typeof INSURER_CATEGORIES)[number] | null;
    const irdai = str(r.irdai_reg_no);
    const domains = (str(r.payment_link_domains) ?? '').split(/[\s,;|]+/).map((d) => d.toLowerCase()).filter(Boolean);
    if (!category || !INSURER_CATEGORIES.includes(category)) { report.insurers.problems.push({ code, problem: `category "${r.category}" is not ${INSURER_CATEGORIES.join(' / ')}` }); continue; }
    if (!irdai || !domains.length) { report.insurers.problems.push({ code, problem: 'IRDAI registration number and payment link domains are needed' }); continue; }
    if (opts.apply) {
      const ins = await Insurer.create({ name, nameKey: name.toLowerCase(), shortCode: code, category, irdaiRegNo: irdai, website: str(r.website), paymentDomains: [...new Set(domains)],
        careNumber: str(r.customer_care_phone), careEmail: str(r.customer_care_email)?.toLowerCase() ?? null, status: 'ACTIVE', makerId: MAKER });
      insurerIds.set(code, ins._id);
    }
    report.insurers.created.push(code);
  }

  // 2. Insurance types (SkyUp library)
  await ensureStartingTypes();
  const typeIds = new Map<string, string>();
  const typeNames = new Set([...need('Insurance types').map((r) => str(r.name)), ...need('Products').map((r) => str(r.insurance_type))].filter(Boolean) as string[]);
  for (const name of typeNames) {
    const t = await InsuranceType.findOne({ ownerAccountId: null, nameKey: name.toLowerCase() }, { _id: 1 }).lean<{ _id: string }>();
    if (t) { typeIds.set(name, t._id); continue; }
    if (opts.apply) typeIds.set(name, (await InsuranceType.create({ name, nameKey: name.toLowerCase(), productForm: guessProductForm(name) }))._id);
    report.types.created.push(name);
  }

  // 3. Feature templates + rating factors → a new live template version per type
  const featureRows = need('Feature templates'); const factorRows = sheets['Rating factors'] ?? [];
  for (const type of new Set(featureRows.map((r) => str(r.insurance_type)).filter(Boolean) as string[])) {
    const used = new Set<string>();
    const features = featureRows.filter((r) => str(r.insurance_type) === type).sort((a, b) => (num(a.sort_order) ?? 0) - (num(b.sort_order) ?? 0)).map((r, i) => {
      let key = slug(str(r.name)!); for (let n = 2; used.has(key); n++) key = `${slug(str(r.name)!)}_${n}`; used.add(key);
      const group = str(r.group_name) as (typeof FEATURE_GROUPS)[number];
      return { key, name: str(r.name)!, group: FEATURE_GROUPS.includes(group) ? group : 'Other', dataType: DATA_TYPE_MAP[String(r.data_type).toUpperCase()] ?? 'Text', requiredToPublish: bool(r.required_to_publish), order: i + 1, help: short(r.help_text) };
    });
    const factors = factorRows.filter((r) => str(r.insurance_type) === type && str(r.name) && FACTOR_SOURCES.includes(str(r.filled_from) as never)).map((r) => {
      const kind = /^band/i.test(String(r.kind)) ? 'BAND' as const : 'VALUE' as const;
      const ex = str(r.example_values) ?? '';
      return { key: slug(str(r.name)!), name: str(r.name)!, kind, source: str(r.filled_from) as (typeof FACTOR_SOURCES)[number], bands: kind === 'BAND' ? bands(ex) : [], values: kind === 'VALUE' ? ex.split(',').map((x) => x.trim()).filter(Boolean) : [] };
    });
    const questions = factors.filter((f) => f.source === 'Asked in the quotation').map((f) => ({ key: f.key, label: f.name, dataType: 'Text' as const, required: true }));
    const typeId = typeIds.get(type);
    const live = typeId ? await TemplateVersion.findOne({ typeId, status: 'ACTIVE' }).lean<TemplateDoc>() : null;
    const same = live && JSON.stringify(live.features.map((f) => [f.key, f.name, f.dataType, f.requiredToPublish])) === JSON.stringify(features.map((f) => [f.key, f.name, f.dataType, f.requiredToPublish]));
    if (same) { report.templates.push({ type, result: 'unchanged', version: live.number, features: features.length, factors: live.factors.length }); continue; }
    if (!opts.apply || !typeId) { report.templates.push({ type, result: 'would create', features: features.length, factors: factors.length }); continue; }
    const last = await TemplateVersion.findOne({ typeId }, { number: 1 }).sort({ number: -1 }).lean<{ number: number }>();
    const number = (last?.number ?? 0) + 1;
    await withTx(async (session) => {
      await TemplateVersion.updateMany({ typeId, status: 'ACTIVE' }, { $set: { status: 'RETIRED', isOpen: null } }, { session: session ?? undefined });
      await TemplateVersion.create([{ typeId, number, status: 'ACTIVE', isOpen: null, features, factors, questions, makerId: MAKER, approvedBy: MAKER, approvedAt: clock.now() }], { session: session ?? undefined });
    });
    report.templates.push({ type, result: 'created', version: number, features: features.length, factors: factors.length });
  }

  // 4. Products (verified drafts) with their features and add-ons
  const featuresOf = new Map<string, Row[]>(); for (const r of need('Product features')) { const c = str(r.product_code); if (c) featuresOf.set(c, [...(featuresOf.get(c) ?? []), r]); }
  const addOnsOf = new Map<string, Row[]>(); for (const r of sheets['Add-ons'] ?? []) { const c = str(r.product_code); if (c) addOnsOf.set(c, [...(addOnsOf.get(c) ?? []), r]); }
  const detailsOf = new Map<string, Row[]>(); for (const r of sheets['Category details'] ?? []) { const c = str(r.product_code); if (c) detailsOf.set(c, [...(detailsOf.get(c) ?? []), r]); }
  for (const r of need('Products')) {
    const code = str(r.product_code); const insurerCode = str(r.insurer_code)?.toUpperCase(); const type = str(r.insurance_type);
    if (!code || !insurerCode || !type) continue;
    const warnings: string[] = [];
    const saved = appCode(code, insurerCode);
    if (saved !== code.toUpperCase()) warnings.push(`code shortened to ${saved} (codes are at most 20 characters)`);
    const entry = { code, savedAs: saved, type, warnings } as ImportReport['products'][number];
    const insurerId = insurerIds.get(insurerCode); const typeId = typeIds.get(type);
    if (opts.apply && (!insurerId || !typeId)) { report.products.push({ ...entry, result: `skipped: ${!insurerId ? `insurer ${insurerCode} not imported` : `type ${type} missing`}` }); continue; }
    const tpl = typeId ? await TemplateVersion.findOne({ typeId, status: 'ACTIVE' }).lean<TemplateDoc>() : null;

    // values
    const d: ProductData = {
      name: short(r.name) ?? undefined, description: short(r.short_description), uin: str(r.uin)?.toUpperCase() ?? undefined, launchDate: isoDate(r.launch_date) ?? undefined,
      pricingMode: (str(r.pricing_mode) === 'RATE_TABLE' ? 'RATE_TABLE' : 'MANUAL_ENTRY'), taxPercent: num(r.tax_percent) ?? undefined,
      nomineeRequired: bool(r.nominee_required), maxNominees: num(r.max_nominees) ?? undefined, gracePeriodDays: num(r.grace_days),
      sourceLink: sourceLink(r.source_link), sourceCheckedOn: isoDate(r.date_checked),
    };
    if ((str(r.short_description)?.length ?? 0) > 200) warnings.push('description shortened to 200 characters');
    const aMin = num(r.adult_entry_min_years); let aMax = num(r.adult_entry_max_years);
    if (bool(r.adult_entry_no_cap)) aMax = ageCap;
    if (aMax !== null && aMax > ageCap) { warnings.push(`adult entry age ${aMax} capped at ${ageCap} (CFG-150)`); aMax = ageCap; }
    if (aMin !== null) d.adultMin = aMin; if (aMax !== null) d.adultMax = aMax;
    const cMaxY = num(r.child_entry_max_years);
    if (cMaxY !== null) { d.coversChildren = true; d.childMax = cMaxY; d.childMin = Math.floor((num(r.child_entry_min_days) ?? 0) / 365); }
    const siMin = num(r.sum_insured_min); const siMax = num(r.sum_insured_max);
    const opts2 = ints(String(r.sum_insured_values ?? '').replace(/,/g, '')).filter((n) => n >= 1000);
    if (siMin && siMax) d.sumInsured = { min: siMin, max: siMax }; else if (opts2.length) d.sumInsured = { options: opts2 };
    const terms = ints(r.policy_terms_app ?? r.policy_term_options).filter((n) => n >= 1 && n <= cfgNum('CFG-58'));
    if (terms.length) d.policyTerms = [...new Set(terms)];

    // features, by name against the type's live template; anything else becomes the product's own feature
    const byName = new Map((tpl?.features ?? []).map((f) => [f.name.toLowerCase(), f]));
    d.features = {}; const custom: NonNullable<ProductData['customFeatures']> = [];
    for (const fr of featuresOf.get(code) ?? []) {
      const fname = str(fr.feature_name); if (!fname) continue;
      const page = ints(fr.source_page)[0] ?? null;
      const f = byName.get(fname.toLowerCase());
      const raw = str(fr.value);
      if (!f) {
        const key = `cf_${slug(fname)}`.slice(0, 53);
        if (!custom.some((c) => c.key === key)) custom.push({ key, name: fname, origin: 'SKYUP', dataType: /^(yes|no)$/i.test(raw ?? '') ? 'Yes/No' : 'Text' });
        d.features[key] = bool(fr.not_stated) ? { notStated: true } : { value: /^(yes|no)$/i.test(raw ?? '') ? /^yes$/i.test(raw!) : raw, page };
        continue;
      }
      if (bool(fr.not_stated)) { d.features[f.key] = { notStated: true, page }; continue; }
      const value = f.dataType === 'Yes/No' ? /^(yes|y|true|covered)$/i.test(raw ?? '') : f.dataType === 'Text' ? short(raw, 500) : (num(raw) ?? short(raw, 500));
      d.features[f.key] = { value, page };
    }
    if (custom.length) { d.customFeatures = custom; warnings.push(`${custom.length} feature(s) not in the ${type} template kept as the product's own: ${custom.map((c) => c.name).join(', ')}`); }

    // add-ons
    const addOns: NonNullable<ProductData['addOns']> = []; let noPrice = 0;
    for (const a of addOnsOf.get(code) ?? []) {
      const value = num(a.price_value); const pt = String(a.price_type ?? '');
      if (!str(a.name) || value === null || !pt) { noPrice++; continue; }
      addOns.push({ name: short(a.name)!, description: short(a.description), priceType: /%|percent/i.test(pt) ? 'PERCENT' : 'FIXED', value });
    }
    if (addOns.length) d.addOns = addOns;
    if (noPrice) warnings.push(`${noPrice} add-on(s) without a price left out`);
    if (addOns.length > cfgNum('CFG-40')) warnings.push(`${addOns.length} add-ons, above the ${cfgNum('CFG-40')} allowed (CFG-40): raise CFG-40 or remove some`);

    // category details ("Category details" sheet: field = the form's field key, lists separated by "|")
    const type0 = typeId ? await InsuranceType.findById(typeId, { name: 1, productForm: 1 }).lean<{ name: string; productForm?: string | null }>() : { name: type, productForm: null };
    const form = formOfType(type0);
    const details: Record<string, unknown> = {};
    for (const cr of detailsOf.get(code) ?? []) {
      const f = form.fields.find((x) => x.key === str(cr.field));
      const v = f ? detailValue(f, (str(cr.value) ?? '').replace(/\s*\|\s*/g, ', ')) : undefined;
      if (!f || v === undefined) { warnings.push(`category detail ${str(cr.field)} = "${str(cr.value)}" not used (not a ${form.label} field, or not a value it accepts)`); continue; }
      details[f.key] = v;
    }
    if (Object.keys(details).length) d.details = details;

    const existing = insurerId ? await Product.findOne({ kind: 'VERIFIED', insurerId, code: saved }, { _id: 1, status: 1 }).lean<{ _id: string; status: string }>() : null;
    if (!opts.apply) { report.products.push({ ...entry, result: existing ? 'exists (skip)' : 'would create' }); continue; }
    if (existing && !(publish && existing.status === 'NOT_PUBLISHED')) { report.products.push({ ...entry, result: 'exists (skipped)' }); continue; }

    let productId = existing?._id; let vid: string;
    const data = await prepareData(typeId!, d);
    if (!productId) {
      const out = await withTx(async (session) => {
        const [p] = await Product.create([{ kind: 'VERIFIED', insurerId, typeId, code: saved, makerId: MAKER }], { session: session ?? undefined });
        const [v] = await ProductVersion.create([{ productId: p!._id, number: 1, templateId: tpl!._id, makerId: MAKER, data }], { session: session ?? undefined });
        return { p: p!._id, v: v!._id };
      });
      productId = out.p; vid = out.v;
    } else {
      const open = await ProductVersion.findOne({ productId, isOpen: true }, { _id: 1 }).lean<{ _id: string }>();
      if (!open) { report.products.push({ ...entry, result: 'exists (skipped)' }); continue; }
      vid = open._id;
    }
    if (!publish) { report.products.push({ ...entry, result: existing ? 'exists (draft)' : 'created as draft' }); continue; }

    // publish through the normal checks
    const v = (await ProductVersion.findById(vid).lean<{ data: ProductData; templateId: string }>())!;
    try {
      await publishCheck('VERIFIED', insurerId!, typeId!, v.templateId, v.data, productId, []);
    } catch (e) {
      const err = e as AppError & { details?: { missing?: string[] }; fields?: Array<{ field: string; message: string }> };
      const missing = err.details?.missing ?? err.fields?.map((f) => `${f.field}: ${f.message}`) ?? [err.message];
      report.products.push({ ...entry, result: existing ? 'exists (still draft)' : 'created as draft', missing, warnings });
      continue;
    }
    const now = clock.now();
    await withTx(async (session) => {
      await ProductVersion.updateOne({ _id: vid }, { $set: { status: 'PUBLISHED', isOpen: null, publishedAt: now, approvedBy: MAKER, approvedAt: now } }, { session: session ?? undefined });
      await writeVariants(productId!, vid, v.data, [], session);
      await Product.updateOne({ _id: productId }, { $set: { publishedVersionId: vid, name: v.data.name ?? null, launchDate: v.data.launchDate ?? null, status: v.data.launchDate && v.data.launchDate > istToday() ? 'UPCOMING' : 'ACTIVE' }, $inc: { version: 1 } }, { session: session ?? undefined });
    });
    report.products.push({ ...entry, result: existing ? 'published (was draft)' : 'created and published', warnings });
  }

  const count = (re: RegExp) => report.products.filter((p) => re.test(p.result)).length;
  report.totals = {
    insurersCreated: report.insurers.created.length, insurersSkipped: report.insurers.skipped.length, insurerProblems: report.insurers.problems.length,
    templatesCreated: report.templates.filter((t) => t.result === 'created').length,
    productsPublished: count(/published/), productsDraft: count(/draft/), productsSkipped: count(/skip/), productsWouldCreate: count(/would create/),
  };
  return report;
}