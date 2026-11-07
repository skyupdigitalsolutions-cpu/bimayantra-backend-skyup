import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'node:crypto';
import type { Model } from 'mongoose';
import { env } from '../config/env.js';
import { decryptField, encryptField } from './crypto.js';

/**
 * Field-level encryption of personal data (names, mobiles, emails, KYC values and their copies).
 *
 * The layer sits between Mongoose and the MongoDB driver: protect(Model, spec) wraps the model's collection, so
 * every write is encrypted after Mongoose has cast and validated plain values, and every read (hydrated, lean,
 * cursor, findOneAndUpdate) is decrypted before Mongoose or the service sees it. Anyone reading the database
 * directly sees only ciphertext and keyed hashes; the API and the frontend keep working with plain values.
 *
 * Kinds:
 *  - Deterministic (name, nameKey, mobile, email, contact, key): AES-256-GCM with a nonce derived from an HMAC of
 *    the value, so the same value always gives the same ciphertext. Exact-match queries, upserts and unique
 *    indexes keep working (filters are encrypted the same way). Reveals only that two rows share a value.
 *  - text: AES-256-GCM with a random nonce (the existing "v1" format). Cannot be queried by value.
 *  - json: a whole object or array, serialised and encrypted (audit snapshots, nominees, …).
 *
 * Search: substring search is impossible on ciphertext, so records carry keyed-hash tokens under searchIndex.*
 * (word prefixes of names, digit runs of mobiles, prefixes of emails). Build queries with piiSearch().
 *
 * Rows written before this layer existed are plain text: they are returned as they are, so the app keeps
 * showing them, but run `npm run db:migrate:encrypt-pii` so lookups and search find them.
 */

export type DetKind = 'name' | 'nameKey' | 'mobile' | 'email' | 'contact' | 'key';
export type Kind = DetKind | 'text' | 'json';
export type SearchGroup = 'name' | 'mobile' | 'email';
export interface PiiSpec {
  /** Field path (dotted; array levels are crossed automatically) → kind. */
  fields: Record<string, Kind>;
  /** Search token group → the field it is built from. Needs searchIndexFields() in the schema. */
  search?: Partial<Record<SearchGroup, string>>;
}

const ROOT = Buffer.from(env.PII_ENCRYPTION_KEY, 'base64');
const derive = (key: Buffer, label: string) => Buffer.from(hkdfSync('sha256', key, Buffer.alloc(0), `bimayantra/pii/${label}`, 32));
const DET_ENC = derive(ROOT, 'det-enc');
const DET_IV = derive(ROOT, 'det-iv');
const TOKEN_KEY = derive(Buffer.from(env.PII_HASH_KEY, 'base64'), 'search');

const DET = /^d1:[A-Za-z0-9_-]+$/;
const RAND = /^v1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/;
const JSON_ENC = /^j1:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]*$/;
const DET_KINDS = new Set<Kind>(['name', 'nameKey', 'mobile', 'email', 'contact', 'key']);

export const isEncrypted = (v: unknown): v is string => typeof v === 'string' && (DET.test(v) || RAND.test(v) || JSON_ENC.test(v));

