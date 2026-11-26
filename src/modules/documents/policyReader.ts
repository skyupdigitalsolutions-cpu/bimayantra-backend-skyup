/**
 * Reading a policy document (client change, Nov 2026): the old-policy upload on the Documents tab and
 * "Record existing policy" both read the schedule and fill policy number, category, company, product, variant and
 * validity (start / end date), plus issue date, sum insured and premium. OCR turns the file into text (reader.ts);
 * parsers.ts finds the printed values; this file finds the company, category, product and variant in the catalogue
 * the advisor can see. Every value is a suggestion shown for checking; nothing is saved here.
 */
import type { Request } from 'express';
import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId } from '../../lib/messages.js';
import { logger } from '../../lib/logger.js';
import { Product } from '../catalogue/product.model.js';
import { InsuranceType } from '../catalogue/types.model.js';
import { ProductVariant } from '../catalogue/variant.model.js';
import { open as openFile } from '../files/files.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { readDocument, readerEnabled } from './reader.js';

const norm = (s: string) => ` ${s.toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim()} `;
const has = (text: string, name: string) => name.trim().length >= 3 && text.includes(` ${norm(name).trim()} `);
/** "HDFC ERGO General Insurance Company Limited" is printed as "HDFC ERGO" too. */
const shortName = (name: string) => name.replace(/\b(general|health|life|allianz)?\s*(insurance|assurance)\b.*$/i, '').replace(/\b(company|co|ltd|limited)\b\.?/gi, '').trim();
const KEYWORDS: Array<[RegExp, RegExp]> = [ // words on the policy → a category name like it
  [/\b(health|mediclaim|hospitali[sz]ation|floater)\b/, /health|medical/i],
  [/\b(motor|private car|two wheeler|vehicle|registration no)\b/, /motor|car|vehicle|two/i],
  [/\b(term|life assured|death benefit)\b/, /term|life/i],
  [/\b(travel|trip|overseas)\b/, /travel/i],
  [/\b(home|householder|building|contents)\b/, /home|house|property/i],
];

/** The company, category, product and variant named in the text, from what this account can see. */
export async function matchPolicyCatalogue(accountId: string, text: string) {
  const t = norm(text);
  const out: Record<string, string> = {};
  const insurers = await Insurer.find({ ownerAccountId: { $in: [null, accountId] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>();
  const ins = insurers
    .map((i) => ({ i, len: has(t, i.name) ? i.name.length + 100 : shortName(i.name).length >= 4 && has(t, shortName(i.name)) ? shortName(i.name).length : 0 }))
    .filter((x) => x.len > 0).sort((a, b) => b.len - a.len)[0]?.i;
  if (ins) { out.insurerId = ins._id; out.insurerName = ins.name; }
  if (ins) {
    const products = await Product.find({ insurerId: ins._id, $or: [{ kind: 'VERIFIED' }, { kind: 'OWN', accountId }] }, { name: 1, code: 1, typeId: 1, publishedVersionId: 1 })
      .lean<Array<{ _id: string; name?: string | null; code?: string | null; typeId: string; publishedVersionId?: string | null }>>();
    const prod = products.filter((p) => p.name && has(t, p.name)).sort((a, b) => b.name!.length - a.name!.length)[0];
    if (prod) {
      out.productId = prod._id; out.productName = prod.name!; out.typeId = prod.typeId;
      if (prod.publishedVersionId) {
        const vs = await ProductVariant.find({ productVersionId: prod.publishedVersionId }, { name: 1, isDefault: 1 }).lean<Array<{ _id: string; name: string; isDefault?: boolean }>>();
        const v = vs.filter((x) => has(t, x.name)).sort((a, b) => b.name.length - a.name.length)[0];
        if (v) { out.variantId = v._id; out.variantName = v.name; }
      }
    }
  }
  if (!out.typeId) {
    const types = await InsuranceType.find({ ownerAccountId: { $in: [null, accountId] } }, { name: 1 }).lean<Array<{ _id: string; name: string }>>();
    const byName = types.filter((x) => has(t, x.name)).sort((a, b) => b.name.length - a.name.length)[0];
    const byWord = byName ? null : KEYWORDS.find(([words]) => words.test(t));
    const ty = byName ?? (byWord ? types.find((x) => byWord[1].test(x.name)) : undefined);
    if (ty) { out.typeId = ty._id; out.typeName = ty.name; }
  }
  return out;
}

const WANT: Array<[string, string]> = [
  ['policyNumber', 'policy number'], ['typeId', 'category'], ['insurerId', 'company'], ['productName', 'product'], ['variantName', 'variant'],
  ['startDate', 'start date'], ['endDate', 'end date'],
];
const joinAnd = (l: string[]) => (l.length <= 1 ? l.join('') : `${l.slice(0, -1).join(', ')} and ${l.at(-1)}`);

/** What the screen says after reading: POL-20 all read, POL-21 some (names the rest), POL-22 none, POL-23 reading failed. */
export function policyReadMessage(values: Record<string, unknown> | null, failed = false) {
  const hasV = (k: string) => values?.[k] !== undefined && values?.[k] !== null && values?.[k] !== '';
  const missing = WANT.filter(([k]) => !hasV(k));
  const pack = (messageId: MessageId, params: Record<string, string> = {}) => ({ messageId, message: msg(messageId, params), missing: missing.map(([k]) => k) });
  if (failed) return pack('POL-23');
  if (!WANT.some(([k]) => hasV(k))) return pack('POL-22');
  if (!missing.length) return pack('POL-20');
  const m = joinAnd(missing.map(([, l]) => l));
  return pack('POL-21', { missing: m.charAt(0).toUpperCase() + m.slice(1) });
}

/** POST /policies/existing/read { fileId }: read an uploaded policy document now (within CFG-38) and suggest the values. */
export async function readPolicyFile(ctx: AuthContext, fileId: string, req: Request) {
  if (!readerEnabled()) return { values: {}, ...policyReadMessage(null, true), messageId: 'DOC-14' as MessageId, message: msg('DOC-14') };
  const { file, bytes } = await openFile(ctx, fileId, req).catch(() => { throw AppError.field('fileId', 'VAL-22'); });
  try {
    const limit = cfgNum('CFG-38') * 60_000;
    const timeout = new Promise<never>((_, fail) => setTimeout(() => fail(new Error('OCR time limit (CFG-38) reached')), limit).unref());
    const read = await Promise.race([readDocument('Old policy', bytes, file.mime), timeout]);
    const values: Record<string, unknown> = { ...(read?.values ?? {}), ...(read?.text ? await matchPolicyCatalogue(ctx.accountId!, read.text) : {}) };
    return { values, ...policyReadMessage(values) };
  } catch (e) {
    logger.warn({ fileId, reason: (e as Error).message }, 'Policy document reading failed: manual entry');
    return { values: {}, ...policyReadMessage(null, true) };
  }
}