import type { Request } from 'express';
import type { ClientSession } from 'mongoose';
import { cfg, cfgList, cfgNum } from '../../config/cfg.js';
import { ageOn, clock, istDate as showDate, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { msg, type MessageId } from '../../lib/messages.js';
import { withTx } from '../../lib/mongo.js';
import { Account, type AccountDoc } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { notify } from '../notifications/notifications.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { User } from '../users/user.model.js';
import { assertOwnFile } from '../files/files.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import { InsurerMapping } from '../insurers/mapping.model.js';

export const SECTIONS = ['personal', 'contact', 'professional', 'business'] as const;
export type Section = (typeof SECTIONS)[number];
export const ADVISOR_TYPES = ['Individual agent', 'POSP', 'Corporate agent staff', 'Broker staff'] as const;
/**
 * B-09: one gender format everywhere (the customer codes). Earlier versions stored the advisor's gender as
 * "Male" / "Prefer not to say"; those are still accepted on input and shown as the code.
 */
export const ADVISOR_GENDERS = ['MALE', 'FEMALE', 'TRANSGENDER', 'PREFER_NOT_TO_SAY'] as const;
const LEGACY_GENDER: Record<string, (typeof ADVISOR_GENDERS)[number]> = { male: 'MALE', female: 'FEMALE', transgender: 'TRANSGENDER', 'prefer not to say': 'PREFER_NOT_TO_SAY' };
export const normalizeGender = (v: unknown): (typeof ADVISOR_GENDERS)[number] | null => {
  if (typeof v !== 'string') return null;
  if ((ADVISOR_GENDERS as readonly string[]).includes(v)) return v as (typeof ADVISOR_GENDERS)[number];
  return LEGACY_GENDER[v.trim().toLowerCase()] ?? null;
};

type Profile = NonNullable<AccountDoc['profile']>;
type Weights = Record<'Personal' | 'Contact' | 'Professional' | 'Business' | 'KYC' | 'Insurers', number>;

/**
 * P-05 completion. A section counts its full CFG-124 weight when every "required for completion" item in
 * it is saved; the % is computed only on the server, from saved values and the current weights.
 *
 * DECISION (OPEN-QUESTIONS): Business has a weight but no required item. It counts once the advisor has
 * saved it, so a brand-new advisor starts at 0% rather than at Business's 10%.
 * KYC counts when KYC is submitted (PENDING_REVIEW) or VERIFIED; Insurers when at least one ACTIVE
 * insurer mapping exists. Both arrive with P-06 and P-07; until then they are simply missing.
 */
export function completion(p: Profile, fullName: string, activeInsurers: number) {
  const w = cfg('CFG-124') as Weights;
  const has = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && v !== '');
  const groups: Array<{ section: keyof Weights; missing: string[] }> = [
    { section: 'Personal', missing: [!has(fullName) && 'Full name', !has(p.personal?.dob) && 'Date of birth'].filter(Boolean) as string[] },
    { section: 'Contact', missing: ([['email', 'Email'], ['address1', 'Address line 1'], ['city', 'City'], ['state', 'State'], ['pin', 'PIN code']] as const)
      .filter(([k]) => !has(p.contact?.[k])).map(([, label]) => label) },
    { section: 'Professional', missing: ([['advisorType', 'Advisor type'], ['licenceNumber', 'IRDAI licence or POSP certificate number'], ['licenceValidUntil', 'Licence valid until'], ['categories', 'Authorised insurance categories']] as const)
      .filter(([k]) => !has(p.professional?.[k])).map(([, label]) => label) },
    { section: 'Business', missing: p.business?.savedAt ? [] : ['Business details'] },
    { section: 'KYC', missing: ['PENDING_REVIEW', 'VERIFIED'].includes(String(p.kycStatus)) ? [] : ['KYC (PAN and documents)'] },
    { section: 'Insurers', missing: activeInsurers > 0 ? [] : ['At least one insurer'] },
  ];
  const percent = groups.reduce((sum, g) => sum + (g.missing.length ? 0 : w[g.section] ?? 0), 0);
  return { percent, missing: groups.filter((g) => g.missing.length) };
}

/**
 * Licence state for "what needs which profile items" (P-05): new quotations need a licence valid until
 * today or later (PRF-17 after expiry, PRF-16 warning from CFG-152 days before). Used by P-27/P-28 later.
 */
export function licenceState(p: Profile, today = istToday()) {
  const until = p.professional?.licenceValidUntil ?? null;
  if (!until || !p.professional?.licenceNumber) return { state: 'MISSING' as const, until, messageId: null, message: null };
  if (until < today) return { state: 'EXPIRED' as const, until, messageId: 'PRF-17' as MessageId, message: msg('PRF-17', { date: showDate(until) }) };
  const warnFrom = new Date(`${until}T00:00:00Z`);
  warnFrom.setUTCDate(warnFrom.getUTCDate() - cfgNum('CFG-152'));
  if (today >= warnFrom.toISOString().slice(0, 10)) return { state: 'EXPIRING' as const, until, messageId: 'PRF-16' as MessageId, message: msg('PRF-16', { date: showDate(until) }) };
  return { state: 'VALID' as const, until, messageId: null, message: null };
}