/** Deterministic encryption: same kind and value → same ciphertext. */
export function encryptDet(kind: DetKind, plain: string): string {
  const iv = createHmac('sha256', DET_IV).update(`${kind}\u0000${plain}`).digest().subarray(0, 12);
  const c = createCipheriv('aes-256-gcm', DET_ENC, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `d1:${Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64url')}`;
}

function decryptDet(stored: string): string {
  const raw = Buffer.from(stored.slice(3), 'base64url');
  const d = createDecipheriv('aes-256-gcm', DET_ENC, raw.subarray(0, 12));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
}

/** Any value this layer wrote, back to plain; anything else (legacy plain text, numbers) unchanged. */
export function decryptAny(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  if (DET.test(v)) return decryptDet(v);
  if (RAND.test(v)) return decryptField(v);
  if (JSON_ENC.test(v)) return JSON.parse(decryptField(`v1:${v.slice(3)}`));
  return v;
}

function encryptValue(kind: Kind, v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (kind === 'json') return isEncrypted(v) ? v : `j1:${encryptField(JSON.stringify(v)).slice(3)}`;
  if (Array.isArray(v)) return v.map((x) => encryptValue(kind, x));
  if (typeof v !== 'string' || isEncrypted(v)) return v;
  return DET_KINDS.has(kind) ? encryptDet(kind as DetKind, v) : encryptField(v);
}

// ── Search tokens ────────────────────────────────────────────────────────────

const token = (group: SearchGroup, s: string) => createHmac('sha256', TOKEN_KEY).update(`${group}|${s}`).digest('base64url').slice(0, 22);
const words = (s: string) => s.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const prefixes = (s: string, min: number, max: number) => Array.from({ length: Math.max(0, Math.min(s.length, max) - min + 1) }, (_, i) => s.slice(0, min + i));

/** Tokens stored on a record for one search group. */
export function searchTokens(group: SearchGroup, value: unknown): string[] {
  if (typeof value !== 'string' || !value) return [];
  const out = new Set<string>();
  if (group === 'name') for (const w of words(value)) for (const p of prefixes(w, 1, 20)) out.add(p);
  if (group === 'email') {
    const e = value.trim().toLowerCase();
    for (const p of prefixes(e, 3, 64)) out.add(p);
    const domain = e.split('@')[1];
    if (domain) for (const p of prefixes(domain, 3, 64)) out.add(p);
  }
  if (group === 'mobile') {
    const d = value.replace(/\D/g, ''); // stored +91XXXXXXXXXX → 12 digits
    for (let i = 0; i < d.length; i++) for (let j = i + 4; j <= d.length; j++) out.add(d.slice(i, j));
  }
  return [...out].map((s) => token(group, s));
}

/**
 * Filter clauses for a search box, to be combined with $or (plus any plain-text clauses such as the record number).
 * Names match when every typed word starts a word of the name; emails by prefix (of the address or its domain);
 * mobiles when the typed digits (at least minDigits) appear anywhere in the number.
 */
export function piiSearch(text: string, groups: { name?: boolean; email?: boolean; mobile?: number }): Array<Record<string, unknown>> {
  const clauses: Array<Record<string, unknown>> = [];
  if (groups.name) {
    const ws = words(text).map((w) => token('name', w.slice(0, 20)));
    if (ws.length) clauses.push({ 'searchIndex.name': { $all: ws } });
  }
  const e = text.trim().toLowerCase();
  if (groups.email && e.length >= 3) clauses.push({ 'searchIndex.email': token('email', e.slice(0, 64)) });
  const digits = text.replace(/[\s\-()]/g, '').replace(/^\+/, '');
  if (groups.mobile && /^\d+$/.test(digits) && digits.length >= groups.mobile) clauses.push({ 'searchIndex.mobile': token('mobile', digits.slice(0, 12)) });
  return clauses;
}

/** Schema paths for the search tokens (never returned unless selected). */
export function searchIndexFields(...groups: SearchGroup[]) {
  return { searchIndex: Object.fromEntries(groups.map((g) => [g, { type: [String], select: false, default: undefined }])) };
}

// ── Walking documents, updates and filters ───────────────────────────────────

export class PiiQueryError extends Error {}

const isPlain = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);

/** Mongoose subdocuments can appear inside save deltas: turn them into plain objects before walking. */
function plain(v: unknown): unknown {
  if (v && typeof v === 'object' && !Array.isArray(v) && !isPlain(v) && typeof (v as { toObject?: unknown }).toObject === 'function') {
    return (v as { toObject: (o: object) => unknown }).toObject({ depopulate: true, transform: false, virtuals: false, getters: false, flattenMaps: true });
  }
  return v;
}

