/**
 * Brevo transactional email (EMAIL_PROVIDER=brevo). Same calls as the dev provider: send() returns Brevo's message id,
 * which the delivery webhook (POST /v1/webhooks/brevo/:token) matches back to the outbox row.
 *   4xx (except 429) → PermanentFailure (bad address or content: no retry); 429 / 5xx / network → TemporaryFailure (retried).
 */
import { env } from '../../config/env.js';

export class BrevoTemporary extends Error {}
export class BrevoPermanent extends Error {}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
/** Plain text → simple HTML (paragraphs, line breaks, clickable links), so mail clients show it well. */
export function toHtml(text: string) {
  // a link ends before trailing punctuation ("…/q/x." keeps the full stop outside the link)
  const linked = esc(text).replace(/(https?:\/\/[^\s<]*[^\s<.,;:!?)])/g, '<a href="$1">$1</a>');
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.55;color:#1d2b42">${linked.split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
}

/** An advisor's own Brevo account (Settings → Integrations). Without it, SkyUp's account from the environment is used. */
export interface BrevoCreds { apiKey: string; fromEmail: string; fromName: string; replyTo?: string | null }

export async function sendEmail(to: string, subject: string | null, text: string, creds?: BrevoCreds | null): Promise<{ id: string }> {
  const fromName = creds?.fromName ?? env.EMAIL_FROM_NAME;
  const replyTo = creds ? creds.replyTo : env.EMAIL_REPLY_TO;
  let res: Response;
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': creds?.apiKey ?? env.BREVO_API_KEY ?? '', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: creds?.fromEmail ?? env.EMAIL_FROM_ADDRESS, name: fromName },
        ...(replyTo ? { replyTo: { email: replyTo } } : {}),
        to: [{ email: to }],
        subject: subject ?? fromName,
        textContent: text,
        htmlContent: toHtml(text),
      }),
    });
  } catch (e) {
    throw new BrevoTemporary(`Brevo unreachable: ${(e as Error).message}`);
  }
  const json = (await res.json().catch(() => ({}))) as { messageId?: string; message?: string; code?: string };
  if (res.ok && json.messageId) return { id: json.messageId };
  const why = json.message ?? json.code ?? `Brevo ${res.status}`;
  if (res.status === 429 || res.status >= 500) throw new BrevoTemporary(why);
  throw new BrevoPermanent(why);
}

/** Brevo webhook event → our message event (unknown events are ignored). */
export function brevoEvent(b: Record<string, unknown>) {
  const event = String(b.event ?? '').toLowerCase();
  const providerMessageId = String(b['message-id'] ?? b.messageId ?? '');
  const address = String(b.email ?? '').toLowerCase();
  const eventId = `${providerMessageId}|${event}|${String(b.ts_event ?? b.ts ?? b.date ?? '')}`;
  const reason = String(b.reason ?? '') || undefined;
  switch (event) {
    case 'delivered': return { eventId, type: 'STATUS' as const, providerMessageId, status: 'DELIVERED' as const };
    case 'opened': case 'unique_opened': case 'click': return { eventId, type: 'STATUS' as const, providerMessageId, status: 'READ' as const };
    case 'hard_bounce': case 'invalid_email': return { eventId, type: 'BOUNCE' as const, providerMessageId, address, reason: reason ?? 'Hard bounce' };
    case 'unsubscribed': case 'spam': case 'complaint': return { eventId, type: 'BOUNCE' as const, providerMessageId, address, reason: event === 'unsubscribed' ? 'Unsubscribed' : 'Marked as spam' };
    case 'blocked': case 'error': return { eventId, type: 'STATUS' as const, providerMessageId, status: 'FAILED' as const, reason: reason ?? (event === 'blocked' ? 'Blocked by Brevo' : 'Brevo error') };
    default: return null; // request, deferred, soft_bounce (Brevo retries): no change
  }
}

/**
 * Check an advisor's Brevo key and sender before saving them: the key must open the account, and the sender must be an
 * active sender there (or on a domain authenticated there).
 */
export async function checkBrevo(apiKey: string, fromEmail: string): Promise<{ ok: true; account: string | null } | { ok: false; reason: 'KEY' | 'SENDER' | 'UNREACHABLE'; detail: string }> {
  const get = async (path: string) => {
    const res = await fetch(`https://api.brevo.com/v3${path}`, { headers: { 'api-key': apiKey, Accept: 'application/json' } });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  try {
    const acc = await get('/account');
    if (acc.status === 401 || acc.status === 403) return { ok: false, reason: 'KEY', detail: String(acc.json.message ?? 'Unauthorized') };
    if (acc.status === 429 || acc.status >= 500) return { ok: false, reason: 'UNREACHABLE', detail: `Brevo ${acc.status}` };
    if (acc.status >= 400) return { ok: false, reason: 'KEY', detail: String(acc.json.message ?? `Brevo ${acc.status}`) };
    const email = fromEmail.trim().toLowerCase();
    const senders = await get('/senders');
    const list = (Array.isArray(senders.json.senders) ? senders.json.senders : []) as Array<Record<string, unknown>>;
    const found = list.some((x) => String(x.email ?? '').toLowerCase() === email && x.active !== false);
    if (!found) {
      const domain = email.split('@')[1] ?? '';
      const doms = await get('/senders/domains');
      const dl = (Array.isArray(doms.json.domains) ? doms.json.domains : []) as Array<Record<string, unknown>>;
      if (!dl.some((d) => String(d.domain_name ?? d.domain ?? '').toLowerCase() === domain && (d.authenticated === true || d.verified === true))) {
        return { ok: false, reason: 'SENDER', detail: `${fromEmail} is not a verified sender` };
      }
    }
    return { ok: true, account: (acc.json.companyName as string | undefined) ?? (acc.json.email as string | undefined) ?? null };
  } catch (e) {
    return { ok: false, reason: 'UNREACHABLE', detail: (e as Error).message };
  }
}