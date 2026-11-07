import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { date, enumOf, optional, required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import { requireStepUp } from '../auth/stepUp.js';
import * as svc from './admin.service.js';
import * as view from './accountView.service.js';
import * as home from './adminDashboard.service.js';
import * as sup from './supportAdmin.service.js';

const accId = z.object({ id: z.string().regex(/^acc_[a-f0-9]{28}$/) });
const PLAN = enumOf(['NORMAL', 'PREMIUM'] as const);
const CYCLE = enumOf(['MONTHLY', 'YEARLY'] as const);
const gstin = () => z.string().regex(/^\d{2}[A-Z]{5}\d{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/, { message: 'VAL-39' });
const reason = z.object({ reason: required(shortText()) }).strict();
/** Change #52: the BPD list as `reasonCode` and/or free text as `reason` ("Other" or no code needs the text). */
const accountReason = { reasonCode: optional(enumOf(svc.SUPPORT_REASON_CODES)), reason: optional(shortText()) };
const accLabels = { reason: 'Reason', reasonCode: 'Reason', confirmText: 'Type CLOSE', toPlan: 'Plan', effective: 'Effective from', note: 'Note' };

/** P-47 My plan and billing: works in read-only mode, so an expired account can pay. */
export function billingRoutes() {
  const r = Router();
  r.use(authenticate, allow('billing.manage'));
  r.get('/', async (req, res) => sendData(res, await svc.billing(req.auth!)));
  r.post('/quote', validate({ body: z.object({ plan: required(PLAN), cycle: required(CYCLE), gstin: optional(gstin()) }).strict() }, { gstin: 'GSTIN' }), async (req, res) => sendData(res, await svc.quote(req.auth!.accountId!, req.body.plan, req.body.cycle, req.body.gstin)));
  r.post('/orders', validate({ body: z.object({ plan: required(PLAN), cycle: required(CYCLE), gstin: optional(gstin()) }).strict() }, { gstin: 'GSTIN' }), idempotent(), async (req, res) => sendData(res, await svc.createOrder(req.auth!, req.body, req), 201));
  r.get('/orders/:id', validate({ params: z.object({ id: z.string().regex(/^sor_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.orderStatus(req.auth!, String(req.params.id))));
  // Razorpay Checkout returned: verify and activate (the webhook does the same if the browser closes first)
  r.post('/orders/:id/verify', validate({ params: z.object({ id: z.string().regex(/^sor_[a-f0-9]{28}$/) }), body: z.object({ razorpayOrderId: z.string().regex(/^order_[A-Za-z0-9]{6,40}$/), razorpayPaymentId: z.string().regex(/^pay_[A-Za-z0-9]{6,40}$/), razorpaySignature: z.string().regex(/^[a-f0-9]{64}$/) }).strict() }), async (req, res) =>
    sendData(res, await svc.verifyOrder(req.auth!, String(req.params.id), req.body)));
  r.post('/downgrade', writable, validate({ body: z.object({ confirm: z.boolean().optional() }).strict() }), async (req, res) => sendData(res, await svc.downgrade(req.auth!, !!req.body.confirm, req)));
  return r;
}
/** P-52 export my data: allowed in read-only mode (AC-P52-3). */
export function exportRoutes() {
  const r = Router();
  r.use(authenticate, allow('export.own'));
  r.get('/', async (req, res) => sendData(res, await svc.listExports(req.auth!)));
  r.post('/', validate({ body: z.object({ include: z.array(enumOf(svc.EXPORT_PARTS)).min(1, { message: 'GEN-01' }) }).strict() }, { include: 'What to include' }), async (req, res) => sendDone(res, await svc.requestExport(req.auth!, req.body.include, req), 'ADM-10', {}, 202));
  r.get('/:id/download', validate({ params: z.object({ id: z.string().regex(/^exp_[a-f0-9]{28}$/) }) }), async (req, res) => {
    const { file, bytes } = await svc.downloadExport(req.auth!, String(req.params.id), req);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${file.name.replace(/"/g, '')}"`);
    res.setHeader('Cache-Control', 'no-store');
    res.end(bytes);
  });
  return r;
}
/** P-57 support access: the advisor gives (OTP) and ends; SkyUp opens client records only under a grant. */
export function supportGrantRoutes() {
  const r = Router();
  r.use(authenticate, allow('support.give'));
  r.get('/', async (req, res) => sendData(res, await svc.grants(req.auth!)));
  r.get('/staff', async (_req, res) => sendData(res, await svc.supportStaff()));
  r.post('/', writable, requireStepUp, validate({ body: z.object({ granteeUserId: required(z.string().regex(/^usr_[a-f0-9]{28}$/)), reason: required(shortText()) }).strict() }, { granteeUserId: 'SkyUp person', reason: 'Reason' }), async (req, res) => {
    const out = await svc.giveGrant(req.auth!, req.body, req);
    sendDone(res, out.grant, 'SUP-01', out.params, 201);
  });
  r.post('/:id/end', validate({ params: z.object({ id: z.string().regex(/^sgr_[a-f0-9]{28}$/) }) }), async (req, res) => { await svc.endGrant(req.auth!, String(req.params.id), req); sendDone(res, { ended: true }, 'SUP-02'); });
  return r;
}
export function supportUseRoutes() {
  const r = Router();
  r.use(authenticate, allow('support.use'));
  const p = z.object({ accountId: z.string().regex(/^acc_[a-f0-9]{28}$/) });
  r.get('/:accountId/customers', validate({ params: p }), async (req, res) => sendData(res, await svc.supportCustomers(req.auth!, String(req.params.accountId), req)));
  r.get('/:accountId/customers/:id', validate({ params: p.extend({ id: z.string().regex(/^cus_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.supportCustomer(req.auth!, String(req.params.accountId), String(req.params.id), req)));
  // Change #56: "Open account (read only)" sections, each checked against the grant and logged
  r.get('/:accountId/overview', validate({ params: p }), async (req, res) => sendData(res, await sup.supportOverview(req.auth!, String(req.params.accountId), req)));
  r.get('/:accountId/leads', validate({ params: p }), async (req, res) => sendData(res, await sup.supportLeads(req.auth!, String(req.params.accountId), req)));
  r.get('/:accountId/quotations', validate({ params: p }), async (req, res) => sendData(res, await sup.supportQuotations(req.auth!, String(req.params.accountId), req)));
  r.get('/:accountId/documents', validate({ params: p }), async (req, res) => sendData(res, await sup.supportDocuments(req.auth!, String(req.params.accountId), req)));
  return r;
}
/** Change #56: the SkyUp person's grants (Staff: their own; Admin: all) and "End my session". */
export function skyupGrantRoutes() {
  const r = Router();
  r.use(authenticate, allow('support.use'));
  r.get('/', validate({ query: z.object({ status: z.enum(['ACTIVE', 'ENDED', 'EXPIRED']).optional() }) }), async (req, res) =>
    sendData(res, await sup.grantsForSkyUp(req.auth!, res.locals.query as { status?: 'ACTIVE' | 'ENDED' | 'EXPIRED' })));
  r.post('/:id/end', validate({ params: z.object({ id: z.string().regex(/^sgr_[a-f0-9]{28}$/) }) }), async (req, res) => {
    const out = await sup.endMySession(req.auth!, String(req.params.id), req);
    sendDone(res, out.grant, 'SUP-04', out.params);
  });
  return r;
}

/** SkyUp admin: configuration (P-49), accounts (P-51), offline payments (P-47). */
export function adminRoutes() {
  const r = Router();
  r.use(authenticate);
  const chg = z.object({ id: z.string().regex(/^cfc_[a-f0-9]{28}$/) });
  r.get('/config', allow('config.manage'), async (_req, res) => sendData(res, svc.configList()));
  r.get('/config/history', allow('config.manage'), async (_req, res) => sendData(res, await svc.configHistory()));
  r.post('/config/:id/changes', allow('config.manage'), requireStepUp, validate({ params: z.object({ id: z.string().regex(/^CFG-\d{1,3}$/) }), body: z.object({ value: z.unknown(), reason: required(shortText()) }).strict() }, { value: 'Value', reason: 'Reason' }), async (req, res) =>
    sendDone(res, await svc.requestConfigChange(req.auth!, String(req.params.id), req.body.value, req.body.reason, req), 'ADM-06', {}, 201));
  r.post('/config/changes/:id/approve', allow('config.manage'), requireStepUp, validate({ params: chg }), async (req, res) => sendDone(res, await svc.decideConfigChange(req.auth!, String(req.params.id), true, req), 'ADM-06'));
  r.post('/config/changes/:id/reject', allow('config.manage'), validate({ params: chg }), async (req, res) => sendData(res, await svc.decideConfigChange(req.auth!, String(req.params.id), false, req)));
  // Change #59: the SkyUp home
  r.get('/dashboard', allow('admin.dashboard'), async (_req, res) => sendData(res, await home.dashboard()));
  // Change #49: the list with tabs and filters. `?view=tabs` returns { tabs, rows }; without it, the rows (older screens).
  r.get('/accounts', allow('accounts.view'), validate({ query: z.object({ tab: z.enum(['ALL', 'TRIAL', 'ACTIVE', 'GRACE', 'READ_ONLY', 'SUSPENDED', 'CLOSED']).optional(), kyc: z.enum(['NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED']).optional(), plan: z.enum(['TRIAL', 'NORMAL', 'PREMIUM']).optional(), q: z.string().max(100).optional(), view: z.enum(['tabs']).optional() }) }), async (req, res) => {
    const q = res.locals.query as { tab?: view.AccountTab; kyc?: string; plan?: string; q?: string; view?: 'tabs' };
    const out = await view.accountList(q);
    sendData(res, q.view === 'tabs' ? out : out.rows);
  });
  // The account's tabs (SA-03 to SA-03g). Subscription and Activity are Admin only (Staff: to confirm, §9.5).
  r.get('/accounts/:id', allow('accounts.view'), validate({ params: accId }), async (req, res) => sendData(res, await view.overview(String(req.params.id))));
  r.get('/accounts/:id/subscription', allow('accounts.admin'), validate({ params: accId }), async (req, res) => sendData(res, await view.subscription(String(req.params.id))));
  r.get('/accounts/:id/kyc', allow('accounts.view'), validate({ params: accId }), async (req, res) => sendData(res, await view.kyc(String(req.params.id))));
  r.get('/accounts/:id/insurers', allow('accounts.view'), validate({ params: accId }), async (req, res) => sendData(res, await view.insurers(String(req.params.id))));
  r.get('/accounts/:id/wallet', allow('accounts.view'), validate({ params: accId }), async (req, res) => sendData(res, await view.wallet(String(req.params.id))));
  r.get('/accounts/:id/assistants', allow('accounts.view'), validate({ params: accId }), async (req, res) => sendData(res, await view.assistants(String(req.params.id))));
  r.get('/accounts/:id/support-grants', allow('accounts.view'), validate({ params: accId }), async (req, res) => sendData(res, await view.supportGrants(String(req.params.id))));
  r.get('/accounts/:id/activity', allow('accounts.admin'), validate({ params: accId, query: z.object({ type: z.enum(['ALL', 'LOGINS', 'PLAN', 'KYC', 'SUPPORT', 'ACCOUNT']).optional() }) }), async (req, res) =>
    sendData(res, await view.activity(String(req.params.id), (res.locals.query as { type?: view.ActivityType }).type)));
  // Change #50: SkyUp changes the plan (OTP, note)
  r.post('/accounts/:id/plan', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: z.object({ toPlan: required(PLAN), effective: required(enumOf(['NOW', 'NEXT_RENEWAL'] as const)), note: required(shortText()) }).strict() }, accLabels), async (req, res) => {
    const out = await svc.changePlan(req.auth!, String(req.params.id), req.body, req);
    sendDone(res, out.change, 'ADM-15', out.params);
  });
  // Changes #53, #54: subscriptions across advisors with invoice detail; the wallets overview
  r.get('/subscriptions', allow('subscriptions.view'), validate({ query: z.object({ status: z.enum(['ALL', 'TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED']).optional() }) }), async (req, res) =>
    sendData(res, await svc.subscriptions(res.locals.query as { status?: string })));
  r.get('/invoices/:id', allow('subscriptions.view'), validate({ params: z.object({ id: z.string().regex(/^sor_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.invoice(String(req.params.id))));
  r.get('/wallets', allow('wallets.view'), validate({ query: z.object({ filter: z.enum(['ALL', 'LOW', 'EMPTY']).optional() }) }), async (req, res) =>
    sendData(res, await svc.wallets(res.locals.query as { filter?: 'ALL' | 'LOW' | 'EMPTY' })));
  r.post('/accounts/:id/suspend', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: z.object(accountReason).strict() }, accLabels), async (req, res) => { await svc.suspend(req.auth!, String(req.params.id), req.body, req); sendDone(res, { status: 'SUSPENDED' }, 'ADM-07'); });
  r.post('/accounts/:id/reactivate', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: reason }, { reason: 'Reason' }), async (req, res) => { await svc.reactivate(req.auth!, String(req.params.id), req.body.reason, req); sendDone(res, { status: 'ACTIVE' }, 'ADM-08'); });
  // Change #51: reason, the typed word CLOSE and the OTP
  r.post('/accounts/:id/close', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: z.object({ ...accountReason, confirmText: optional(z.string().max(10)) }).strict() }, accLabels), async (req, res) => { const out = await svc.close(req.auth!, String(req.params.id), req.body, req); sendDone(res, { status: 'CLOSED' }, 'ADM-09', out); });
  r.post('/accounts/:id/offline-payment', allow('accounts.admin'), requireStepUp, validate({ params: accId, body: z.object({ plan: required(PLAN), cycle: required(CYCLE), amount: z.number().positive(), reference: required(shortText()), startDate: optional(date()), replace: z.boolean().optional() }).strict() }, { reference: 'Payment reference', amount: 'Amount' }), async (req, res) =>
    sendData(res, await svc.offlinePayment(req.auth!, String(req.params.id), req.body, req), 201));
  return r;
}
export function subscriptionWebhookRoutes() { const r = Router(); r.post('/', async (req, res) => sendData(res, await svc.subscriptionWebhook(req))); return r; }