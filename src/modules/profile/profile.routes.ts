import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/authenticate.js';
import { allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import {
  addressLine, city, dateOfBirth, editable, email, enumOf, gstin, licenceNumber, lists, mobile, oneOf, optional, personName,
  pin, recordId, required, shortText, state, todayOrLater, version, wholeNumber,
} from '../../lib/fields.js';
import { cfgNum } from '../../config/cfg.js';
import { sendData, sendDone } from '../../lib/response.js';
import * as profile from './profile.service.js';

/**
 * P-05 progressive profile. Each section is saved on its own: only the fields of that section are
 * validated, and "required for completion" fields may be left empty (P-05 step 2).
 */
const schemas: Record<profile.Section, z.ZodTypeAny> = {
  personal: z.object({
    version: required(version()),
    fullName: editable(personName()), // cannot be cleared
    dob: optional(dateOfBirth()),
    gender: optional(z.preprocess((v) => (typeof v === 'string' ? profile.normalizeGender(v) ?? v : v), enumOf(profile.ADVISOR_GENDERS))),
    photoFileId: optional(recordId('fil')),
  }).strict(),
  contact: z.object({
    version: required(version()),
    email: optional(email()),
    altMobile: optional(mobile()),
    address1: optional(addressLine()),
    address2: optional(addressLine()),
    city: optional(city()),
    state: optional(state()),
    pin: optional(pin()),
  }).strict(),
  professional: z.object({
    version: required(version()),
    advisorType: optional(enumOf(profile.ADVISOR_TYPES)),
    licenceNumber: optional(licenceNumber()),
    licenceValidUntil: optional(todayOrLater()),
    experienceYears: optional(wholeNumber(0, () => cfgNum('CFG-151'))),
    // Checked on save against the starting types (CFG-115) and every ACTIVE catalogue type (P-21 + Type).
    categories: z.array(z.string().trim().min(1).max(80)).max(50).transform((a) => [...new Set(a)]).optional(),
  }).strict(),
  business: z.object({
    version: required(version()),
    displayName: optional(shortText()),
    gstin: optional(gstin()),
    logoFileId: optional(recordId('fil')),
  }).strict(),
};

const labels = {
  version: 'Version', fullName: 'Full name', dob: 'Date of birth', gender: 'Gender', email: 'Email', altMobile: 'Alternate mobile',
  address1: 'Address line 1', address2: 'Address line 2', city: 'City', state: 'State', pin: 'PIN code', advisorType: 'Advisor type',
  licenceNumber: 'IRDAI licence or POSP certificate number', licenceValidUntil: 'Licence valid until', experienceYears: 'Experience in years',
  categories: 'Authorised insurance categories', displayName: 'Name shown on quotations', gstin: 'GSTIN', photoFileId: 'Profile photo', logoFileId: 'Logo',
};

const sectionParam = z.object({ section: z.enum(profile.SECTIONS) });

export function profileRoutes() {
  const r = Router();
  r.use(authenticate, allow('profile.manage'));
  r.get('/', async (req, res) => sendData(res, await profile.getProfile(req.auth!)));
  r.put('/:section', writable, validate({ params: sectionParam }), async (req, res, next) => {
    const section = String(req.params.section) as profile.Section;
    // Validate with this section's own schema only (P-05 step 3).
    validate({ body: schemas[section] }, labels)(req, res, async (e?: unknown) => {
      if (e) return next(e);
      try {
        const out = await profile.saveSection(req.auth!, section, req.body, req);
        sendDone(res, out.profile, 'PRF-01', { percent: out.percent });
      } catch (err) { next(err); }
    });
  });
  return r;
}