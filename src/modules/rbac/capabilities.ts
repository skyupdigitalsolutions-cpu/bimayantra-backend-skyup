import type { Role } from '../users/user.model.js';

/**
 * PERMISSION MATRIX (Section 3.2). Roles are fixed; there are no custom roles in v3.2.
 * Routes check a capability, never a role name. "Own" in the matrix = the user's own account,
 * enforced by every query filtering on accountId (GR-20).
 */
export const CAPABILITIES = {
  /** Leads: create, edit, move between stages, convert, log contacts (P-12 to P-14). */
  'leads.work': ['ADV', 'AST'],
  /** Leads: mark lost or reopen (ADV only). */
  'leads.loseReopen': ['ADV'],
  /** Correct a lead's source or referrer after saving (P-12: "only the advisor"). */
  'leads.correctSource': ['ADV'],
  /** Client records, household roster, consent, PAN/Aadhaar entry (P-15 to P-17). */
  'customers.work': ['ADV', 'AST'],
  /** Deactivate or reactivate a customer (P-19; assistants cannot archive). */
  'customers.deactivate': ['ADV'],
  /** Show the full PAN or Aadhaar (GR-36; assistants see masked only). */
  'customers.revealIdentity': ['ADV'],
  /** Own advisor profile: personal, contact, professional and business sections (P-05). */
  'profile.manage': ['ADV'],
  /** Review advisor KYC: verify or reject (P-06). Advisor's own data, not client data: no support grant needed. */
  'kyc.review': ['STF', 'ADM'],
  /** Verify or reject advisor KYC (client decision, OPEN-QUESTIONS Q113): SkyUp admins only. Staff can still open the queue. */
  'kyc.decide': ['ADM'],
  /** The advisor's insurers and agent codes (P-07). */
  'insurers.manage': ['ADV'],
  /** See accounts flagged because they share an insurer and agent code (P-07, DEC-09). */
  'agentCodes.review': ['STF', 'ADM'],
  /** Upload, view and confirm customer documents (P-18). */
  'documents.work': ['ADV', 'AST'],
  /** Change a document's label (P-18 step 8: ADV only). */
  'documents.relabel': ['ADV'],
  /** A customer's vehicles: add, new photo/RC versions, mark sold (P-54). */
  'vehicles.work': ['ADV', 'AST'],
  /** The advisor's tasks and follow-ups (P-11). */
  'tasks.work': ['ADV'],
  /** Dashboard widgets (P-08) and global search (P-09). */
  'dashboard.view': ['ADV'],
  /** Catalogue: make changes (insurers, types, products) — Section 9. */
  'catalogue.make': ['STF', 'ADM'],
  /** Catalogue: approve or reject another person's change; deactivate (ADM only). */
  'catalogue.approve': ['ADM'],
  /** See and quote the catalogue (verified products and the account's own) — P-22. */
  'products.view': ['ADV', 'AST'],
  /** Create and change the account's own products (P-22 step 2). */
  'products.own': ['ADV'],
  /** Private commission and notes per product (P-22 step 3): the advisor only, never assistants (AC-P22-6). */
  'commercials.manage': ['ADV'],
  /** My prices (P-24): the advisor's private price versions. */
  'prices.manage': ['ADV'],
  /** Best-fit ranking (P-26). */
  'bestfit.use': ['ADV', 'AST'],
  /** Quotations (P-27): create and generate. The BPD says ADV; assistants may prepare drafts (decision Q48). */
  'quotations.work': ['ADV', 'AST'],
  /** Price override and discount on a quotation: ADV only (P-27, GEN-03 for assistants). */
  'quotations.pricing': ['ADV'],
  /** Files only the server creates (quotation PDFs): no role may upload them. */
  'files.system': [],
  /** Payment links and recorded payments (P-31, P-32): the advisor only (GEN-03 for assistants, AC-P32-5). */
  'payments.record': ['ADV'],
  /** Proposals (P-55): advisors and assistants prepare; only the advisor submits. */
  'proposals.prepare': ['ADV', 'AST'],
  'proposals.submit': ['ADV'],
  /** Policies (P-33 to P-36): the advisor records and changes them; assistants can view. */
  'policies.view': ['ADV', 'AST'],
  'policies.manage': ['ADV'],
  /** Renewals (P-38): assistants see the list; the advisor works them to an outcome. */
  'renewals.view': ['ADV', 'AST'],
  'renewals.manage': ['ADV'],
  /** Communications (P-43): the advisor and assistants see messages; the advisor cancels and resends. */
  'comms.view': ['ADV', 'AST'],
  'comms.manage': ['ADV'],
  /** Occasion greetings (P-40) and the WhatsApp wallet (P-56): the advisor. */
  'greetings.manage': ['ADV'],
  'wallet.manage': ['ADV'],
  /** Message templates (P-39): SkyUp Staff drafts, a different Admin approves; Admin credits wallets (P-56). */
  'templates.make': ['STF', 'ADM'],
  'templates.approve': ['ADM'],
  'wallet.credit': ['ADM'],
  /** Referrers (P-44): the advisor; a referrer sees only their own link and referrals (P-45). */
  'referrers.manage': ['ADV'],
  'referral.self': ['REF'],
  /** P-47 My plan and billing; P-52 export my data; P-57 give support access: the advisor. */
  'billing.manage': ['ADV'],
  'export.own': ['ADV'],
  'support.give': ['ADV'],
  /** P-49 configuration (ADM; a different ADM approves); P-51 accounts; P-47 offline payments; P-50 audit export. */
  'config.manage': ['ADM'],
  'accounts.admin': ['ADM'],
  /** Change #49/#59: the SkyUp home and an advisor account's read tabs (counts and the advisor's own data only, AC-P51-3). */
  'accounts.view': ['STF', 'ADM'],
  'admin.dashboard': ['STF', 'ADM'],
  'audit.export': ['ADM'],
  /** P-57: SkyUp opens client records only under an active grant. */
  'support.use': ['STF', 'ADM'],
  /** Changes #53, #54: subscriptions across advisors (Admin); wallets overview (Staff may view). */
  'subscriptions.view': ['ADM'],
  'wallets.view': ['STF', 'ADM'],
  /** Calls from the mobile app: advisors and assistants sync and see calls; only the advisor plays recordings. */
  'calls.sync': ['ADV', 'AST'],
  'calls.view': ['ADV', 'AST'],
  'calls.listen': ['ADV'],
  /** Campaigns (Module 17): the advisor connects channels; assistants see imported leads and their form answers. */
  'campaigns.manage': ['ADV'],
  'campaigns.view': ['ADV', 'AST'],
  /** Stage H: ad spend and cost per lead (the advisor only, Q81). */
  'campaigns.spend': ['ADV'],
  /** Brochures: advisors (own products, P-58 attachments) and SkyUp (P-23 OCR). */
  'brochure.upload': ['ADV', 'STF', 'ADM'],
  /** Suggest a correction to a verified product (P-58). */
  'corrections.suggest': ['ADV'],
  /** Manage assistant users (P-53). */
  'assistants.manage': ['ADV'],
  /** Manage SkyUp users (P-48). */
  'staff.manage': ['ADM'],
  /** Audit log: ADV own account; STF metadata only; ADM everything (P-50). */
  'audit.view': ['ADV', 'STF', 'ADM'],
  /** Feature switches for staged rule changes (change analysis §5.3, §9.1): SkyUp Admin only, OTP on every change. */
  'flags.manage': ['ADM'],
} as const satisfies Record<string, readonly Role[]>;

export type Capability = keyof typeof CAPABILITIES;

/** Capabilities that open client personal data: SkyUp needs a support grant (P-57, GR-39). */
export const CLIENT_DATA = new Set<Capability>(['leads.work', 'leads.loseReopen', 'leads.correctSource', 'customers.work',
  'customers.deactivate', 'customers.revealIdentity']);

export const can = (role: Role, cap: Capability) => (CAPABILITIES[cap] as readonly Role[]).includes(role);
export const capabilitiesOf = (role: Role) => (Object.keys(CAPABILITIES) as Capability[]).filter((c) => can(role, c));

export interface AuthContext {
  userId: string;
  sessionId: string;
  role: Role;
  name: string;
  mobile: string;
  accountId: string | null;
  client: 'WEB' | 'APP';
  /** Effective subscription for account users (null for SkyUp users). */
  subscription: { status: 'TRIAL' | 'ACTIVE' | 'GRACE' | 'EXPIRED'; plan: 'NORMAL' | 'PREMIUM' | null; endsAt: Date } | null;
  /** GR-33: an EXPIRED subscription can view, search and export, but not create, edit or send. */
  readOnly: boolean;
  capabilities: Capability[];
}