import { Router } from 'express';
import { cfgList, cfgNum, cfgRange } from '../../config/cfg.js';
import { INDIAN_STATES } from '../../lib/fields.js';
import { LEAD_SOURCE_CODES, LEAD_SOURCES, isSourceCode } from '../../lib/leadSources.js';
import { sendData } from '../../lib/response.js';
import { CONTACT_OUTCOMES, OUTCOME_LABEL, PRIORITIES } from '../leads/lead.model.js';
import { LEAD_STATUSES, STATUS_LABEL } from '../leads/leadStatus.js';
import { DEACTIVATION_REASONS, GENDERS, HOW_GIVEN, PREFERRED_CONTACTS } from '../customers/customer.model.js';

/**
 * Lists and limits the screens need. Lists that are CFG values come from here, never from the web app's
 * code, so a SkyUp Admin change shows up without a release. No personal data: public.
 */
export function referenceRoutes() {
  const r = Router();
  r.get('/', (_req, res) => sendData(res, {
    // Change #17: older clients read the labels; new clients use the codes and their rules.
    leadSources: cfgList('CFG-133').filter(isSourceCode).map((c) => LEAD_SOURCES[c].label),
    leadSourceOptions: cfgList('CFG-133').filter(isSourceCode).map((c) => ({ code: c, label: LEAD_SOURCES[c].label, needs: LEAD_SOURCES[c].needs, campaignName: LEAD_SOURCES[c].campaignName })),
    /** Every code with its label, including retired and import-only ones, for filters and showing old leads. */
    allLeadSources: LEAD_SOURCE_CODES.map((c) => ({ code: c, label: LEAD_SOURCES[c].label, retired: 'legacy' in LEAD_SOURCES[c] })),
    lostReasons: cfgList('CFG-33'),
    relationships: cfgList('CFG-36'),
    insuranceTypes: cfgList('CFG-115'),
    // P-18: all document types (CFG-171); which need Verify and which come from the vehicle screen (P-54)
    documentTypes: cfgList('CFG-171'),
    verifyDocumentTypes: ['Aadhaar', 'PAN', 'Old policy'],
    vehicleDocumentTypes: ['Vehicle RC', 'Vehicle photo'],
    vehiclePhotoSlots: cfgList('CFG-155'),
    pipelineNames: cfgList('CFG-169'),
    leadStatuses: LEAD_STATUSES.map((s) => ({ code: s, label: STATUS_LABEL[s] })),
    contactOutcomes: CONTACT_OUTCOMES.map((c) => ({ code: c, label: OUTCOME_LABEL[c] })),
    priorities: PRIORITIES,
    states: INDIAN_STATES,
    genders: GENDERS,
    preferredContacts: PREFERRED_CONTACTS,
    consentHowGiven: HOW_GIVEN,
    deactivationReasons: DEACTIVATION_REASONS,
    limits: {
      otpLength: cfgNum('CFG-01'), otpValidityMinutes: cfgNum('CFG-02'), resendSeconds: cfgNum('CFG-04'),
      idleMinutes: cfgNum('CFG-07'), idleWarningMinutes: cfgNum('CFG-123'), nameMin: cfgNum('CFG-11'), nameMax: cfgNum('CFG-12'),
      notesMax: cfgNum('CFG-13'), pageSize: cfgNum('CFG-23'), familyMax: cfgNum('CFG-35'), revealSeconds: cfgNum('CFG-176'),
      shortText: cfgRange('CFG-109'), trialDays: cfgNum('CFG-78'),
    },
  }));
  return r;
}