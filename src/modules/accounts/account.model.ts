import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { protect } from '../../lib/pii.js';

/**
 * Account = one advisor's private space (tenant, Section 1.6). Subscription, wallet, empty advisor
 * profile, lead pipelines and reference-number counters are embedded, so P-01 creates the whole
 * account in a single document write (plus the advisor's user record).
 */
const pipelineSchema = new Schema({ _id: { type: String, required: true }, name: { type: String, required: true }, position: Number });

const accountSchema = new Schema(
  {
    _id: { type: String, default: () => newId('acc') },
    status: { type: String, enum: ['ACTIVE', 'SUSPENDED', 'CLOSED'], default: 'ACTIVE' },
    statusReason: { type: String, default: null },
    closedAt: { type: Date, default: null },
    subscription: {
      // P-01: TRIAL with no plan chosen. P-47 sets NORMAL or PREMIUM.
      plan: { type: String, enum: ['NORMAL', 'PREMIUM', null], default: null },
      status: { type: String, enum: ['TRIAL', 'ACTIVE', 'GRACE', 'EXPIRED'], required: true },
      startsAt: { type: Date, required: true },
      endsAt: { type: Date, required: true },
      cycle: { type: String, enum: ['MONTHLY', 'YEARLY', null], default: null },
      nextPlan: { type: String, enum: ['NORMAL', null], default: null }, // P-47 downgrade at period end
      waNumber: { type: Schema.Types.Mixed, default: null }, // P-47 Premium: { status, number, startedAt }
    },
    retainUntil: { type: Date, default: null }, // P-51 close / P-47 archive
    wallet: { balancePaise: { type: Number, default: 0, min: 0 } },
    /** P-40 occasion greetings: the switch, the template per occasion and excluded people. */
    greetings: { on: { type: Boolean, default: false }, templates: { type: Schema.Types.Mixed, default: {} }, excluded: { type: [String], default: [] } },
    profile: {
      kycStatus: { type: String, enum: ['NOT_SUBMITTED', 'PENDING_REVIEW', 'VERIFIED', 'REJECTED'], default: 'NOT_SUBMITTED' },
      completionPct: { type: Number, default: 0 },
      termsVersion: { type: String, required: true },
      termsAcceptedAt: { type: Date, required: true },
      // P-05 sections. The full name lives on the advisor's user record (users.name).
      // Each section has its own version, so two tabs saving the SAME section conflict (GEN-05)
      // while saving DIFFERENT sections never does (AC-P05-1, AC-P05-6).
      personal: {
        dob: { type: String, default: null }, // YYYY-MM-DD
        gender: { type: String, default: null },
        photoFileId: { type: String, default: null },
        savedAt: { type: Date, default: null },
      },
      contact: {
        email: { type: String, default: null },
        altMobile: { type: String, default: null },
        address1: { type: String, default: null },
        address2: { type: String, default: null },
        city: { type: String, default: null },
        state: { type: String, default: null },
        pin: { type: String, default: null },
        savedAt: { type: Date, default: null },
      },
      professional: {
        advisorType: { type: String, default: null },
        licenceNumber: { type: String, default: null },
        licenceValidUntil: { type: String, default: null }, // YYYY-MM-DD
        experienceYears: { type: Number, default: null },
        categories: { type: [String], default: [] }, // authorised insurance types
        savedAt: { type: Date, default: null },
      },
      business: {
        displayName: { type: String, default: null }, // name shown on quotations (defaults to the full name)
        gstin: { type: String, default: null },
        logoFileId: { type: String, default: null },
        savedAt: { type: Date, default: null },
      },
      // P-06 KYC. PAN is stored encrypted (GR-36); status is profile.kycStatus.
      kyc: {
        panEnc: { type: String, default: null },
        nameOnPan: { type: String, default: null },
        panFileId: { type: String, default: null },
        licenceFileId: { type: String, default: null },
        declaredAt: { type: Date, default: null },
        submittedAt: { type: Date, default: null },
        decidedAt: { type: Date, default: null },
        decidedBy: { type: String, default: null },
        rejectReason: { type: String, default: null },
        rejectNote: { type: String, default: null },
        // Change #48: what the reader found on the PAN and licence images, shown beside the typed values.
        // Encrypted JSON (holds the PAN). OFF = no reader set up; FAILED = the reviewer compares by eye.
        readStatus: { type: String, enum: ['OFF', 'PENDING', 'DONE', 'FAILED', null], default: null },
        readAt: { type: Date, default: null },
        readValuesEnc: { type: String, default: null },
        // The reviewer's four ticks, kept with the decision (§9.9, to confirm): panReadable, nameMatches, licenceValid, photoClear
        checklist: { type: Schema.Types.Mixed, default: null },
      },
      sectionVersions: {
        personal: { type: Number, default: 1 },
        contact: { type: Number, default: 1 },
        professional: { type: Number, default: 1 },
        business: { type: Number, default: 1 },
        kyc: { type: Number, default: 1 },
      },
      // Highest CFG-129 milestone already notified, so a milestone notifies once (P-05 step 4).
      milestoneNotified: { type: Number, default: 0 },
    },
    pipelines: { type: [pipelineSchema], default: [] },
    counters: { lead: { type: Number, default: 0 }, customer: { type: Number, default: 0 }, quotation: { type: Number, default: 0 }, comparison: { type: Number, default: 0 }, proposal: { type: Number, default: 0 } },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);

export type AccountDoc = InferSchemaType<typeof accountSchema> & { _id: string };
/**
 * Plan-based feature switches (flags.ts) follow plan changes at once: after any write that touches the subscription,
 * the account's plan is read back into the switches' memory (otherwise it would wait for the 30-second refresh).
 */
const touchesPlan = (u: unknown) => JSON.stringify(u ?? {}).includes('subscription');
async function refreshPlans(filter: Record<string, unknown>) {
  const { setAccountPlan } = await import('../flags/flags.js');
  const rows = await Account.find(filter, { 'subscription.plan': 1, 'subscription.status': 1 }).limit(500).lean<Array<{ _id: string; subscription?: { plan?: string | null; status?: string | null } }>>();
  for (const r of rows) setAccountPlan(r._id, r.subscription?.plan ?? null, r.subscription?.status ?? null);
}
accountSchema.post(['updateOne', 'updateMany', 'findOneAndUpdate'], async function (this: { getFilter(): Record<string, unknown>; getUpdate(): unknown }) {
  if (touchesPlan(this.getUpdate())) await refreshPlans(this.getFilter()).catch(() => undefined);
});
accountSchema.post('save', async function (doc: { _id: string; subscription?: { plan?: string | null; status?: string | null } }) {
  const { setAccountPlan } = await import('../flags/flags.js');
  setAccountPlan(doc._id, doc.subscription?.plan ?? null, doc.subscription?.status ?? null);
});
export const Account = model('Account', accountSchema, 'accounts');
/** Advisor contact details and KYC values are encrypted (lib/pii.ts); PAN and the read values were already. */
protect(Account, {
  fields: {
    'profile.contact.email': 'email', 'profile.contact.altMobile': 'mobile',
    'profile.kyc.nameOnPan': 'text', 'profile.kyc.rejectNote': 'text',
    'profile.professional.licenceNumber': 'text',
  },
});