/** P-05 "Insurers": ACTIVE mappings whose insurer is still ACTIVE in the catalogue (P-07). */
async function activeInsurerCount(accountId: string): Promise<number> {
  const ids = await InsurerMapping.distinct('insurerId', { accountId, status: 'ACTIVE' });
  return ids.length ? Insurer.countDocuments({ _id: { $in: ids }, status: 'ACTIVE' }) : 0;
}

/** Recompute the % for an account after a change made outside the profile screens (KYC, insurers). */
export async function refreshCompletionFor(accountId: string, session: ClientSession | null) {
  const [acc, adv] = await Promise.all([
    Account.findById(accountId).session(session).lean<AccountDoc>(),
    User.findOne({ accountId, role: 'ADV' }, { _id: 1, name: 1 }).session(session).lean<{ _id: string; name: string }>(),
  ]);
  if (acc && adv) await refreshCompletion(accountId, adv._id, acc, adv.name, session);
}

function view(acc: AccountDoc, user: { name: string; mobile: string }, activeInsurers: number, categories: string[] = cfgList('CFG-115')) {
  const p = acc.profile!;
  const c = completion(p, user.name, activeInsurers);
  const missingText = c.missing.flatMap((g) => g.missing).join(', ');
  return {
    sections: {
      personal: { fullName: user.name, dob: p.personal?.dob ?? null, gender: normalizeGender(p.personal?.gender), photoFileId: p.personal?.photoFileId ?? null, savedAt: p.personal?.savedAt ?? null, version: p.sectionVersions?.personal ?? 1 },
      contact: { ...pick(p.contact, ['email', 'altMobile', 'address1', 'address2', 'city', 'state', 'pin', 'savedAt']), loginMobile: user.mobile, version: p.sectionVersions?.contact ?? 1 },
      professional: { ...pick(p.professional, ['advisorType', 'licenceNumber', 'licenceValidUntil', 'experienceYears', 'savedAt']), categories: p.professional?.categories ?? [], version: p.sectionVersions?.professional ?? 1 },
      business: { displayName: p.business?.displayName ?? null, effectiveDisplayName: p.business?.displayName || user.name, gstin: p.business?.gstin ?? null, logoFileId: p.business?.logoFileId ?? null, savedAt: p.business?.savedAt ?? null, version: p.sectionVersions?.business ?? 1 },
    },
    kycStatus: p.kycStatus,
    completion: {
      percent: c.percent,
      missing: c.missing, // grouped by section (P-05 step 1)
      ...(c.percent < 100 ? { messageId: 'PRF-02', message: msg('PRF-02', { percent: c.percent, 'missing items': missingText }) } : {}),
    },
    licence: licenceState(p),
    options: { advisorTypes: ADVISOR_TYPES, genders: ADVISOR_GENDERS, categories },
  };
}

function pick(o: Record<string, unknown> | null | undefined, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown> | undefined)?.[k] ?? null]));
}

/**
 * Recompute and store the % after any change that affects it (profile sections, KYC, insurers), and
 * create a bell notification only when a NEW CFG-129 milestone is reached (P-05 step 4).
 */
export async function refreshCompletion(accountId: string, userId: string, acc: AccountDoc, name: string, session: ClientSession | null) {
  const c = completion(acc.profile!, name, await activeInsurerCount(accountId));
  const reached = (cfg('CFG-129') as number[]).filter((m) => c.percent >= m && m > (acc.profile?.milestoneNotified ?? 0));
  const milestone = reached.length ? Math.max(...reached) : null;
  await Account.updateOne({ _id: accountId }, { $set: { 'profile.completionPct': c.percent, ...(milestone ? { 'profile.milestoneNotified': milestone } : {}) } }, { session: session ?? undefined });
  if (milestone) {
    // P-10: DSH-10 once per milestone (the dedupe key), linked to the profile.
    await notify({
      userId, accountId, kind: 'PROFILE_MILESTONE', messageId: 'DSH-10', params: { percent: c.percent },
      dedupeKey: `DSH-10|${accountId}|${milestone}`, link: { type: 'PROFILE', id: accountId },
    }, session);
  }
  return c.percent;
}

/**
 * Accounts registered before Module 5 have no section versions stored. Every versioned write is
 * conditional on the stored version, so without this such accounts could never save (always GEN-05).
 * Fills only MISSING versions with 1 (what the screen already shows); existing values are untouched.
 */
