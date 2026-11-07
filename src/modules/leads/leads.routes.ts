import { Router } from 'express';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { sendData, sendDone } from '../../lib/response.js';
import { contactBody, convertBody, createLeadBody, duplicateQuery, labels, leadIdParam, listLeadsQuery, statusBody, updateLeadBody, timelineQuery } from './leads.schemas.js';
import * as leads from './leads.service.js';
import * as withdrawal from './withdrawal.service.js';
import { z } from 'zod';

const id = (req: { params: unknown }) => (req.params as { id: string }).id;

export function pipelineRoutes() {
  const r = Router();
  r.get('/', authenticate, allow('leads.work'), async (req, res) => sendData(res, await leads.listPipelines(req.auth!)));
  return r;
}

export function leadRoutes() {
  const r = Router();
  r.use(authenticate, allow('leads.work'));
  r.get('/', validate({ query: listLeadsQuery }), async (req, res) => {
    const { items, meta } = await leads.listLeads(req.auth!, res.locals.query);
    sendData(res, items, 200, meta);
  });
  r.get('/duplicate-check', validate({ query: duplicateQuery }, labels), async (req, res) => sendData(res, await leads.duplicateCheck(req.auth!, res.locals.query)));
  r.post('/', writable, validate({ body: createLeadBody }, labels), idempotent(), async (req, res) => {
    const lead = await leads.createLead(req.auth!, req.body, req);
    sendDone(res, lead, 'LD-01', { 'lead number': lead.number }, 201);
  });
  r.get('/:id', validate({ params: leadIdParam }), async (req, res) => sendData(res, await leads.getLead(req.auth!, id(req))));
  r.get('/:id/timeline', validate({ params: leadIdParam, query: timelineQuery }), async (req, res) => {
    const types = (res.locals.query as { types?: string }).types?.split(',').map((t) => t.trim()).filter(Boolean);
    sendData(res, await leads.timeline(req.auth!, id(req), types));
  });
  r.patch('/:id', writable, validate({ params: leadIdParam, body: updateLeadBody }, labels), async (req, res) =>
    sendDone(res, await leads.updateLead(req.auth!, id(req), req.body, req), 'GEN-08', { 'Record type': 'Lead' }));
  r.post('/:id/status', writable, validate({ params: leadIdParam, body: statusBody }, labels), idempotent(), async (req, res) => {
    const out = await leads.changeStatus(req.auth!, id(req), req.body, req);
    sendDone(res, out.lead, out.messageId, out.params);
  });
  r.post('/:id/contacts', writable, validate({ params: leadIdParam, body: contactBody }, labels), idempotent(), async (req, res) =>
    sendDone(res, await leads.logContact(req.auth!, id(req), req.body, req), 'GEN-08', { 'Record type': 'Contact' }, 201));
  r.post('/:id/convert', writable, validate({ params: leadIdParam, body: convertBody }, labels), idempotent(), async (req, res) => {
    const out = await leads.convertLead(req.auth!, id(req), req.body, req);
    sendDone(res, { lead: out.lead, customer: out.customer, outcome: out.outcome }, out.messageId, out.params);
  });
  // Q97: after the person withdrew their ad form — keep the lead, or remove it with its tasks (advisor only)
  const versionOnly = z.object({ version: z.number().int().positive() }).strict();
  r.post('/:id/withdrawal/keep', writable, validate({ params: leadIdParam, body: versionOnly }, labels), async (req, res) =>
    sendDone(res, await withdrawal.keepLead(req.auth!, id(req), req.body, req), 'CMP-17'));
  r.post('/:id/remove', allow('leads.loseReopen'), writable, validate({ params: leadIdParam, body: z.object({ version: z.number().int().positive(), reason: z.string().trim().max(200).nullable().optional() }).strict() }, labels), idempotent(), async (req, res) => {
    const out = await withdrawal.removeLead(req.auth!, id(req), req.body, req);
    sendDone(res, out, 'CMP-18', { number: out.number });
  });
  return r;
}