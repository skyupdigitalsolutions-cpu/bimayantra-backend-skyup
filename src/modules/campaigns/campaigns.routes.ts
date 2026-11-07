import express, { Router } from 'express';
import cors from 'cors';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { enumOf, optional, required, shortText } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as svc from './campaigns.service.js';
import * as apps from './platformApps.js';
import { requireStepUp } from '../auth/stepUp.js';
import { AppError } from '../../lib/errors.js';
import { logger } from '../../lib/logger.js';

const cnx = z.object({ id: z.string().regex(/^cnx_[a-f0-9]{28}$/) });

/** Campaigns (Module 17): the advisor connects channels and maps forms; assistants see the sync log and form answers. */
export function campaignRoutes() {
  const r = Router();
  r.use(authenticate, allow('campaigns.view'));
  const m = [allow('campaigns.manage'), writable] as const;
  r.get('/connections', async (req, res) => sendData(res, await svc.connections(req.auth!)));
  // Own-app (manual) Meta / LinkedIn connection: the advisor's Page / ad account and token (CMP-21 if another account has it)
  const ids = z.array(z.string().trim().min(1).max(200)).max(50).optional();
  r.post('/connections/manual', ...m, validate({ body: z.discriminatedUnion('channel', [
    z.object({ channel: z.literal('META'), name: required(shortText()), pipelineId: z.string().max(40).nullable().optional(), formIds: ids,
      pageId: required(z.string().trim().regex(/^\d{5,25}$/, 'VAL-22')), pageToken: required(z.string().trim().min(20).max(1000)), appSecret: required(z.string().trim().min(16).max(200)), verifyToken: z.string().trim().max(200).nullable().optional() }).strict(),
    z.object({ channel: z.literal('LINKEDIN'), name: required(shortText()), pipelineId: z.string().max(40).nullable().optional(), formIds: ids,
      accountUrn: required(z.string().trim().regex(/^urn:li:(sponsoredAccount|organization):\d+$/, 'VAL-22')), accessToken: required(z.string().trim().min(20).max(2000)), clientSecret: required(z.string().trim().min(8).max(200)) }).strict(),
  ]) }, { name: 'Name', pageId: 'Page ID', pageToken: 'Page access token', appSecret: 'App secret', accountUrn: 'Ad account or organization URN', accessToken: 'Access token', clientSecret: 'Client secret' }), async (req, res) =>
    sendData(res, await svc.connectManual(req.auth!, req.body, req), 201));
  r.put('/connections/:id/manual', ...m, validate({ params: z.object({ id: z.string().regex(/^cnx_[a-f0-9]{28}$/) }), body: z.object({
    name: shortText().optional(), formIds: ids, pageToken: z.string().trim().min(20).max(1000).optional(), appSecret: z.string().trim().min(16).max(200).optional(),
    accessToken: z.string().trim().min(20).max(2000).optional(), clientSecret: z.string().trim().min(8).max(200).optional() }).strict() }), async (req, res) =>
    sendData(res, await svc.updateManual(req.auth!, String(req.params.id), req.body, req)));
  r.post('/connections', ...m, validate({ body: z.object({ channel: required(enumOf(['WEBSITE', 'GOOGLE'] as const)), name: required(shortText()), pipelineId: z.string().max(40).nullable().optional() }).strict() }, { channel: 'Channel', name: 'Name' }), async (req, res) => {
    const out = await svc.connect(req.auth!, req.body, req);
    sendDone(res, out, 'CMP-02', {}, 201);
  });
  r.post('/connections/:id/rotate-key', ...m, validate({ params: cnx }), async (req, res) => sendDone(res, await svc.rotateKey(req.auth!, String(req.params.id), req), 'CMP-03'));
  r.post('/connections/:id/disconnect', ...m, validate({ params: cnx }), async (req, res) => { const out = await svc.setStatus(req.auth!, String(req.params.id), false, req); sendDone(res, out.connection, 'CMP-04', out.params); });
  r.post('/connections/:id/reconnect', ...m, validate({ params: cnx }), async (req, res) => sendData(res, (await svc.setStatus(req.auth!, String(req.params.id), true, req)).connection));
  r.post('/connections/:id/embed-forms', ...m, validate({ params: cnx, body: z.object({ name: required(shortText()), campaignName: optional(shortText()), consentText: optional(z.string().max(300)) }).strict() }, { name: 'Form name' }), async (req, res) =>
    sendData(res, await svc.createEmbedForm(req.auth!, String(req.params.id), req.body, req), 201));
  r.get('/forms', validate({ query: z.object({ connectionId: z.string().max(40).optional() }) }), async (req, res) => sendData(res, await svc.forms(req.auth!, req.query.connectionId ? String(req.query.connectionId) : undefined)));
  r.put('/forms/:id', ...m, validate({ params: z.object({ id: z.string().regex(/^lfm_[a-f0-9]{28}$/) }), body: z.object({ name: optional(shortText()), campaignName: optional(shortText()), fieldMap: z.record(z.string().max(80), z.string().max(20)).optional(), pipelineId: z.string().max(40).nullable().optional(), active: z.boolean().optional() }).strict() }), async (req, res) =>
    sendDone(res, await svc.saveForm(req.auth!, String(req.params.id), req.body, req), 'CMP-06'));
  r.get('/submissions', validate({ query: z.object({ status: z.string().max(20).optional(), channel: z.string().max(20).optional(), connectionId: z.string().max(40).optional() }) }), async (req, res) =>
    sendData(res, await svc.submissions(req.auth!, req.query as Record<string, string>)));
  r.post('/submissions/:id/retry', ...m, validate({ params: z.object({ id: z.string().regex(/^sbm_[a-f0-9]{28}$/) }) }), async (req, res) => sendDone(res, await svc.retry(req.auth!, String(req.params.id), req), 'CMP-05'));
  // Meta / LinkedIn: sign in, then choose Pages or ad accounts
  r.get('/platforms', async (req, res) => sendData(res, svc.platformReady(req.auth!.accountId)));
  r.post('/oauth/:channel/start', ...m, validate({ params: z.object({ channel: z.enum(['meta', 'linkedin', 'google']) }), body: z.object({ connectionId: z.string().regex(/^cnx_[a-f0-9]{28}$/).optional() }).strict() }), async (req, res) =>
    sendData(res, await svc.oauthStart(req.auth!, String(req.params.channel).toUpperCase() as 'META' | 'LINKEDIN' | 'GOOGLE', req.body?.connectionId)));
  // Stage H: Sync now (status, spend and missed leads for one connection)
  r.post('/connections/:id/sync-now', ...m, validate({ params: cnx }), async (req, res) => sendDone(res, await svc.syncNow(req.auth!, String(req.params.id)), 'CMP-13'));
  r.get('/connections/:id/sources', allow('campaigns.manage'), validate({ params: cnx }), async (req, res) => sendData(res, await svc.sources(req.auth!, String(req.params.id))));
  r.put('/connections/:id/sources', ...m, validate({ params: cnx, body: z.object({ ids: z.array(z.string().max(120)).max(100) }).strict() }), async (req, res) =>
    sendDone(res, await svc.saveSources(req.auth!, String(req.params.id), req.body.ids, req), 'CMP-11'));
  r.get('/leads/:leadId/answers', validate({ params: z.object({ leadId: z.string().regex(/^led_[a-f0-9]{28}$/) }) }), async (req, res) => sendData(res, await svc.leadAnswers(req.auth!, String(req.params.leadId))));
  // Stage H: campaign list, detail and leads (ids: adc_ = platform campaign, lfm_ = website or LinkedIn form)
  const camp = z.object({ id: z.string().regex(/^(adc|lfm)_[a-f0-9]{28}$/) });
  r.get('/', validate({ query: z.object({ channel: z.enum(['WEBSITE', 'GOOGLE', 'META', 'LINKEDIN']).optional(), status: z.string().max(20).optional() }) }), async (req, res) =>
    sendData(res, await (await import('./campaigns.analytics.js')).list(req.auth!, res.locals.query as { channel?: string; status?: string })));
  r.get('/:id', validate({ params: camp }), async (req, res) => sendData(res, await (await import('./campaigns.analytics.js')).detail(req.auth!, String(req.params.id))));
  r.get('/:id/leads', validate({ params: camp }), async (req, res) => sendData(res, await (await import('./campaigns.analytics.js')).leads(req.auth!, String(req.params.id))));
  return r;
}

