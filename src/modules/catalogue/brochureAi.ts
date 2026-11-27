/**
 * Brochure reading with an AI model (client request, Nov 2026): OCR alone missed most features because brochure
 * wording differs from the template's. After OCR turns the brochure into text (Google Document AI), the text is
 * sent to OpenAI (gpt-4o-mini by default) with the category's feature list and product fields, and the model returns
 * each value with the page it is on. Those values take the place of the pattern-matched ones; anything the model
 * leaves empty keeps what the patterns found. Every value is still shown in the form for the advisor to change.
 *
 * Only brochures go to the model: they are public insurer documents. Customer documents (Aadhaar, PAN, old policies)
 * never do (P-18). Switched on by OPENAI_API_KEY; BROCHURE_AI=none turns it off. A failure or timeout never fails the
 * reading: the pattern-matched values are used as before. The brochure text is never logged.
 */
import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';

export const brochureAiEnabled = () => !!env.OPENAI_API_KEY && env.BROCHURE_AI !== 'none';

export type AiFeature = { key: string; name: string; dataType: string };
export type AiField = { key: string; label: string; hint?: string };
export type AiValue = { key: string; value: string | null; page: number | null; quote?: string | null; printedName?: string | null };
export type AiResult = { features: AiValue[]; details: AiValue[]; variants: Array<{ name: string; page: number | null }>; extraFeatures: Array<{ name: string; value: string; page: number | null }> };

/** The product fields asked for, besides the category's own details (form fields). */
export const PRODUCT_FIELDS: AiField[] = [
  { key: 'name', label: 'Product name', hint: 'the plan name as printed, without the insurer name' },
  { key: 'uin', label: 'IRDAI product UIN', hint: 'like HDFHLIP21467V022021' },
  { key: 'launchDate', label: 'Launch / effective date', hint: 'YYYY-MM-DD; only a date the brochure gives as launch, effective or w.e.f. date' },
  { key: 'adultMin', label: 'Adult minimum entry age (years)' },
  { key: 'adultMax', label: 'Adult maximum entry age (years)' },
  { key: 'policyTerms', label: 'Policy terms in years', hint: 'comma separated, e.g. 1, 2, 3' },
  { key: 'sumInsuredOptions', label: 'Sum insured options in rupees', hint: 'comma separated whole rupees, e.g. 300000, 500000, 1000000' },
  { key: 'gracePeriodDays', label: 'Grace period (days)' },
];

const FORMAT: Record<string, string> = {
  'Yes/No': '"Yes" or "No"', 'Amount in ₹': 'whole rupees as digits, e.g. 2000 (no commas, no symbol)', Percentage: 'a number, e.g. 20',
  Days: 'a number of days', Months: 'a number of months', Years: 'a number of years', Number: 'a number', Text: 'short text (max 120 characters)',
};

const schema = {
  type: 'object', additionalProperties: false, required: ['features', 'details', 'variants', 'extraFeatures'],
  properties: {
    features: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value', 'page', 'quote', 'printedName'], properties: { key: { type: 'string' }, value: { type: ['string', 'null'] }, page: { type: ['integer', 'null'] }, quote: { type: ['string', 'null'] }, printedName: { type: ['string', 'null'] } } } },
    details: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['key', 'value', 'page'], properties: { key: { type: 'string' }, value: { type: ['string', 'null'] }, page: { type: ['integer', 'null'] } } } },
    variants: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'page'], properties: { name: { type: 'string' }, page: { type: ['integer', 'null'] } } } },
    extraFeatures: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['name', 'value', 'page'], properties: { name: { type: 'string' }, value: { type: 'string' }, page: { type: ['integer', 'null'] } } } },
  },
};

/** The request body (exported for tests). Pages are marked so the model can say where each value is. */
export function buildRequest(pages: Array<{ number: number; text: string }>, features: AiFeature[], fields: AiField[]) {
  let budget = env.BROCHURE_AI_MAX_CHARS;
  const text = pages.map((p) => { const t = `=== Page ${p.number} ===\n${p.text}`.slice(0, Math.max(0, budget)); budget -= t.length; return t; }).filter(Boolean).join('\n\n');
  const instructions = [
    'You read Indian insurance product brochures and fill in product data. Use only what the brochure states; never guess.',
    'For each feature: give its value in the stated format, or null when the brochure does not mention it. A benefit listed as covered or included is "Yes"; one listed under exclusions or as not covered is "No".',
    'For durations, convert to the unit asked (e.g. "2 years" for a Months feature is 24). For amounts, give rupees (e.g. "Rs. 2 lakh" is 200000). For "up to sum insured" on an amount feature, give null and do not invent a number.',
    'details: the product fields asked for, with null when not stated. variants: the plan or variant names the brochure offers (e.g. Silver, Gold, Plan A), not features. extraFeatures: up to 15 other benefits the brochure states that are not in the feature list, with a short value.',
    'page: the page number (from the === Page n === markers) where the value is stated.',
    'quote: the brochure\'s exact words for that feature\'s value, copied verbatim (max 200 characters), e.g. "Covered up to Sum Insured". printedName: the feature\'s name exactly as the brochure prints it, e.g. "In-Patient Treatment" for In-patient hospitalisation. Both null when the feature is not mentioned.',
    'extraFeatures: name exactly as printed in the brochure, and value as the brochure\'s exact words (verbatim, max 200 characters). Only real benefits or coverages: no disclaimers, contact details, legal notes or sentence fragments.',
  ].join('\n');
  const ask = {
    features: features.map((f) => ({ key: f.key, name: f.name, format: FORMAT[f.dataType] ?? FORMAT.Text })),
    details: fields.map((f) => ({ key: f.key, label: f.label, ...(f.hint ? { format: f.hint } : {}) })),
  };
  return {
    model: env.OPENAI_MODEL, temperature: 0,
    response_format: { type: 'json_schema', json_schema: { name: 'brochure_values', strict: true, schema } },
    messages: [
      { role: 'system', content: instructions },
      { role: 'user', content: `Fields to fill (JSON):\n${JSON.stringify(ask)}\n\nBrochure text:\n${text}` },
    ],
  };
}

