/**
 * Stage H (change #1 items 9–13): campaign list and detail, leads per campaign, and platform status and spend.
 * Meta and Google leads are grouped by platform campaign; website and LinkedIn leads by form. Spend and cost per lead
 * are for the advisor only (assistants see leads, not money: Q81).
 */
import { clock, istToday } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { decryptField } from '../../lib/crypto.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { can } from '../rbac/capabilities.js';
import { AdCampaign, AdCreative, Connection, LeadForm, Submission, type AdCampaignDoc, type ConnectionDoc, type FormDoc, type SubmissionDoc } from './campaign.model.js';
import { google, googleStatus, metaCampaigns, metaStatus } from './platforms.js';

const LEAD_STATES = ['IMPORTED', 'LINKED'];
const dayStartIst = (iso = istToday()) => new Date(`${iso}T00:00:00+05:30`);

/** Link a stored submission to its platform campaign and ad (created on first sight). Called inside the import. */
export async function linkCampaign(s: SubmissionDoc) {
  if (s.adCampaignId || !['META', 'GOOGLE'].includes(s.channel)) return;
  const m = (s.meta ?? {}) as { campaignId?: string | number | null; campaignName?: string | null; adId?: string | number | null; creativeId?: string | number | null; adName?: string | null; adSetName?: string | null };
  if (!m.campaignId) return;
  const ext = String(m.campaignId);
  let camp = await AdCampaign.findOne({ connectionId: s.connectionId, externalCampaignId: ext }).lean<AdCampaignDoc>();
  if (!camp) {
    try { camp = (await AdCampaign.create({ accountId: s.accountId, connectionId: s.connectionId, channel: s.channel, externalCampaignId: ext, name: m.campaignName ?? null })).toObject() as AdCampaignDoc; }
    catch (e) { if (!isDuplicateKey(e)) throw e; camp = (await AdCampaign.findOne({ connectionId: s.connectionId, externalCampaignId: ext }).lean<AdCampaignDoc>())!; }
  } else if (!camp.name && m.campaignName) await AdCampaign.updateOne({ _id: camp._id }, { $set: { name: m.campaignName } });
  let creativeId: string | null = null;
  const adExt = m.adId ?? m.creativeId;
  if (adExt) {
    const set = { ...(m.adName ? { name: m.adName } : {}), ...(m.adSetName ? { adSetName: m.adSetName } : {}) };
    const ad = await AdCreative.findOneAndUpdate({ campaignId: camp._id, externalAdId: String(adExt) }, { $setOnInsert: { accountId: s.accountId }, ...(Object.keys(set).length ? { $set: set } : {}) }, { upsert: true, new: true }).lean<{ _id: string }>();
    creativeId = ad!._id;
  }
  await Submission.updateOne({ _id: s._id }, { $set: { adCampaignId: camp._id, adCreativeId: creativeId } });
}

type Row = { id: string; kind: 'CAMPAIGN' | 'FORM'; channel: string; name: string; status: string; statusReason: string | null; connectionId: string; leads: number; newToday: number; converted: number; lastLeadAt: Date | null; spend?: number | null; currency?: string | null; costPerLead?: number | null; spendSyncedAt?: Date | null; startedOn?: string | null };

async function counts(accountId: string, match: Record<string, unknown>) {
  const subs = await Submission.find({ accountId, status: { $in: LEAD_STATES }, ...match }, { leadId: 1, createdAt: 1 }).lean<Array<{ leadId: string | null; createdAt: Date }>>();
  const start = dayStartIst();
  const leadIds = [...new Set(subs.map((x) => x.leadId).filter(Boolean))] as string[];
  const converted = leadIds.length ? await Lead.countDocuments({ _id: { $in: leadIds }, status: 'CONVERTED' }) : 0;
  return { leads: subs.length, newToday: subs.filter((x) => x.createdAt >= start).length, converted, lastLeadAt: subs.length ? new Date(Math.max(...subs.map((x) => x.createdAt.getTime()))) : null };
}
const connStatus = (c: ConnectionDoc | undefined) => (c && c.status === 'CONNECTED' ? null : 'NOT_SYNCING');

