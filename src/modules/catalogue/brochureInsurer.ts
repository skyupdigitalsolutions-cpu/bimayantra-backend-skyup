/**
 * Which insurer a brochure is from (client requirement, Nov 2026): a brochure from another company than the one chosen
 * in + Product step 2 is refused (OCR-10) and the advisor is asked to pick the right company.
 *
 * Evidence, strongest first, for every insurer the advisor can choose (SkyUp's library and the account's own):
 *  - UIN prefix (5): an IRDAI product UIN starts with the insurer's code (HDFHLIP… is HDFC ERGO). The code of each
 *    insurer is learnt from the UINs of its products already in the catalogue.
 *  - website (4): the insurer's web address appears in the brochure.
 *  - name (3): the first two words of the insurer's name ("HDFC ERGO", "Star Health", "Care Health").
 * The chosen company passes when it has ANY evidence. It is refused only when it has none and another insurer has
 * clear evidence (CLEAR_SCORE); a brochure that names nobody is read as before.
 *
 * PROVISIONAL (OPEN-QUESTIONS Q148): signals and threshold.
 */
import { Insurer } from '../insurers/insurer.model.js';
import { Product, ProductVersion } from './product.model.js';

export const CLEAR_SCORE = 4;
type Ins = { _id: string; name: string; website?: string | null; ownerAccountId?: string | null };

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
/** "HDFC ERGO General Insurance Co. Ltd." → "hdfc ergo"; one-word names keep their one word. */
export const nameKey = (name: string) => norm(name).split(' ').slice(0, 2).join(' ');
const domainOf = (site?: string | null) => (site ? site.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0]! : null);
const UIN = /\b([A-Z]{3})[A-Z]{2,4}\d{2,6}[A-Z]?\d{0,6}\b/g; // e.g. HDFHLIP21467V022021, 101N189V03 has no letters: skipped

/** UIN prefix → insurer ids, learnt from the products already in the catalogue. */
async function prefixMap(): Promise<Map<string, Set<string>>> {
  const prods = await Product.find({ publishedVersionId: { $ne: null } }, { insurerId: 1, publishedVersionId: 1 }).lean<Array<{ insurerId: string; publishedVersionId: string }>>();
  const vs = await ProductVersion.find({ _id: { $in: prods.map((p) => p.publishedVersionId) } }, { 'data.uin': 1 }).lean<Array<{ _id: string; data?: { uin?: string } }>>();
  const uinOf = new Map(vs.map((v) => [v._id, v.data?.uin ?? '']));
  const map = new Map<string, Set<string>>();
  for (const p of prods) {
    const u = (uinOf.get(p.publishedVersionId) ?? '').toUpperCase();
    if (!/^[A-Z]{3}/.test(u)) continue;
    const k = u.slice(0, 3);
    if (!map.has(k)) map.set(k, new Set());
    map.get(k)!.add(p.insurerId);
  }
  return map;
}

export interface CompanyCheck { chosen: { id: string; name: string }; detected: { id: string; name: string; score: number } | null; mismatch: boolean }

/** Compare the brochure text with the chosen insurer. Never throws for a missing insurer: no evidence, no refusal. */
export async function checkCompany(text: string, chosenId: string, accountId: string | null): Promise<CompanyCheck | null> {
  const chosen = await Insurer.findById(chosenId, { name: 1, website: 1 }).lean<Ins>();
  if (!chosen) return null;
  const pool = await Insurer.find({ status: 'ACTIVE', ownerAccountId: { $in: [null, ...(accountId ? [accountId] : [])] } }, { name: 1, website: 1, ownerAccountId: 1 }).lean<Ins[]>();
  if (!pool.some((i) => i._id === chosen._id)) pool.push(chosen);
  const t = ` ${norm(text)} `;
  const raw = text.toLowerCase();
  const prefixes = await prefixMap();
  const uinPrefixes = new Set([...text.toUpperCase().matchAll(UIN)].map((m) => m[1]!));
  const score = (i: Ins) => {
    let s = 0;
    for (const p of uinPrefixes) if (prefixes.get(p)?.has(i._id)) { s += 5; break; }
    const d = domainOf(i.website);
    if (d && raw.includes(d)) s += 4;
    const k = nameKey(i.name);
    if (k.length >= 4 && t.includes(` ${k} `)) s += 3;
    return s;
  };
  // insurers that share the chosen one's name key (a private copy of a library insurer) count as the chosen one
  const sameAsChosen = (i: Ins) => i._id === chosen._id || nameKey(i.name) === nameKey(chosen.name);
  const chosenScore = Math.max(...pool.filter(sameAsChosen).map(score));
  const others = pool.filter((i) => !sameAsChosen(i)).map((i) => ({ id: i._id, name: i.name, score: score(i) })).sort((a, b) => b.score - a.score);
  const best = others[0] && others[0].score > 0 ? others[0] : null;
  return { chosen: { id: chosen._id, name: chosen.name }, detected: best, mismatch: chosenScore === 0 && !!best && best.score >= CLEAR_SCORE };
}