import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { enumOf } from '../../lib/fields.js';
import { sendData } from '../../lib/response.js';
import * as d from './dashboard.service.js';
import { search } from '../search/search.service.js';

/** P-08: one call per widget, each scoped to the account, so one failure never blanks the dashboard. */
export function dashboardRoutes() {
  const r = Router();
  r.use(authenticate, allow('dashboard.view'));
  const w = (fn: (ctx: NonNullable<Express.Request['auth']>) => Promise<unknown>): RequestHandler => async (req, res) => sendData(res, await fn(req.auth!));
  r.get('/open-leads', w(d.openLeads));
  r.get('/active-customers', w(d.activeCustomers));
  r.get('/open-quotations', w(d.openQuotations));
  r.get('/policies-in-force', w(d.policiesInForce));
  r.get('/renewals-due', w(d.renewalsDue));
  // Change #22: the new widgets
  r.get('/lead-status-counts', w(d.leadStatusCounts));
  r.get('/follow-ups', w(d.followUps));
  r.get('/lead-sources', w(d.leadSources));
  r.get('/catalogue-summary', w(d.catalogueSummary));
  r.get('/ad-leads-today', w(d.adLeadsToday));
  r.get('/funnel', validate({ query: z.object({ period: enumOf(['THIS_MONTH', 'LAST_3_MONTHS', 'THIS_YEAR'] as const).default('THIS_MONTH') }) }),
    async (req, res) => sendData(res, await d.funnel(req.auth!, (req.query.period as d.Period) ?? 'THIS_MONTH')));
  r.get('/todays-tasks', w(d.todaysTasks));
  r.get('/recent-activity', w(d.recentActivity));
  r.get('/profile-card', w(d.profileCard));
  return r;
}

/** P-09 global search: GET /v1/search?q=… */
export function searchRoutes() {
  const r = Router();
  r.use(authenticate, allow('dashboard.view'));
  r.get('/', validate({ query: z.object({ q: z.string().max(100).default('') }) }, { q: 'Search' }), async (req, res) =>
    sendData(res, await search(req.auth!, String(req.query.q ?? ''))));
  return r;
}