/** Applies fn at the path (crossing arrays), copy-on-write. */
function mapPath(obj: unknown, segs: string[], fn: (v: unknown) => unknown): unknown {
  if (segs.length === 0) return fn(Array.isArray(obj) ? obj.map(plain) : plain(obj));
  obj = plain(obj);
  if (obj === null || obj === undefined) return obj;
  if (Array.isArray(obj)) return obj.map((e) => mapPath(e, segs, fn));
  if (!isPlain(obj)) return obj;
  const [h, ...t] = segs as [string, ...string[]];
  if (!(h in obj)) return obj;
  return { ...obj, [h]: mapPath(obj[h], t, fn) };
}

function getPath(obj: unknown, segs: string[]): unknown {
  let cur = obj;
  for (const s of segs) { cur = plain(cur); if (!isPlain(cur)) return undefined; cur = cur[s]; }
  return cur;
}

/** 'history.$.address', 'answers.0.value', 'a.$[x].b' → 'history.address', 'answers.value', 'a.b'. */
const normKey = (k: string) => k.split('.').filter((s) => !/^(\$|\$\[[^\]]*\]|\d+)$/.test(s)).join('.');

interface Compiled { fields: Array<{ path: string; segs: string[]; kind: Kind }>; search: Array<[SearchGroup, string]>; name: string }

function compile(name: string, spec: PiiSpec): Compiled {
  return {
    name,
    fields: Object.entries(spec.fields).map(([path, kind]) => ({ path, segs: path.split('.'), kind })),
    search: Object.entries(spec.search ?? {}) as Array<[SearchGroup, string]>,
  };
}

function encodeDoc(c: Compiled, doc: unknown): unknown {
  if (!isPlain(doc)) return doc;
  let out: Record<string, unknown> = doc;
  if (c.search.length) {
    const si: Record<string, unknown> = isPlain(out.searchIndex) ? { ...out.searchIndex } : {};
    for (const [g, src] of c.search) si[g] = searchTokens(g, decryptAny(getPath(doc, src.split('.')))); // the value may already be encrypted (migration)
    out = { ...out, searchIndex: si };
  }
  for (const f of c.fields) out = mapPath(out, f.segs, (v) => encryptValue(f.kind, v)) as Record<string, unknown>;
  return out;
}

export function decodeDoc(c: Pick<Compiled, 'fields'>, doc: unknown): unknown {
  if (!isPlain(doc)) return doc;
  let out: unknown = doc;
  for (const f of c.fields) out = mapPath(out, f.segs, (v) => (Array.isArray(v) && f.kind !== 'json' ? v.map(decryptAny) : decryptAny(v)));
  return out;
}

/** The value written at key k of an update operator, with any protected path inside it encrypted. */
function encodeAtKey(c: Compiled, k: string, v: unknown): unknown {
  const kn = normKey(k);
  let out = v;
  for (const f of c.fields) {
    if (f.path === kn) out = encryptValue(f.kind, out);
    else if (f.path.startsWith(`${kn}.`)) out = mapPath(out, f.path.slice(kn.length + 1).split('.'), (x) => encryptValue(f.kind, x));
    else if (kn.startsWith(`${f.path}.`)) throw new PiiQueryError(`${c.name}: "${k}" is inside the encrypted field "${f.path}"; set the whole field`);
  }
  return out;
}

