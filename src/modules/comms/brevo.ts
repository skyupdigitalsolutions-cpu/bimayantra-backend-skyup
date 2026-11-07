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

export async function sendEmail(to: string, subject: string | null, text: string): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': env.BREVO_API_KEY ?? '', 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        sender: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
        ...(env.EMAIL_REPLY_TO ? { replyTo: { email: env.EMAIL_REPLY_TO } } : {}),
        to: [{ email: to }],
        subject: subject ?? env.EMAIL_FROM_NAME,
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