async function campaignRow(ctx: AuthContext, c: AdCampaignDoc, conn: ConnectionDoc | undefined): Promise<Row> {
  const k = await counts(c.accountId, { adCampaignId: c._id });
  const row: Row = { id: c._id, kind: 'CAMPAIGN', channel: c.channel, name: c.name ?? `Campaign ${c.externalCampaignId}`, status: connStatus(conn) ?? c.platformStatus ?? 'NOT_SYNCED_YET', statusReason: connStatus(conn) ? (conn?.status === 'RECONNECT_NEEDED' ? 'Sign in again to sync' : 'Disconnected') : (c.statusReason ?? null), connectionId: c.connectionId, ...k, startedOn: c.startedOn ?? null };
  if (can(ctx.role, 'campaigns.spend')) Object.assign(row, { spend: c.spendAmount ?? null, currency: c.spendCurrency ?? null, costPerLead: c.spendAmount !== null && c.spendAmount !== undefined && k.leads ? Math.round((c.spendAmount / k.leads) * 100) / 100 : null, spendSyncedAt: c.spendSyncedAt ?? null });
  return row;
}
async function formRow(f: FormDoc, conn: ConnectionDoc | undefined): Promise<Row> {
  const k = await counts(f.accountId, { formId: f._id });
  return { id: f._id, kind: 'FORM', channel: f.channel, name: f.campaignName ?? f.name, status: connStatus(conn) ?? (f.active ? 'ACTIVE' : 'TURNED_OFF'), statusReason: null, connectionId: f.connectionId, ...k };
}

/** GET /campaigns: one row per platform campaign (Meta, Google) or form (website, LinkedIn); filter by channel and status. */
export async function list(ctx: AuthContext, q: { channel?: string; status?: string }) {
  const conns = new Map((await Connection.find({ accountId: ctx.accountId }).lean<ConnectionDoc[]>()).map((c) => [c._id, c]));
  const camps = await AdCampaign.find({ accountId: ctx.accountId, ...(q.channel ? { channel: q.channel } : {}) }).lean<AdCampaignDoc[]>();
  const forms = await LeadForm.find({ accountId: ctx.accountId, channel: { $in: ['WEBSITE', 'LINKEDIN'] }, ...(q.channel ? { channel: q.channel } : {}) }).lean<FormDoc[]>();
  const rows = [...await Promise.all(camps.map((c) => campaignRow(ctx, c, conns.get(c.connectionId)))), ...await Promise.all(forms.map((f) => formRow(f, conns.get(f.connectionId))))];
  return rows.filter((r) => !q.status || r.status === q.status).sort((a, b) => (b.lastLeadAt?.getTime() ?? 0) - (a.lastLeadAt?.getTime() ?? 0) || a.name.localeCompare(b.name));
}
async function load(ctx: AuthContext, id: string) {
  if (id.startsWith('adc_')) { const c = await AdCampaign.findOne({ _id: id, accountId: ctx.accountId }).lean<AdCampaignDoc>(); if (c) return { c, f: null }; }
  if (id.startsWith('lfm_')) { const f = await LeadForm.findOne({ _id: id, accountId: ctx.accountId }).lean<FormDoc>(); if (f) return { c: null, f }; }
  throw AppError.notFound();
}
/** GET /campaigns/:id: the row's KPIs, leads per day for 14 days (IST), and leads per ad. */
export async function detail(ctx: AuthContext, id: string) {
  const { c, f } = await load(ctx, id);
  const conn = await Connection.findById(c?.connectionId ?? f!.connectionId).lean<ConnectionDoc>() ?? undefined;
  const row = c ? await campaignRow(ctx, c, conn) : await formRow(f!, conn);
  const match = c ? { adCampaignId: c._id } : { formId: f!._id };
  const from = new Date(dayStartIst().getTime() - 13 * 86_400_000);
  const subs = await Submission.find({ accountId: ctx.accountId, status: { $in: LEAD_STATES }, ...match, createdAt: { $gte: from } }, { createdAt: 1, adCreativeId: 1 }).lean<Array<{ createdAt: Date; adCreativeId: string | null }>>();
  const perDay = Array.from({ length: 14 }, (_, i) => { const d = new Date(from.getTime() + i * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10); return { date: d, leads: 0 }; });
  for (const s of subs) { const d = new Date(s.createdAt.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10); const x = perDay.find((p) => p.date === d); if (x) x.leads++; }
  let byAd: Array<{ adId: string; name: string | null; adSetName: string | null; leads: number }> = [];
  if (c) {
    const all = await Submission.aggregate<{ _id: string | null; n: number }>([{ $match: { accountId: ctx.accountId, status: { $in: LEAD_STATES }, adCampaignId: c._id } }, { $group: { _id: '$adCreativeId', n: { $sum: 1 } } }]);
    const ads = new Map((await AdCreative.find({ campaignId: c._id }).lean<Array<{ _id: string; externalAdId: string; name: string | null; adSetName: string | null }>>()).map((a) => [a._id, a]));
    byAd = all.filter((x) => x._id).map((x) => { const a = ads.get(x._id!); return { adId: a?.externalAdId ?? x._id!, name: a?.name ?? null, adSetName: a?.adSetName ?? null, leads: x.n }; }).sort((a, b) => b.leads - a.leads);
  }
  return { ...row, conversionRate: row.leads ? Math.round((row.converted * 1000) / row.leads) / 10 : 0, leadsPerDay: perDay, leadsByAd: byAd };
}
/** GET /campaigns/:id/leads: the campaign's or form's leads with their current status, newest first. */
export async function leads(ctx: AuthContext, id: string) {
  const { c, f } = await load(ctx, id);
  const subs = await Submission.find({ accountId: ctx.accountId, status: { $in: LEAD_STATES }, ...(c ? { adCampaignId: c._id } : { formId: f!._id }) }, { leadId: 1, createdAt: 1, status: 1 }).sort({ createdAt: -1 }).limit(300).lean<Array<{ _id: string; leadId: string | null; createdAt: Date; status: string }>>();
  const ls = new Map((await Lead.find({ _id: { $in: subs.map((s) => s.leadId).filter(Boolean) } }, { name: 1, mobile: 1, status: 1, number: 1 }).lean<Array<{ _id: string; name: string; mobile: string; status: string; number: string }>>()).map((l) => [l._id, l]));
  return subs.filter((s) => s.leadId && ls.has(s.leadId)).map((s) => { const l = ls.get(s.leadId!)!; return { submissionId: s._id, leadId: l._id, number: l.number, name: l.name, mobile: l.mobile, leadStatus: l.status, linkedToExisting: s.status === 'LINKED', at: s.createdAt }; });
}