function encodeUpdate(c: Compiled, update: unknown): unknown {
  if (Array.isArray(update) || !isPlain(update)) return update; // pipeline updates are passed through (none touch PII)
  const out: Record<string, unknown> = { ...update };
  const tokens: Record<string, string[]> = {};
  const unsetTokens: Record<string, ''> = {};
  for (const op of ['$set', '$setOnInsert', '$push', '$addToSet'] as const) {
    const body = out[op];
    if (!isPlain(body)) continue;
    const next: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(body)) {
      next[k] = (op === '$push' || op === '$addToSet') && isPlain(v) && Array.isArray(v.$each)
        ? { ...v, $each: v.$each.map((e) => encodeAtKey(c, k, e)) }
        : encodeAtKey(c, k, v);
      if (op !== '$push' && op !== '$addToSet') {
        const kn = normKey(k);
        for (const [g, src] of c.search) {
          if (src === kn) tokens[`searchIndex.${g}`] = searchTokens(g, decryptAny(v));
          else if (src.startsWith(`${kn}.`)) tokens[`searchIndex.${g}`] = searchTokens(g, decryptAny(getPath(v, src.slice(kn.length + 1).split('.'))));
        }
      }
    }
    out[op] = next;
  }
  if (isPlain(out.$unset)) for (const k of Object.keys(out.$unset)) for (const [g, src] of c.search) if (src === normKey(k)) unsetTokens[`searchIndex.${g}`] = '';
  if (Object.keys(tokens).length) out.$set = { ...(isPlain(out.$set) ? out.$set : {}), ...tokens };
  if (Object.keys(unsetTokens).length) out.$unset = { ...(isPlain(out.$unset) ? out.$unset : {}), ...unsetTokens };
  return out;
}

function encodeCond(c: Compiled, f: { path: string; kind: Kind }, v: unknown): unknown {
  const deny = (why: string) => { throw new PiiQueryError(`${c.name}.${f.path} is encrypted: ${why}. Use exact values or piiSearch()`); };
  const one = (x: unknown): unknown => {
    if (x === null || x === undefined) return x;
    if (x instanceof RegExp) return deny('a pattern cannot match it');
    if (typeof x !== 'string') return x;
    if (!DET_KINDS.has(f.kind)) return deny('it cannot be matched by value');
    return isEncrypted(x) ? x : encryptDet(f.kind as DetKind, x);
  };
  if (!isPlain(v)) return Array.isArray(v) ? deny('array equality') : one(v);
  const keys = Object.keys(v);
  if (!keys.some((k) => k.startsWith('$'))) return deny('sub-document equality');
  const out: Record<string, unknown> = {};
  for (const [op, x] of Object.entries(v)) {
    if (op === '$eq' || op === '$ne') out[op] = one(x);
    else if (op === '$in' || op === '$nin') out[op] = (x as unknown[]).map(one);
    else if (op === '$exists' || op === '$type') out[op] = x;
    else if (op === '$not') out[op] = x instanceof RegExp ? deny('a pattern cannot match it') : encodeCond(c, f, x);
    else deny(`operator ${op} is not supported`);
  }
  return out;
}

function encodeFilter(c: Compiled, filter: unknown, prefix = ''): unknown {
  if (!isPlain(filter)) return filter;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(filter)) {
    if (k === '$and' || k === '$or' || k === '$nor') { out[k] = (v as unknown[]).map((x) => encodeFilter(c, x, prefix)); continue; }
    if (k.startsWith('$')) { out[k] = v; continue; }
    const kn = normKey(prefix ? `${prefix}.${k}` : k);
    const exact = c.fields.find((f) => f.path === kn);
    if (exact) { out[k] = encodeCond(c, exact, v); continue; }
    const inside = c.fields.find((f) => kn.startsWith(`${f.path}.`));
    if (inside) throw new PiiQueryError(`${c.name}: cannot query "${kn}" inside the encrypted field "${inside.path}"`);
    if (c.fields.some((f) => f.path.startsWith(`${kn}.`))) {
      if (isPlain(v) && isPlain(v.$elemMatch)) { out[k] = { ...v, $elemMatch: encodeFilter(c, v.$elemMatch, kn) }; continue; }
      if (isPlain(v) && !Object.keys(v).some((x) => x.startsWith('$'))) { out[k] = encodeDoc({ ...c, search: [] }, v); continue; }
    }
    out[k] = v;
  }
  return out;
}

// ── Wrapping the collection ──────────────────────────────────────────────────

