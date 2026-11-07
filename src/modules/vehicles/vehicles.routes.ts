import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { idempotent } from '../../middleware/idempotency.js';
import { validate } from '../../middleware/validate.js';
import { cfgNum } from '../../config/cfg.js';
import { istToday } from '../../lib/clock.js';
import { enumOf, optional, recordId, required, shortText, vehicleRegistration, version, wholeNumber } from '../../lib/fields.js';
import { sendData, sendDone } from '../../lib/response.js';
import { FUELS, VEHICLE_TYPES } from './vehicle.model.js';
import * as svc from './vehicles.service.js';

const labels = {
  registration: 'Registration number', vehicleType: 'Vehicle type', make: 'Make', model: 'Model', year: 'Year of manufacture', fuel: 'Fuel',
  rcFileId: 'RC (registration certificate)', photos: 'Photos', slot: 'Photo slot', fileId: 'File', kind: 'What to add', status: 'Status', version: 'Version',
};
const customerParam = z.object({ customerId: z.string().regex(/^cus_[a-f0-9]{28}$/) });
const idParam = z.object({ id: z.string().regex(/^veh_[a-f0-9]{28}$/) });

const createBody = z.object({
  registration: required(vehicleRegistration()),
  vehicleType: required(enumOf(VEHICLE_TYPES)),
  make: required(shortText()),
  model: required(shortText()),
  year: required(wholeNumber(() => cfgNum('CFG-181'), () => Number(istToday().slice(0, 4)))),
  fuel: required(enumOf(FUELS)),
  rcFileId: required(recordId('fil')),
  photos: z.array(z.object({ slot: z.string().max(40), fileId: recordId('fil') }).strict()).max(20).default([]),
}).strict();

/** Customer → Vehicles (P-54). Mounted at /customers/:customerId/vehicles. */
export function customerVehicleRoutes() {
  const r = Router({ mergeParams: true });
  r.use(authenticate, allow('vehicles.work'));
  r.get('/', validate({ params: customerParam }), async (req, res) => sendData(res, await svc.listForCustomer(req.auth!, String(req.params.customerId))));
  r.post('/', writable, validate({ params: customerParam, body: createBody }, labels), idempotent(), async (req, res) => {
    const out = await svc.create(req.auth!, String(req.params.customerId), req.body, req);
    sendDone(res, out.vehicle, 'VEH-01', out.params, 201);
  });
  return r;
}

/** One vehicle: details, a newer RC or slot photo, mark sold / active again. */
export function vehicleRoutes() {
  const r = Router();
  r.use(authenticate, allow('vehicles.work'));
  r.get('/:id', validate({ params: idParam }), async (req, res) => sendData(res, await svc.detail(req.auth!, String(req.params.id))));
  r.post('/:id/files', writable, validate({ params: idParam, body: z.object({ kind: required(enumOf(['RC', 'PHOTO'] as const)), slot: optional(z.string().max(40)), fileId: required(recordId('fil')) }).strict() }, labels), idempotent(),
    async (req, res) => {
      const out = await svc.addFile(req.auth!, String(req.params.id), req.body, req);
      sendDone(res, out.vehicle, 'DOC-03', out.params, 201);
    });
  r.post('/:id/status', writable, validate({ params: idParam, body: z.object({ version: required(version()), status: required(enumOf(['ACTIVE', 'INACTIVE'] as const)) }).strict() }, labels),
    async (req, res) => sendDone(res, await svc.setStatus(req.auth!, String(req.params.id), req.body, req), 'GEN-08', { 'Record type': 'Vehicle' }));
  return r;
}