/**
 * Status and spend for one connection (from the 15-minute job and Sync now). Meta: the campaigns its leads came from,
 * read with the signed-in person's token. Google: every campaign in the chosen ad accounts (needs the Google sign-in).
 * Token errors are raised (the caller sets Reconnect needed); other errors are stored on the campaign.
 */
export async function syncCampaigns(conn: ConnectionDoc) {
  const now = clock.now();
  let updated = 0;
  if (conn.channel === 'META' && conn.tokenEnc) {
    const token = decryptField(conn.tokenEnc);
    for (const c of await AdCampaign.find({ connectionId: conn._id }).lean<AdCampaignDoc[]>()) {
      const r = await metaCampaigns.get(c.externalCampaignId, token);
      const st = metaStatus(r);
      const ins = (r.insights?.data ?? [])[0] as { spend?: string; account_currency?: string } | undefined;
      await AdCampaign.updateOne({ _id: c._id }, { $set: { name: r.name ?? c.name, platformStatus: st.status, statusReason: st.reason, startedOn: r.start_time ? String(r.start_time).slice(0, 10) : c.startedOn,
        spendAmount: ins?.spend !== undefined ? Number(ins.spend) : 0, spendCurrency: ins?.account_currency ?? c.spendCurrency ?? null, spendSyncedAt: now, lastSyncedAt: now, lastSyncError: null } });
      updated++;
    }
  } else if (conn.channel === 'GOOGLE' && conn.tokenEnc) {
    const access = await google.access(decryptField(conn.tokenEnc));
    for (const src of conn.sources.filter((x) => x.subscribed)) {
      for (const g of await google.campaigns(src.id, access)) {
        const st = googleStatus(g);
        await AdCampaign.updateOne({ connectionId: conn._id, externalCampaignId: g.id }, { $set: { name: g.name, platformStatus: st.status, statusReason: st.reason, startedOn: g.startDate, spendAmount: g.spend, spendCurrency: g.currency, spendSyncedAt: now, lastSyncedAt: now, lastSyncError: null }, $setOnInsert: { accountId: conn.accountId, channel: 'GOOGLE' } }, { upsert: true });
        updated++;
      }
    }
  }
  return updated;
}