/** Platform receivers (no sign-in): authenticated by the connection key. Website posts come from other sites (CORS, no cookies). */
export function hookRoutes() {
  const r = Router();
  r.post('/google', async (req, res) => { const out = await svc.googleHook(req.body ?? {}); sendData(res, { received: true, status: out.submission.status, duplicate: out.duplicate }); });
  // Meta: subscription check (GET, plain text) and signed lead webhooks
  r.get('/meta', (req, res) => { res.type('text/plain').send(svc.metaVerify(req.query as Record<string, unknown>)); });
  r.post('/meta', async (req, res) => sendData(res, await svc.metaHook(req)));
  // LinkedIn: challenge (GET, JSON) and signed lead notifications
  r.get('/linkedin', (req, res) => { res.json(svc.linkedinChallenge(String(req.query.challengeCode ?? ''))); });
  r.post('/linkedin', async (req, res) => sendData(res, await svc.linkedinHook(req)));
  // Own-app (manual) connections: one webhook per connection, checked with that advisor's own secret
  const cid = z.object({ id: z.string().regex(/^cnx_[a-f0-9]{28}$/) });
  r.get('/meta/c/:id', validate({ params: cid }), async (req, res) => { res.type('text/plain').send(svc.metaVerifyFor(await svc.manualConnection('META', String(req.params.id)), req.query as Record<string, unknown>)); });
  r.post('/meta/c/:id', validate({ params: cid }), async (req, res) => sendData(res, await svc.metaHook(req, await svc.manualConnection('META', String(req.params.id)))));
  r.get('/linkedin/c/:id', validate({ params: cid }), async (req, res) => { res.json(svc.linkedinChallenge(String(req.query.challengeCode ?? ''), await svc.manualConnection('LINKEDIN', String(req.params.id)))); });
  r.post('/linkedin/c/:id', validate({ params: cid }), async (req, res) => sendData(res, await svc.linkedinHook(req, await svc.manualConnection('LINKEDIN', String(req.params.id)))));
  // The platforms send the browser back here after sign-in; we return it to the Campaigns screen.
  // The Campaigns screen reads ?connected= / ?error= and tells the person what happened (it used to be silent).
  r.get('/oauth/:channel/callback', async (req, res) => {
    const app = process.env.PUBLIC_APP_URL ?? 'http://localhost:5173';
    const channel = String(req.params.channel).toUpperCase();
    const back = (q: Record<string, string>) => res.redirect(302, `${app}/campaigns?${new URLSearchParams({ channel, ...q }).toString()}`);
    if (!['META', 'LINKEDIN', 'GOOGLE'].includes(channel)) return back({ error: 'unknown_channel' });
    if (req.query.error || !req.query.code) {
      // the person pressed Cancel, or the platform refused (wrong redirect URL, missing permission, app in development mode…)
      const reason = String(req.query.error_description ?? req.query.error_reason ?? req.query.error ?? 'Sign-in was cancelled').slice(0, 200);
      logger.warn({ channel, error: req.query.error, reason }, 'Ad platform sign-in did not complete');
      return back({ error: String(req.query.error ?? 'cancelled').slice(0, 60), reason });
    }
    try {
      const c = await svc.oauthCallback(channel as 'META' | 'LINKEDIN' | 'GOOGLE', String(req.query.code), String(req.query.state ?? ''));
      return back({ connected: c._id });
    } catch (e) {
      const reason = e instanceof AppError && e.status === 403 ? 'The sign-in link expired or was already used. Start again from Campaigns.' : (e as Error).message.slice(0, 200);
      logger.warn({ channel, err: e }, 'Ad platform sign-in failed after the platform returned');
      return back({ error: 'failed', reason });
    }
  });
  r.post('/website', express.urlencoded({ extended: false, limit: '64kb' }), async (req, res) => {
    const key = (req.headers['x-bimayantra-key'] as string | undefined) ?? null;
    const out = await svc.websiteHook(req.body ?? {}, key, req.ip ?? '');
    sendData(res, 'trapped' in out ? { received: true } : { received: true, status: out.submission.status, duplicate: out.duplicate });
  });
  return r;
}
export const websiteCors = cors({ origin: '*', credentials: false, methods: ['POST', 'OPTIONS'], allowedHeaders: ['Content-Type', 'X-Bimayantra-Key'] });

