import { protect } from '../../lib/pii.js';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

export const CHANNELS = ['WEBSITE', 'GOOGLE', 'META', 'LINKEDIN'] as const;
/** The lead statuses an imported lead may start in (an open pipeline stage; FOLLOW_UP uses the usual first-call time). */
export const START_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'] as const;
export type Channel = (typeof CHANNELS)[number];

/**
 * A connected lead channel. The key is shown once; only a keyed hash is stored, so a webhook finds its connection in one
 * lookup without decrypting anyone's secrets. Rotation keeps the previous key working for CFG-196 days.
 */
const connectionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('cnx') },
    accountId: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    name: { type: String, required: true },
    status: { type: String, enum: ['CONNECTED', 'DISCONNECTED', 'RECONNECT_NEEDED'], default: 'CONNECTED' },
    keyHash: { type: String, default: null }, keyLast4: { type: String, default: null },
    prevKeyHash: { type: String, default: null }, prevKeyUntil: { type: Date, default: null },
    pipelineId: { type: String, default: null },
    createdBy: { type: String, required: true },
    lastLeadAt: { type: Date, default: null },
    /** Meta / LinkedIn: the signed-in person's token (encrypted), when it expires, and the Pages or ad accounts chosen. */
    tokenEnc: { type: String, default: null }, tokenExpiresAt: { type: Date, default: null },
    sources: { type: [new Schema({ id: String, name: String, tokenEnc: { type: String, default: null }, subscribed: { type: Boolean, default: false } }, { _id: false })], default: [] },
    lastSyncAt: { type: Date, default: null }, lastError: { type: String, default: null },
    /**
     * OAUTH: signed in through SkyUp's app. MANUAL: the advisor's own Meta / LinkedIn app and token, pasted in
     * Campaigns; leads arrive at this connection's own webhook (/hooks/meta/c/:id, /hooks/linkedin/c/:id), signed with
     * the advisor's own app secret / client secret.
     */
    mode: { type: String, enum: ['OAUTH', 'MANUAL'], default: 'OAUTH' },
    appSecretEnc: { type: String, default: null }, verifyTokenEnc: { type: String, default: null },
    /** Only these forms are imported (Meta form IDs / LinkedIn lead-form URNs / Google form IDs); empty = every form. */
    formFilter: { type: [String], default: [] },
    /** Google: only leads from these campaign IDs are imported; empty = every campaign. Others are kept as SKIPPED. */
    campaignFilter: { type: [String], default: [] },
    /** Connect-form details: the status new leads start in, labels for the campaign, and the website's contact page. */
    defaultStatus: { type: String, enum: START_STATUSES, default: 'NEW' },
    adSetName: { type: String, default: null }, parentCampaign: { type: String, default: null }, category: { type: String, default: null },
    contactPageUrl: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
connectionSchema.index({ keyHash: 1 }, { unique: true, partialFilterExpression: { keyHash: { $type: 'string' } } });
connectionSchema.index({ prevKeyHash: 1 }, { sparse: true });
connectionSchema.index({ accountId: 1, channel: 1 });
connectionSchema.index({ channel: 1, 'sources.id': 1, status: 1 });
export type ConnectionDoc = InferSchemaType<typeof connectionSchema> & { _id: string; createdAt: Date };
export const Connection = model('CampaignConnection', connectionSchema, 'campaign_connections');

/** A form on a channel, with how its fields map to a lead. Google and website forms are created on their first lead. */
const formSchema = new Schema(
  {
    _id: { type: String, default: () => newId('lfm') },
    accountId: { type: String, required: true },
    connectionId: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    externalId: { type: String, required: true }, // Google form_id, a website form name, or our embed form key
    name: { type: String, required: true },
    campaignName: { type: String, default: null },
    fieldMap: { type: Schema.Types.Mixed, default: {} }, // { externalKey: 'name' | 'mobile' | 'email' | 'city' | 'consent' | 'ignore' }
    fields: { type: Schema.Types.Mixed, default: null }, // our embed form: [{ key, label, type, required }]
    publicKey: { type: String, default: null }, // our embed form's public link key
    pipelineId: { type: String, default: null },
    active: { type: Boolean, default: true },
    seenKeys: { type: [String], default: [] }, // field keys seen in submissions (for the mapping screen)
  },
  { timestamps: true, versionKey: false, minimize: false },
);
formSchema.index({ connectionId: 1, externalId: 1 }, { unique: true });
formSchema.index({ publicKey: 1 }, { unique: true, partialFilterExpression: { publicKey: { $type: 'string' } } });
export type FormDoc = InferSchemaType<typeof formSchema> & { _id: string };
export const LeadForm = model('LeadForm', formSchema, 'lead_forms');

