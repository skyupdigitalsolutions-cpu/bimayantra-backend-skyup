/**
 * Settings → Integrations: the advisor connects their own MSG91 (WhatsApp) and Brevo (email) accounts.
 *   GET /integrations · PUT /integrations/:provider · POST /integrations/:provider/test · DELETE /integrations/:provider
 *   GET /integrations/msg91/templates (the WhatsApp templates in the advisor's MSG91 account, for Message templates)
 * Details are checked with the provider before they are saved; a wrong key or sender is a field error, nothing saved.
 */
import type { Request } from 'express';
import { env } from '../../config/env.js';
import { clock } from '../../lib/clock.js';
import { decryptField, encryptField, lookupHash, randomToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';
import * as msg91 from '../../lib/msg91.js';
import { audit } from '../audit/audit.service.js';
import { checkBrevo, type BrevoCreds } from '../comms/brevo.js';
import { accountOf } from '../../middleware/authorize.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { Integration, type IntegrationDoc, type Provider } from './integration.model.js';

export type ProviderKey = 'msg91' | 'brevo';
export const providerOf = (k: ProviderKey): Provider => (k === 'msg91' ? 'MSG91' : 'BREVO');
const LABEL: Record<Provider, string> = { MSG91: 'MSG91', BREVO: 'Brevo' };
const path: Record<Provider, string> = { MSG91: 'msg91', BREVO: 'brevo' };

interface Msg91Config { waNumber: string; namespace: string | null }
interface BrevoConfig { fromEmail: string; fromName: string; replyTo: string | null }

/** "+91 98765 43210" | "9876543210" → "919876543210" (MSG91's form: country code, no plus). */
export const normalizeWaNumber = (v: string) => { const d = String(v ?? '').replace(/\D/g, ''); return d.length === 10 ? `91${d}` : d; };

const configOf = <T>(d: IntegrationDoc) => JSON.parse(decryptField(d.configEnc)) as T;

function view(d: IntegrationDoc) {
  const token = decryptField(d.webhookTokenEnc);
  return {
    id: d._id, provider: d.provider, status: d.status, keyLast4: d.keyLast4, config: configOf<Record<string, unknown>>(d),
    lastCheckedAt: d.lastCheckedAt, lastError: d.lastError, connectedAt: d.createdAt, updatedAt: d.updatedAt,
    webhookUrl: `${env.PUBLIC_API_URL.replace(/\/$/, '')}${env.API_PREFIX}/webhooks/${path[d.provider as Provider]}/${token}`,
  };
}

export async function list(ctx: AuthContext) {
  const rows = await Integration.find({ accountId: accountOf(ctx) }).lean<IntegrationDoc[]>();
  const by = (p: Provider) => { const r = rows.find((x) => x.provider === p); return r ? view(r) : null; };
  return { MSG91: by('MSG91'), BREVO: by('BREVO') };
}

/** The advisor's working MSG91 account, decrypted for sending; null when not connected or not ACTIVE. */
export async function ownMsg91(accountId: string): Promise<msg91.Msg91Creds | null> {
  const r = await Integration.findOne({ accountId, provider: 'MSG91', status: 'ACTIVE' }).lean<IntegrationDoc>();
  if (!r) return null;
  const c = configOf<Msg91Config>(r);
  return { authKey: decryptField(r.secretEnc), number: c.waNumber, namespace: c.namespace ?? null };
}
/** The advisor's working Brevo account, decrypted for sending; null when not connected or not ACTIVE. */
export async function ownBrevo(accountId: string): Promise<BrevoCreds | null> {
  const r = await Integration.findOne({ accountId, provider: 'BREVO', status: 'ACTIVE' }).lean<IntegrationDoc>();
  if (!r) return null;
  const c = configOf<BrevoConfig>(r);
  return { apiKey: decryptField(r.secretEnc), fromEmail: c.fromEmail, fromName: c.fromName, replyTo: c.replyTo ?? null };
}
/** Webhook: the account whose own delivery-report address this is (null = no such address). */
export async function byWebhookToken(provider: Provider, token: string) {
  if (!token || token.length < 20 || token.length > 100) return null;
  return Integration.findOne({ provider, webhookTokenHash: lookupHash(`${provider}|${token}`) }, { accountId: 1 }).lean<{ _id: string; accountId: string }>();
}

const unreachable = (p: Provider) => new AppError(503, 'PROVIDER_UNREACHABLE', 'INT-06', { provider: LABEL[p] });

/** Ask the provider whether these details work. Throws the field error to show; returns nothing when they work. */
async function verify(p: Provider, secret: string, config: Msg91Config | BrevoConfig) {
  if (p === 'MSG91') {
    const c = config as Msg91Config;
    const r = await msg91.checkOwnAccount({ authKey: secret, number: c.waNumber, namespace: c.namespace });
    if (r.ok) return;
    if (r.reason === 'KEY') throw AppError.field('authKey', 'INT-03', { provider: 'MSG91' });
    if (r.reason === 'NUMBER') throw AppError.field('waNumber', 'INT-04');
    throw unreachable(p);
  }
  const c = config as BrevoConfig;
  const r = await checkBrevo(secret, c.fromEmail);
  if (r.ok) return;
  if (r.reason === 'KEY') throw AppError.field('apiKey', 'INT-03', { provider: 'Brevo' });
  if (r.reason === 'SENDER') throw AppError.field('fromEmail', 'INT-05');
  throw unreachable(p);
}

export interface ConnectBody { authKey?: string; waNumber?: string; namespace?: string | null; apiKey?: string; fromEmail?: string; fromName?: string; replyTo?: string | null }

/** Connect or change: checked with the provider first; the key may be left blank to keep the saved one. */
export async function connect(ctx: AuthContext, key: ProviderKey, b: ConnectBody, req: Request) {
  const accountId = accountOf(ctx);
  const p = providerOf(key);
  const existing = await Integration.findOne({ accountId, provider: p }).lean<IntegrationDoc>();
  const secretField = p === 'MSG91' ? 'authKey' : 'apiKey';
  const typed = String((p === 'MSG91' ? b.authKey : b.apiKey) ?? '').trim();
  const secret = typed || (existing ? decryptField(existing.secretEnc) : '');
  if (!secret) throw AppError.field(secretField, 'GEN-01', { 'Field label': p === 'MSG91' ? 'MSG91 auth key' : 'Brevo API key' });
  let config: Msg91Config | BrevoConfig;
  if (p === 'MSG91') {
    const waNumber = normalizeWaNumber(b.waNumber ?? '');
    if (!/^[1-9]\d{10,14}$/.test(waNumber)) throw AppError.field('waNumber', 'INT-08');
    config = { waNumber, namespace: String(b.namespace ?? '').trim() || null };
  } else {
    config = { fromEmail: String(b.fromEmail ?? '').trim().toLowerCase(), fromName: String(b.fromName ?? '').trim(), replyTo: String(b.replyTo ?? '').trim().toLowerCase() || null };
  }
  await verify(p, secret, config);
  const now = clock.now();
  const token = existing ? decryptField(existing.webhookTokenEnc) : randomToken(24);
  const saved = await Integration.findOneAndUpdate(
    { accountId, provider: p },
    {
      $set: { status: 'ACTIVE', secretEnc: encryptField(secret), keyLast4: secret.slice(-4), configEnc: encryptField(JSON.stringify(config)), lastCheckedAt: now, lastError: null, connectedBy: ctx.userId },
      $setOnInsert: { webhookTokenHash: lookupHash(`${p}|${token}`), webhookTokenEnc: encryptField(token) },
    },
    { upsert: true, new: true },
  ).lean<IntegrationDoc>();
  await audit({ entity: 'integration', entityId: saved!._id, action: existing ? 'INTEGRATION_CHANGED' : 'INTEGRATION_CONNECTED', after: { provider: p, keyLast4: saved!.keyLast4 } }, { req });
  return { conn: view(saved!), messageId: 'INT-01' as const, params: { provider: LABEL[p] } };
}

/** Test the saved details again. A failure marks the connection ERROR (its messages go through Bimayantra meanwhile). */
export async function test(ctx: AuthContext, key: ProviderKey, req: Request) {
  const accountId = accountOf(ctx);
  const p = providerOf(key);
  const d = await Integration.findOne({ accountId, provider: p }).lean<IntegrationDoc>();
  if (!d) throw new AppError(404, 'NOT_FOUND', 'INT-09', { provider: LABEL[p] });
  const now = clock.now();
  try {
    await verify(p, decryptField(d.secretEnc), configOf<Msg91Config | BrevoConfig>(d));
  } catch (e) {
    if (e instanceof AppError && e.messageId !== 'INT-06') {
      await Integration.updateOne({ _id: d._id }, { $set: { status: 'ERROR', lastError: e.message, lastCheckedAt: now } });
      await audit({ entity: 'integration', entityId: d._id, action: 'INTEGRATION_TEST_FAILED', after: { provider: p, reason: e.message } }, { req });
    }
    throw e;
  }
  const u = await Integration.findOneAndUpdate({ _id: d._id }, { $set: { status: 'ACTIVE', lastError: null, lastCheckedAt: now } }, { new: true }).lean<IntegrationDoc>();
  return { conn: view(u!), messageId: 'INT-07' as const, params: { provider: LABEL[p] } };
}

export async function disconnect(ctx: AuthContext, key: ProviderKey, req: Request) {
  const accountId = accountOf(ctx);
  const p = providerOf(key);
  const d = await Integration.findOneAndDelete({ accountId, provider: p }).lean<IntegrationDoc>();
  if (!d) throw new AppError(404, 'NOT_FOUND', 'INT-09', { provider: LABEL[p] });
  await audit({ entity: 'integration', entityId: d._id, action: 'INTEGRATION_DISCONNECTED', after: { provider: p } }, { req });
  return { provider: p, messageId: 'INT-02' as const, params: { provider: LABEL[p] } };
}

/** The WhatsApp templates in the advisor's own MSG91 account (live), for choosing one per trigger. */
export async function ownTemplates(ctx: AuthContext) {
  const creds = await ownMsg91(accountOf(ctx));
  if (!creds) throw new AppError(409, 'NOT_CONNECTED', 'MR-02');
  try {
    return await msg91.listOwnTemplates(creds);
  } catch (e) {
    if (e instanceof msg91.Msg91Temporary) throw unreachable('MSG91');
    throw new AppError(502, 'PROVIDER_REFUSED', 'INT-06', { provider: 'MSG91' }, { reason: (e as Error).message });
  }
}