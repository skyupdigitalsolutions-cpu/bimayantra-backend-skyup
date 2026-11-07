/**
 * Razorpay (PAYMENT_GATEWAY=razorpay): orders, payment look-up / capture and signature checks.
 * Used for plan purchases (admin.service) and WhatsApp wallet recharges (comms.service). No SDK: three REST calls.
 *   Checkout signature:  HMAC_SHA256(key_secret, `${order_id}|${payment_id}`)
 *   Webhook signature:   HMAC_SHA256(webhook_secret, raw request body)   (header X-Razorpay-Signature)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

const API = 'https://api.razorpay.com/v1';
const auth = () => `Basic ${Buffer.from(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`).toString('base64')}`;

export class GatewayError extends Error {}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, { method, headers: { Authorization: auth(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const json = (await res.json().catch(() => ({}))) as { error?: { description?: string } } & T;
  if (!res.ok) throw new GatewayError(json?.error?.description ?? `Razorpay ${res.status}`);
  return json;
}

export interface RzpOrder { id: string; amount: number; currency: string; status: string; receipt: string }
export interface RzpPayment { id: string; order_id: string; amount: number; currency: string; status: 'created' | 'authorized' | 'captured' | 'refunded' | 'failed'; error_description?: string | null }

/** amountPaise in paise; receipt is our own id (max 40 chars); notes say what the payment is for. */
export const createOrder = (amountPaise: number, receipt: string, notes: Record<string, string>) =>
  call<RzpOrder>('POST', '/orders', { amount: amountPaise, currency: 'INR', receipt: receipt.slice(0, 40), notes });

export const getPayment = (paymentId: string) => call<RzpPayment>('GET', `/payments/${encodeURIComponent(paymentId)}`);

/** Accounts without auto-capture leave payments "authorized": capture them for the order amount. */
export const capture = (paymentId: string, amountPaise: number) => call<RzpPayment>('POST', `/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountPaise, currency: 'INR' });

const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function checkoutSignatureValid(orderId: string, paymentId: string, signature: string) {
  return same(createHmac('sha256', env.RAZORPAY_KEY_SECRET ?? '').update(`${orderId}|${paymentId}`).digest('hex'), String(signature ?? ''));
}
export function webhookSignatureValid(raw: Buffer, signature: string) {
  if (!env.RAZORPAY_WEBHOOK_SECRET) return false;
  return same(createHmac('sha256', env.RAZORPAY_WEBHOOK_SECRET).update(raw).digest('hex'), String(signature ?? ''));
}

/** What the browser needs to open Razorpay Checkout. */
export const checkoutFor = (o: RzpOrder, description: string) => ({ gateway: 'razorpay' as const, keyId: env.RAZORPAY_KEY_ID, razorpayOrderId: o.id, amountPaise: o.amount, currency: o.currency, name: env.PAYMENT_DISPLAY_NAME, description });

/**
 * Confirm a payment for one of our orders (after Checkout or from the webhook): it must belong to the Razorpay order and
 * the amount must match; an "authorized" payment is captured here. Returns the captured payment, or null when it failed.
 */
export async function confirm(razorpayOrderId: string, paymentId: string, amountPaise: number): Promise<RzpPayment | null> {
  let p = await getPayment(paymentId);
  if (p.order_id !== razorpayOrderId || p.amount !== amountPaise || p.currency !== 'INR') throw new GatewayError('Payment does not match the order');
  if (p.status === 'authorized') p = await capture(paymentId, amountPaise);
  if (p.status === 'captured') return p;
  return null;
}