/**
 * Every submission is stored first, exactly as received, then imported. One row per platform lead ID (a database rule),
 * so a repeated webhook never creates a second lead. RECEIVED → IMPORTED | LINKED | SKIPPED | FAILED (retry possible).
 */
const submissionSchema = new Schema(
  {
    _id: { type: String, default: () => newId('sbm') },
    accountId: { type: String, required: true },
    connectionId: { type: String, required: true },
    formId: { type: String, default: null },
    channel: { type: String, enum: CHANNELS, required: true },
    externalId: { type: String, required: true },
    answers: { type: [new Schema({ key: String, label: String, value: String }, { _id: false })], default: [] },
    meta: { type: Schema.Types.Mixed, default: {} }, // campaign/ad IDs, click ID, page URL
    isTest: { type: Boolean, default: false },
    status: { type: String, enum: ['RECEIVED', 'IMPORTED', 'LINKED', 'SKIPPED', 'FAILED'], default: 'RECEIVED' },
    reason: { type: String, default: null },
    leadId: { type: String, default: null }, customerId: { type: String, default: null },
    attempts: { type: Number, default: 0 },
    /** Stage H: the platform campaign and ad this lead came from (Meta, Google), for the campaign pages. */
    adCampaignId: { type: String, default: null }, adCreativeId: { type: String, default: null },
  },
  { timestamps: true, versionKey: false, minimize: false },
);
submissionSchema.index({ connectionId: 1, externalId: 1 }, { unique: true, name: 'one_submission_per_platform_lead' });
submissionSchema.index({ accountId: 1, createdAt: -1 });
submissionSchema.index({ accountId: 1, leadId: 1 });
submissionSchema.index({ accountId: 1, adCampaignId: 1, createdAt: -1 });
submissionSchema.index({ accountId: 1, formId: 1, createdAt: -1 });
export type SubmissionDoc = InferSchemaType<typeof submissionSchema> & { _id: string; createdAt: Date };
export const Submission = model('LeadSubmission', submissionSchema, 'lead_submissions');
/** Form answers are the person's details; a website form's external id is built from them. */
protect(Submission, { fields: { 'answers.value': 'text', externalId: 'key' } });

/**
 * Stage H (change #1 items 9–13): a platform campaign (Meta, Google), created when its first lead arrives or when a
 * sync finds it. Status and lifetime spend are read every 15 minutes; "Not syncing" is shown when the connection is
 * not connected (the stored status stays as last read).
 */
export const PLATFORM_STATUSES = ['ACTIVE', 'IN_REVIEW', 'PAUSED', 'NOT_APPROVED', 'ENDED'] as const;
const adCampaignSchema = new Schema(
  {
    _id: { type: String, default: () => newId('adc') },
    accountId: { type: String, required: true },
    connectionId: { type: String, required: true },
    channel: { type: String, enum: CHANNELS, required: true },
    externalCampaignId: { type: String, required: true },
    name: { type: String, default: null },
    platformStatus: { type: String, enum: [...PLATFORM_STATUSES, null], default: null },
    statusReason: { type: String, default: null },
    spendAmount: { type: Number, default: null }, spendCurrency: { type: String, default: null }, spendSyncedAt: { type: Date, default: null },
    startedOn: { type: String, default: null }, // YYYY-MM-DD
    lastSyncedAt: { type: Date, default: null }, lastSyncError: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
adCampaignSchema.index({ connectionId: 1, externalCampaignId: 1 }, { unique: true, name: 'one_campaign_per_connection' });
adCampaignSchema.index({ accountId: 1, channel: 1 });
export type AdCampaignDoc = InferSchemaType<typeof adCampaignSchema> & { _id: string; createdAt: Date };
export const AdCampaign = model('AdCampaign', adCampaignSchema, 'ad_campaigns');

/** An ad inside a campaign (leads per ad on the campaign page). */
const adCreativeSchema = new Schema(
  {
    _id: { type: String, default: () => newId('adr') },
    accountId: { type: String, required: true },
    campaignId: { type: String, required: true },
    externalAdId: { type: String, required: true },
    name: { type: String, default: null }, adSetName: { type: String, default: null }, placement: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
adCreativeSchema.index({ campaignId: 1, externalAdId: 1 }, { unique: true, name: 'one_ad_per_campaign' });
export type AdCreativeDoc = InferSchemaType<typeof adCreativeSchema> & { _id: string };
export const AdCreative = model('AdCreative', adCreativeSchema, 'ad_creatives');