const specs = new Map<string, Compiled>();
/** The protected fields of every model, by collection name (used by the migration). */
export const protectedCollections = () => [...specs.entries()].map(([collection, c]) => ({ collection, model: c.name, fields: c.fields.map((f) => ({ path: f.path, kind: f.kind })), search: c.search }));
export const encodeDocFor = (collection: string, doc: unknown) => { const c = specs.get(collection); return c ? encodeDoc(c, doc) : doc; };

type Fn = (...a: unknown[]) => unknown;
const thenable = (x: unknown): x is Promise<unknown> => !!x && typeof (x as { then?: unknown }).then === 'function';
const after = (r: unknown, fn: (x: unknown) => unknown) => (thenable(r) ? r.then(fn) : fn(r));

export function protect(model: Model<any>, spec: PiiSpec) { // eslint-disable-line @typescript-eslint/no-explicit-any
  const coll = model.collection as unknown as Record<string, Fn>;
  const c = compile(model.modelName, spec);
  specs.set(model.collection.collectionName, c);
  const dec = (d: unknown) => decodeDoc(c, d);
  const decCursor = (cur: unknown) => { (cur as { map: (f: Fn) => unknown }).map(dec); return cur; };
  const decModify = (r: unknown) => (isPlain(r) && 'value' in r && 'ok' in r ? { ...r, value: dec(r.value) } : dec(r));
  const wrap = (name: string, fn: (orig: Fn, args: unknown[]) => unknown) => {
    const orig = (coll[name] as Fn).bind(coll);
    coll[name] = (...args: unknown[]) => fn(orig, args);
  };
  const ef = (f: unknown) => encodeFilter(c, f);

  wrap('insertOne', (o, [doc, ...r]) => o(encodeDoc(c, doc), ...r));
  wrap('insertMany', (o, [docs, ...r]) => o((docs as unknown[]).map((d) => encodeDoc(c, d)), ...r));
  for (const m of ['updateOne', 'updateMany']) wrap(m, (o, [f, u, ...r]) => o(ef(f), encodeUpdate(c, u), ...r));
  wrap('replaceOne', (o, [f, d, ...r]) => o(ef(f), encodeDoc(c, d), ...r));
  wrap('findOneAndUpdate', (o, [f, u, ...r]) => after(o(ef(f), encodeUpdate(c, u), ...r), decModify));
  wrap('findOneAndReplace', (o, [f, d, ...r]) => after(o(ef(f), encodeDoc(c, d), ...r), decModify));
  wrap('findOneAndDelete', (o, [f, ...r]) => after(o(ef(f), ...r), decModify));
  for (const m of ['deleteOne', 'deleteMany', 'countDocuments']) wrap(m, (o, [f, ...r]) => o(ef(f), ...r));
  wrap('findOne', (o, [f, ...r]) => after(o(ef(f), ...r), dec));
  wrap('find', (o, [f, ...r]) => after(o(ef(f), ...r), decCursor));
  wrap('distinct', (o, [key, f, ...r]) => {
    const field = c.fields.find((x) => x.path === key);
    return after(o(key, ef(f), ...r), (vals) => (field ? (vals as unknown[]).map(decryptAny) : vals));
  });
  wrap('aggregate', (o, [pipeline, ...r]) => after(o((pipeline as unknown[]).map((s) => (isPlain(s) && s.$match ? { ...s, $match: ef(s.$match) } : s)), ...r), decCursor));
  wrap('bulkWrite', (o, [ops, ...r]) => o((ops as Array<Record<string, Record<string, unknown>>>).map((op) => {
    const [type, b] = Object.entries(op)[0]!;
    if (type === 'insertOne') return { insertOne: { ...b, document: encodeDoc(c, b.document) } };
    if (type === 'updateOne' || type === 'updateMany') return { [type]: { ...b, filter: ef(b.filter), update: encodeUpdate(c, b.update) } };
    if (type === 'replaceOne') return { replaceOne: { ...b, filter: ef(b.filter), replacement: encodeDoc(c, b.replacement) } };
    return { [type]: { ...b, filter: ef(b.filter) } };
  }), ...r));
}