export async function ensureSectionVersions(accountId: string) {
  const v = (k: string) => ({ $ifNull: [`$profile.sectionVersions.${k}`, 1] });
  await Account.updateOne({ _id: accountId }, [{
    $set: {
      'profile.sectionVersions.personal': v('personal'), 'profile.sectionVersions.contact': v('contact'),
      'profile.sectionVersions.professional': v('professional'), 'profile.sectionVersions.business': v('business'),
      'profile.sectionVersions.kyc': v('kyc'),
    },
  }]);
}

async function load(ctx: AuthContext) {
  if (ctx.accountId) await ensureSectionVersions(ctx.accountId);
  const [acc, user] = await Promise.all([
    Account.findById(ctx.accountId).lean<AccountDoc>(),
    User.findById(ctx.userId, { name: 1, mobile: 1 }).lean<{ name: string; mobile: string }>(),
  ]);
  if (!acc || !user) throw AppError.notFound();
  return { acc, user };
}

export async function getProfile(ctx: AuthContext) {
  const { acc, user } = await load(ctx);
  return view(acc, user, await activeInsurerCount(acc._id), await categoryChoices());
}

/**
 * Save ONE section (P-05 step 3). Only that section is validated and written; the write is conditional on
 * the section's version, so a second tab saving the same section gets GEN-05 and nothing is overwritten.
 */
/** Categories an advisor may authorise: the starting types (CFG-115) and every ACTIVE insurance type in the catalogue. */
export async function categoryChoices() {
  const { InsuranceType } = await import('../catalogue/types.model.js');
  const active = (await InsuranceType.find({ status: 'ACTIVE', ownerAccountId: null }, { name: 1 }).sort({ name: 1 }).lean<Array<{ name: string }>>()).map((t) => t.name);
  return [...new Set([...cfgList('CFG-115'), ...active])];
}

export async function saveSection(ctx: AuthContext, section: Section, body: Record<string, unknown>, req: Request) {
  if (section === 'professional' && Array.isArray(body.categories)) {
    const allowed = new Set(await categoryChoices());
    if ((body.categories as string[]).some((c) => !allowed.has(c))) throw AppError.field('categories', 'VAL-22');
  }
  const { acc, user } = await load(ctx);
  const version = body.version as number;
  const current = acc.profile?.sectionVersions?.[section] ?? 1;
  if (version !== current) throw AppError.versionConflict('profile section', view(acc, user, await activeInsurerCount(acc._id), await categoryChoices()));

  // Cross-field rules
  if (section === 'personal' && typeof body.dob === 'string' && ageOn(body.dob) < cfgNum('CFG-128')) {
    throw AppError.field('dob', 'PRF-14');
  }
  if (section === 'contact' && body.altMobile && body.altMobile === user.mobile) {
    throw AppError.field('altMobile', 'AUTH-24'); // FLD-01: not the same as the login mobile
  }
  if (section === 'personal' && body.fullName === null) throw AppError.field('fullName', 'GEN-01', { 'Field label': 'Full name' });
  if (typeof body.photoFileId === 'string') await assertOwnFile(ctx, body.photoFileId, 'PROFILE_PHOTO', 'photoFileId');
  if (typeof body.logoFileId === 'string') await assertOwnFile(ctx, body.logoFileId, 'BUSINESS_LOGO', 'logoFileId');

  const now = clock.now();
  const set: Record<string, unknown> = { [`profile.${section}.savedAt`]: now };
  const changed: string[] = [];
  for (const [k, v] of Object.entries(body)) {
    if (k === 'version' || k === 'fullName' || v === undefined) continue;
    set[`profile.${section}.${k}`] = v;
    changed.push(k);
  }

  const before = completion(acc.profile!, user.name, await activeInsurerCount(acc._id)).percent;
  const result = await withTx(async (session: ClientSession | null) => {
    const updated = await Account.findOneAndUpdate(
      { _id: acc._id, [`profile.sectionVersions.${section}`]: current },
      { $set: set, $inc: { [`profile.sectionVersions.${section}`]: 1 } },
      { new: true, session },
    ).lean<AccountDoc>();
    if (!updated) throw AppError.versionConflict('profile section', null);

    let name = user.name;
    if (section === 'personal' && typeof body.fullName === 'string' && body.fullName !== user.name) {
      await User.updateOne({ _id: ctx.userId }, { $set: { name: body.fullName }, $inc: { version: 1 } }, { session: session ?? undefined });
      name = body.fullName;
      changed.push('fullName');
    }

    const pct = await refreshCompletion(acc._id, ctx.userId, updated, name, session);
    // Audit records which fields changed, not their values (personal data, GR-31).
    await audit({ entity: 'profile', entityId: acc._id, action: 'PROFILE_SECTION_SAVED', before: { percent: before }, after: { section, fields: changed, percent: pct } }, { req, session });
    return { updated, name, pct };
  });

  return { profile: view(result.updated, { name: result.name, mobile: user.mobile }, await activeInsurerCount(acc._id), await categoryChoices()), percent: result.pct };
}