/** Our embeddable website form (public page /f/<key>). */
export function publicFormRoutes() {
  const r = Router();
  const k = z.object({ key: z.string().regex(/^[A-Za-z0-9_-]{12,40}$/) });
  r.get('/:key', validate({ params: k }), async (req, res) => { res.setHeader('X-Robots-Tag', 'noindex'); sendData(res, await svc.publicForm(String(req.params.key))); });
  r.post('/:key', validate({ params: k }), async (req, res) => { const out = await svc.submitPublicForm(String(req.params.key), req.body ?? {}, req.ip ?? ''); sendDone(res, { submitted: true }, 'CMP-07', out.params, 201); });
  return r;
}
/** SkyUp Admin → Ad platform apps: SkyUp's Meta / LinkedIn / Google app details, set once for every advisor (ADM, OTP). */
export function adminPlatformAppRoutes() {
  const r = Router();
  r.use(authenticate, allow('flags.manage'));
  r.get('/', (_req, res) => sendData(res, apps.list()));
  r.put('/:channel', requireStepUp, validate({
    params: z.object({ channel: z.enum(['meta', 'linkedin', 'google', 'META', 'LINKEDIN', 'GOOGLE']) }),
    body: z.object({ values: z.record(z.string().max(60), z.string().max(500).nullable()), reason: required(shortText()) }).strict(),
  }, { reason: 'Reason' }), async (req, res) => sendDone(res, await apps.save(req.auth!, String(req.params.channel), req.body, req), 'FLG-01'));
  return r;
}