/**
 * Razorpay webhook: POST /v1/webhooks/razorpay. Set it up in the Razorpay dashboard with the same secret as
 * RAZORPAY_WEBHOOK_SECRET and the events payment.captured and order.paid.
 *   - The signature (X-Razorpay-Signature) is checked on the raw body; a forged call changes nothing (403).
 *   - Each event is processed once (X-Razorpay-Event-Id).
 *   - The payment is matched by its Razorpay order to a plan purchase or a wallet recharge; amounts must match.
 * A failed attempt is ignored: the customer can pay again on the same order until it expires.
 */
import type { Request } from 'express';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { isDuplicateKey } from '../../lib/mongo.js';
import { logger } from '../../lib/logger.js';
import { webhookSignatureValid } from '../../lib/razorpay.js';
import { settleSubscriptionPayment } from '../admin/admin.service.js';
import { creditRecharge } from './comms.service.js';
import { WalletTxn, WebhookEvent } from './outbox.model.js';

type Payment = { id: string; order_id: string; amount: number; currency: string; status: string };

export async function razorpayWebhook(req: Request) {
  const raw = (req as unknown as { rawBody?: Buffer }).rawBody ?? Buffer.from('');
  if (!webhookSignatureValid(raw, String(req.headers['x-razorpay-signature'] ?? ''))) throw AppError.forbidden();
  const body = req.body as { event?: string; payload?: { payment?: { entity?: Payment } } };
  const eventId = String(req.headers['x-razorpay-event-id'] ?? '') || `${body.event}|${body.payload?.payment?.entity?.id ?? ''}`;
  try { await WebhookEvent.create({ _id: `razorpay|${eventId}`, source: 'razorpay', at: clock.now() }); } catch (x) { if (isDuplicateKey(x)) return { processed: false }; throw x; }
  const p = body.payload?.payment?.entity;
  if (!p || !['payment.captured', 'order.paid'].includes(String(body.event)) || p.status !== 'captured' || p.currency !== 'INR') return { processed: true, ignored: body.event ?? 'unknown' };
  if (await settleSubscriptionPayment(p.order_id, p.id, p.amount)) return { processed: true, kind: 'SUBSCRIPTION' };
  const t = await WalletTxn.findOne({ gatewayOrderId: p.order_id, type: 'RECHARGE' }).lean();
  if (t) {
    if (t.amountPaise !== p.amount) { logger.warn({ order: p.order_id }, 'Razorpay amount does not match the recharge'); return { processed: true, ignored: 'amount does not match' }; }
    await creditRecharge(t._id, p.id);
    return { processed: true, kind: 'WALLET' };
  }
  return { processed: true, ignored: 'unknown order' };
}