/** Ask the model. Returns null when switched off, on any error, or past the time limit (the caller keeps the OCR values). */
export async function aiExtract(pages: Array<{ number: number; text: string }>, features: AiFeature[], fields: AiField[], jobId: string): Promise<AiResult | null> {
  if (!brochureAiEnabled()) return null;
  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal: AbortSignal.timeout(env.BROCHURE_AI_TIMEOUT_SECONDS * 1000),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${env.OPENAI_API_KEY}` },
      body: JSON.stringify(buildRequest(pages, features, fields)),
    });
    if (!res.ok) { logger.warn({ jobId, status: res.status }, 'Brochure AI request refused: OCR values used'); return null; }
    const body = (await res.json()) as { choices?: Array<{ message?: { content?: string; refusal?: string } }>; usage?: unknown };
    const content = body.choices?.[0]?.message?.content;
    if (!content) { logger.warn({ jobId }, 'Brochure AI returned no content: OCR values used'); return null; }
    const out = JSON.parse(content) as AiResult;
    logger.info({ jobId, usage: body.usage, features: out.features?.filter((f) => f.value !== null).length ?? 0 }, 'Brochure read with AI');
    return { features: out.features ?? [], details: out.details ?? [], variants: out.variants ?? [], extraFeatures: out.extraFeatures ?? [] };
  } catch (e) {
    logger.warn({ jobId, reason: (e as Error).message }, 'Brochure AI failed: OCR values used');
    return null;
  }
}

type FeatureRow = { key: string; name: string; dataType: string; found: boolean; value: string | null; confidence: number; page: number | null; decision: null; editedValue: null };
type DetailRow = { key: string; label: string; value: string | null; confidence: number; page: number | null; decision: null; editedValue: null; quote?: string | null };
const AI_CONFIDENCE = 0.9;
const clean = (v: string | null | undefined) => (v === null || v === undefined ? null : String(v).trim().slice(0, 200) || null);

/**
 * Put the model's values over the pattern-matched ones: a value from the model wins; where the model has none, the
 * pattern match stays. Variant names from the model replace the guessed tier names when it found any.
 */
export function mergeAi(
  rows: FeatureRow[],
  extra: { details: DetailRow[]; variants: DetailRow[]; suggestions: DetailRow[] },
  ai: AiResult,
  labels: Record<string, string>,
) {
  const fv = new Map(ai.features.map((f) => [f.key, f]));
  const outRows = rows.map((r) => {
    const v = clean(fv.get(r.key)?.value);
    const got = fv.get(r.key);
    return v ? { ...r, found: true, value: v, confidence: AI_CONFIDENCE, page: got?.page ?? r.page, quote: clean(got?.quote) ?? (r as { quote?: string | null }).quote ?? null, printedName: clean(got?.printedName) ?? (r as { printedName?: string | null }).printedName ?? null } : r;
  });
  const details = [...extra.details];
  for (const d of ai.details) {
    const v = clean(d.value);
    if (!v) continue;
    const row: DetailRow = { key: d.key, label: labels[d.key] ?? d.key, value: v, confidence: AI_CONFIDENCE, page: d.page ?? null, decision: null, editedValue: null };
    const i = details.findIndex((x) => x.key === d.key);
    if (i >= 0) details[i] = { ...details[i]!, value: v, confidence: AI_CONFIDENCE, page: d.page ?? details[i]!.page };
    else details.push(row);
  }
  const names = [...new Set(ai.variants.map((v) => clean(v.name)).filter(Boolean) as string[])].slice(0, 10);
  const variants = names.length
    ? names.map((n) => ({ key: n.toLowerCase(), label: n, value: n, confidence: AI_CONFIDENCE, page: ai.variants.find((v) => clean(v.name) === n)?.page ?? null, decision: null, editedValue: null }))
    : extra.variants;
  const suggestions = [...extra.suggestions];
  for (const s of ai.extraFeatures.slice(0, 15)) {
    const name = clean(s.name); const value = clean(s.value);
    if (!name || !value) continue;
    const key = `cf_${name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 50)}`;
    if (suggestions.some((x) => x.key === key) || outRows.some((r) => r.name.toLowerCase() === name.toLowerCase())) continue;
    suggestions.push({ key, label: name, value, confidence: 0.8, page: s.page ?? null, decision: null, editedValue: null, quote: value } as DetailRow); // as printed
  }
  return { rows: outRows, details, variants, suggestions: suggestions.slice(0, 30) };
}