/**
 * LEAD SOURCES with stable codes (change #17, CFG-133).
 *
 * Earlier builds stored and matched the source by its display text ("Referred by a referrer"), so renaming a source in
 * configuration silently broke the referrer, client and campaign rules (GAP-ANALYSIS §5). Rules now key on the CODE;
 * the label is what screens show and what `lead.source` keeps for older clients and reports.
 *
 * CFG-133 is the list of codes offered on the new-lead form, in screen order. Codes not in it stay readable on
 * existing leads (PAID_ADS) or are set only by an import (LINKEDIN_ADS, WEBSITE_FORM).
 *
 * This file has no imports, so config/cfg.ts can validate CFG-133 against it.
 */
export type SourceNeeds = 'REFERRER' | 'CLIENT' | null;
export type CampaignName = 'REQUIRED' | 'OPTIONAL' | null;
interface SourceDef {
  label: string;
  /** Which linked record the source needs (P-12). */
  needs: SourceNeeds;
  /** "Campaign name" for Campaign (required); "Ad or campaign name" for ad platforms (optional). */
  campaignName: CampaignName;
  /** Kept only so old leads stay readable; never offered or accepted for a new lead or a correction. */
  legacy?: boolean;
}

export const LEAD_SOURCES = {
  META_ADS: { label: 'Meta Ads', needs: null, campaignName: 'OPTIONAL' },
  GOOGLE_ADS: { label: 'Google Ads', needs: null, campaignName: 'OPTIONAL' },
  WEBSITE: { label: 'Website', needs: null, campaignName: null },
  SOCIAL_MEDIA: { label: 'Social media', needs: null, campaignName: null },
  REFERRED_BY_CLIENT: { label: 'Referred by a client', needs: 'CLIENT', campaignName: null },
  REFERRED_BY_REFERRER: { label: 'Referred by a referrer', needs: 'REFERRER', campaignName: null },
  WALK_IN: { label: 'Walk-in or personal contact', needs: null, campaignName: null },
  CAMPAIGN: { label: 'Campaign', needs: null, campaignName: 'REQUIRED' },
  MANUAL_ENTRY: { label: 'Manual entry', needs: null, campaignName: null },
  OTHER: { label: 'Other', needs: null, campaignName: null },
  // Set by Campaigns imports (Module 17); not on the default new-lead list, an Admin may add them to CFG-133.
  LINKEDIN_ADS: { label: 'LinkedIn Ads', needs: null, campaignName: 'OPTIONAL' },
  WEBSITE_FORM: { label: 'Website form', needs: null, campaignName: null },
  // Replaced by Meta Ads and Google Ads (change #17). Old leads keep it.
  PAID_ADS: { label: 'Paid ads', needs: null, campaignName: null, legacy: true },
} as const satisfies Record<string, SourceDef>;

export type LeadSourceCode = keyof typeof LEAD_SOURCES;
export const LEAD_SOURCE_CODES = Object.keys(LEAD_SOURCES) as LeadSourceCode[];

/** The default CFG-133: the new-lead form of the October 2026 design, in its order. */
export const DEFAULT_OFFERED_SOURCES: LeadSourceCode[] = [
  'META_ADS', 'GOOGLE_ADS', 'WEBSITE', 'SOCIAL_MEDIA', 'REFERRED_BY_CLIENT', 'REFERRED_BY_REFERRER', 'WALK_IN', 'CAMPAIGN', 'MANUAL_ENTRY', 'OTHER',
];

export const isSourceCode = (v: unknown): v is LeadSourceCode => typeof v === 'string' && v in LEAD_SOURCES;
export const sourceDef = (code: LeadSourceCode): SourceDef => LEAD_SOURCES[code];
export const sourceLabel = (code: LeadSourceCode) => LEAD_SOURCES[code].label;

const BY_LABEL = new Map<string, LeadSourceCode>(LEAD_SOURCE_CODES.map((c) => [LEAD_SOURCES[c].label.toLowerCase(), c]));

/**
 * A code from a code or a label (older clients send the label; stored rows before the migration have only the label).
 * Case-insensitive on labels. Unknown text → null.
 */
export function sourceCodeOf(v: string | null | undefined): LeadSourceCode | null {
  if (!v) return null;
  const t = v.trim();
  if (isSourceCode(t)) return t;
  return BY_LABEL.get(t.toLowerCase()) ?? null;
}

/** Problem with a proposed CFG-133 value, or null (used by the configuration service, P-49). */
export function offeredSourcesProblem(value: unknown): string | null {
  if (!Array.isArray(value) || !value.length) return 'Must be a non-empty list of lead source codes.';
  const bad = value.filter((v) => !isSourceCode(v) || (LEAD_SOURCES[v] as SourceDef).legacy);
  if (bad.length) return `Unknown or retired lead source codes: ${bad.join(', ')}.`;
  if (new Set(value).size !== value.length) return 'Each lead source can be listed once.';
  return null;
}