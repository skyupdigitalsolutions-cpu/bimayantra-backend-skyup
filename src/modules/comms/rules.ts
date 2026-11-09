/**
 * Settings → Message templates: for each trigger, which template the advisor sends on each channel.
 *   OFF     = do not send on this channel
 *   DEFAULT = Bimayantra's template (Admin → Message templates); email goes through the advisor's Brevo when connected
 *   OWN     = WhatsApp: one of the advisor's own approved MSG91 templates, with each blank {{n}} matched to one of our
 *             values; Email: the advisor's own subject and message (with {variables})
 * Rows exist only for triggers the advisor changed; the rest use DEFAULTS below.
 *   GET /message-rules · PUT /message-rules/:trigger
 */
import type { Request } from 'express';
import { Router } from 'express';
import { Schema, model, type InferSchemaType } from 'mongoose';
import { z } from 'zod';
import { clock } from '../../lib/clock.js';
import { AppError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { msg } from '../../lib/messages.js';
import * as msg91 from '../../lib/msg91.js';
import { sendData, sendDone } from '../../lib/response.js';
import { authenticate } from '../../middleware/authenticate.js';
import { accountOf, allow, writable } from '../../middleware/authorize.js';
import { validate } from '../../middleware/validate.js';
import { Account } from '../accounts/account.model.js';
import { audit } from '../audit/audit.service.js';
import { Integration } from '../integrations/integration.model.js';
import { ownMsg91 } from '../integrations/integrations.service.js';
import type { AuthContext } from '../rbac/capabilities.js';
import { MessageTemplate, Outbox } from './outbox.model.js';

type Ch = 'WHATSAPP' | 'EMAIL';
export const MODES = ['OFF', 'DEFAULT', 'OWN'] as const;
type Mode = (typeof MODES)[number];

/** The triggers an advisor controls, in the order shown. */
export const TRIGGERS: Record<string, { label: string; when: string; channels: Ch[]; on: boolean; variables: string[]; greeting?: boolean }> = {
  LEAD_WELCOME: { label: 'New lead welcome', when: 'When a new lead is added (by you, a website form, an ad or a referrer).', channels: ['WHATSAPP', 'EMAIL'], on: false, variables: ['name', 'advisor name', 'advisor mobile'] },
  FOLLOW_UP: { label: 'Follow-up', when: 'At the follow-up time set on an open lead.', channels: ['WHATSAPP', 'EMAIL'], on: false, variables: ['name', 'follow-up date', 'follow-up time', 'advisor name', 'advisor mobile'] },
  RENEWAL_REMINDER: { label: 'Renewal reminder', when: 'Before a policy is due for renewal, on the reminder days.', channels: ['WHATSAPP', 'EMAIL'], on: true, variables: ['customer first name', 'product', 'policy last 4', 'renewal date', 'advisor name', 'advisor mobile'] },
  BIRTHDAY: { label: 'Birthday wishes', when: 'On a customer’s or family member’s birthday (Premium).', channels: ['WHATSAPP'], on: true, variables: ['name', 'advisor name'], greeting: true },
  FAMILY_BIRTHDAY: { label: 'Family birthday (to the customer)', when: 'On a family member’s birthday, sent to the customer (Premium).', channels: ['WHATSAPP'], on: true, variables: ['customer name', 'member name', 'advisor name'], greeting: true },
  ANNIVERSARY: { label: 'Anniversary wishes', when: 'On a customer’s wedding anniversary (Premium).', channels: ['WHATSAPP'], on: true, variables: ['name', 'advisor name'], greeting: true },
  QUOTATION_EMAIL: { label: 'Quotation email', when: 'When you share a quotation by email.', channels: ['EMAIL'], on: true, variables: ['customer name', 'quotation number', 'link', 'advisor name', 'advisor mobile'] },
};
export const GREETING_TRIGGERS = Object.keys(TRIGGERS).filter((k) => TRIGGERS[k]!.greeting);

const ruleSchema = new Schema(
  {
    _id: { type: String, default: () => newId('mrl') },
    accountId: { type: String, required: true },
    trigger: { type: String, enum: Object.keys(TRIGGERS), required: true },
    whatsapp: {
      mode: { type: String, enum: MODES, default: 'DEFAULT' },
      templateName: { type: String, default: null }, language: { type: String, default: null },
      /** Our value for each blank, in order: variables[0] fills {{1}}. */
      variables: { type: [String], default: [] },
      /** The template's body as approved at MSG91 (shown as the message text once filled). */
      body: { type: String, default: null },
    },
    email: { mode: { type: String, enum: MODES, default: 'DEFAULT' }, subject: { type: String, default: null }, body: { type: String, default: null } },
    /** When the rule last went from fully off to on: lead triggers only reach leads from this time (no old-lead blast). */
    activeSince: { type: Date, default: null },
    updatedBy: { type: String, default: null },
  },
  { timestamps: true, versionKey: false },
);
ruleSchema.index({ accountId: 1, trigger: 1 }, { unique: true });
ruleSchema.index({ trigger: 1, activeSince: 1 });
export type RuleDoc = InferSchemaType<typeof ruleSchema> & { _id: string; updatedAt: Date };
export const MessageRule = model('MessageRule', ruleSchema, 'message_rules');

export interface WaChoice { mode: Mode; templateName: string | null; language: string | null; variables: string[]; body: string | null }
export interface EmailChoice { mode: Mode; subject: string | null; body: string | null }
export interface Resolved { trigger: string; whatsapp: WaChoice; email: EmailChoice; activeSince: Date | null; saved: boolean }

function defaults(trigger: string, greetingsOn: boolean): Resolved {
  const t = TRIGGERS[trigger];
  const on = t ? (t.greeting ? greetingsOn : t.on) : true;
  const mode = (ch: Ch): Mode => (!t || (t.channels.includes(ch) && on) ? 'DEFAULT' : 'OFF');
  return { trigger, whatsapp: { mode: mode('WHATSAPP'), templateName: null, language: null, variables: [], body: null }, email: { mode: mode('EMAIL'), subject: null, body: null }, activeSince: null, saved: false };
}
const fromDoc = (d: RuleDoc): Resolved => ({
  trigger: d.trigger, activeSince: d.activeSince ?? null, saved: true,
  whatsapp: { mode: d.whatsapp?.mode as Mode, templateName: d.whatsapp?.templateName ?? null, language: d.whatsapp?.language ?? null, variables: d.whatsapp?.variables ?? [], body: d.whatsapp?.body ?? null },
  email: { mode: d.email?.mode as Mode, subject: d.email?.subject ?? null, body: d.email?.body ?? null },
});

/** The choice in force for one account and trigger (purposes that are not advisor triggers: DEFAULT on both). */
export async function ruleFor(accountId: string, trigger: string): Promise<Resolved> {
  if (!TRIGGERS[trigger]) return defaults(trigger, true);
  const d = await MessageRule.findOne({ accountId, trigger }).lean<RuleDoc>();
  if (d) return fromDoc(d);
  const acc = TRIGGERS[trigger]!.greeting ? await Account.findById(accountId, { greetings: 1 }).lean<{ greetings?: { on?: boolean } }>() : null;
  return defaults(trigger, !!acc?.greetings?.on);
}

/** {name} placeholders used in a custom email must be the trigger's values (COM-03). */
function checkVars(trigger: string, text: string, field: string) {
  const allowed = TRIGGERS[trigger]!.variables;
  const used = [...text.matchAll(/\{([^{}]+)\}/g)].map((m) => m[1]!.trim());
  if (used.some((v) => !allowed.includes(v))) throw AppError.field(field, 'COM-03', { purpose: TRIGGERS[trigger]!.label.toLowerCase(), list: allowed.map((v) => `{${v}}`).join(', ') });
}

export async function getRules(ctx: AuthContext) {
  const accountId = accountOf(ctx);
  const [docs, acc, ints, sys] = await Promise.all([
    MessageRule.find({ accountId }).lean<RuleDoc[]>(),
    Account.findById(accountId, { subscription: 1, greetings: 1 }).lean<{ subscription?: { plan?: string | null }; greetings?: { on?: boolean } }>(),
    Integration.find({ accountId }, { provider: 1, status: 1 }).lean<Array<{ provider: string; status: string }>>(),
    MessageTemplate.find({ status: 'ACTIVE', purpose: { $in: Object.keys(TRIGGERS) } }, { purpose: 1, channel: 1, subject: 1, body: 1 }).lean<Array<{ purpose: string; channel: Ch; subject?: string | null; body: string }>>(),
  ]);
  const premium = acc?.subscription?.plan === 'PREMIUM';
  const conn = (p: string) => ints.find((i) => i.provider === p)?.status ?? null;
  return {
    connections: { MSG91: conn('MSG91'), BREVO: conn('BREVO') },
    premium,
    triggers: Object.entries(TRIGGERS).map(([key, t]) => {
      const d = docs.find((x) => x.trigger === key);
      const r = d ? fromDoc(d) : defaults(key, !!acc?.greetings?.on);
      const def = (ch: Ch) => sys.find((s) => s.purpose === key && s.channel === ch) ?? null;
      return {
        trigger: key, label: t.label, when: t.when, channels: t.channels, variables: t.variables,
        locked: t.greeting && !premium ? { messageId: 'SUB-01', message: msg('SUB-01') } : null,
        whatsapp: t.channels.includes('WHATSAPP') ? r.whatsapp : null,
        email: t.channels.includes('EMAIL') ? r.email : null,
        defaults: { whatsapp: def('WHATSAPP')?.body ?? null, email: def('EMAIL') ? { subject: def('EMAIL')!.subject ?? null, body: def('EMAIL')!.body } : null },
      };
    }),
  };
}

export interface RuleBody {
  whatsapp?: { mode: Mode; templateName?: string | null; language?: string | null; variables?: string[] } | null;
  email?: { mode: Mode; subject?: string | null; body?: string | null } | null;
}

export async function saveRule(ctx: AuthContext, trigger: string, b: RuleBody, req: Request) {
  const accountId = accountOf(ctx);
  const t = TRIGGERS[trigger];
  if (!t) throw AppError.notFound();
  const current = await ruleFor(accountId, trigger);
  const chLabel = { WHATSAPP: 'WhatsApp', EMAIL: 'email' };
  for (const [k, ch] of [['whatsapp', 'WHATSAPP'], ['email', 'EMAIL']] as const) {
    if (b[k] && b[k]!.mode !== 'OFF' && !t.channels.includes(ch)) throw AppError.field(`${k}.mode`, 'MR-07', { trigger: t.label, channel: chLabel[ch] });
  }
  if (t.greeting && [b.whatsapp?.mode].some((m) => m && m !== 'OFF')) {
    const acc = await Account.findById(accountId, { subscription: 1 }).lean<{ subscription?: { plan?: string | null } }>();
    if (acc?.subscription?.plan !== 'PREMIUM') throw new AppError(403, 'PLAN_REQUIRED', 'SUB-01');
  }

  let whatsapp = current.whatsapp;
  if (b.whatsapp && t.channels.includes('WHATSAPP')) {
    const w = b.whatsapp;
    if (w.mode === 'OWN') {
      const creds = await ownMsg91(accountId);
      if (!creds) throw AppError.field('whatsapp.mode', 'MR-02');
      const name = String(w.templateName ?? '').trim();
      if (!name) throw AppError.field('whatsapp.templateName', 'GEN-01', { 'Field label': 'WhatsApp template' });
      let list: msg91.OwnTemplate[];
      try { list = await msg91.listOwnTemplates(creds); } catch { throw new AppError(503, 'PROVIDER_UNREACHABLE', 'INT-06', { provider: 'MSG91' }); }
      const tpl = list.find((x) => x.name === name && (!w.language || x.language === w.language)) ?? list.find((x) => x.name === name);
      if (!tpl) throw AppError.field('whatsapp.templateName', 'MR-05', { status: 'not found' });
      if (tpl.status !== 'APPROVED') throw AppError.field('whatsapp.templateName', 'MR-05', { status: tpl.status.toLowerCase() });
      if (!tpl.supported) throw AppError.field('whatsapp.templateName', 'MR-06', { format: String(tpl.headerFormat ?? 'media').toLowerCase() });
      const vars = (w.variables ?? []).map((v) => String(v ?? '').trim());
      if (vars.length !== tpl.blanks || vars.some((v) => !v)) throw AppError.field('whatsapp.variables', 'MR-03', { count: tpl.blanks });
      if (vars.some((v) => !t.variables.includes(v))) throw AppError.field('whatsapp.variables', 'COM-03', { purpose: t.label.toLowerCase(), list: t.variables.map((v) => `{${v}}`).join(', ') });
      whatsapp = { mode: 'OWN', templateName: tpl.name, language: tpl.language, variables: vars, body: tpl.body };
    } else {
      // Off or Bimayantra's: keep the last chosen own template so switching back is one click.
      whatsapp = { ...current.whatsapp, mode: w.mode };
    }
  }

  let email = current.email;
  if (b.email && t.channels.includes('EMAIL')) {
    const e = b.email;
    if (e.mode === 'OWN') {
      const subject = String(e.subject ?? '').trim(), body = String(e.body ?? '').trim();
      if (!subject || !body) throw AppError.field(!subject ? 'email.subject' : 'email.body', 'MR-04');
      if (subject.length > 200 || body.length > 5000) throw AppError.field('email.body', 'MR-04');
      checkVars(trigger, subject, 'email.subject');
      checkVars(trigger, body, 'email.body');
      email = { mode: 'OWN', subject, body };
    } else email = { ...current.email, mode: e.mode };
  }

  const anyOn = (r: { whatsapp: WaChoice; email: EmailChoice }) => (t.channels.includes('WHATSAPP') && r.whatsapp.mode !== 'OFF') || (t.channels.includes('EMAIL') && r.email.mode !== 'OFF');
  const nowOn = anyOn({ whatsapp, email });
  const activeSince = nowOn ? (anyOn(current) && current.activeSince ? current.activeSince : clock.now()) : null;
  await MessageRule.updateOne({ accountId, trigger }, { $set: { whatsapp, email, activeSince, updatedBy: ctx.userId } }, { upsert: true });

  // Occasion greetings: the account's greetings switch follows the greeting triggers; off cancels queued greetings.
  if (t.greeting) {
    const others = await Promise.all(GREETING_TRIGGERS.filter((g) => g !== trigger).map((g) => ruleFor(accountId, g)));
    const greetingsOn = whatsapp.mode !== 'OFF' || others.some((r) => r.whatsapp.mode !== 'OFF');
    await Account.updateOne({ _id: accountId }, { $set: { 'greetings.on': greetingsOn } });
    if (whatsapp.mode === 'OFF') await Outbox.updateMany({ accountId, purpose: trigger, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Turned off in Message templates', statusAt: clock.now() } });
  } else if (!nowOn) {
    await Outbox.updateMany({ accountId, purpose: trigger, status: 'QUEUED' }, { $set: { status: 'CANCELLED', skipReason: 'Turned off in Message templates', statusAt: clock.now() } });
  }
  await audit({ entity: 'message_rule', entityId: `${accountId}|${trigger}`, action: 'MESSAGE_RULE_SAVED', after: { trigger, whatsapp: whatsapp.mode, email: email.mode, template: whatsapp.mode === 'OWN' ? whatsapp.templateName : null } }, { req });
  return { rule: { trigger, whatsapp: t.channels.includes('WHATSAPP') ? whatsapp : null, email: t.channels.includes('EMAIL') ? email : null, activeSince }, label: t.label };
}

const choice = z.object({ mode: z.enum(MODES) });
export function ruleRoutes() {
  const r = Router();
  r.use(authenticate, allow('rules.manage'));
  r.get('/', async (req, res) => sendData(res, await getRules(req.auth!)));
  r.put('/:trigger', writable, validate({
    params: z.object({ trigger: z.enum(Object.keys(TRIGGERS) as [string, ...string[]]) }),
    body: z.object({
      whatsapp: choice.extend({ templateName: z.string().trim().max(200).optional().nullable(), language: z.string().trim().max(20).optional().nullable(), variables: z.array(z.string().max(60)).max(20).optional() }).strict().optional().nullable(),
      email: choice.extend({ subject: z.string().max(300).optional().nullable(), body: z.string().max(6000).optional().nullable() }).strict().optional().nullable(),
    }).strict(),
  }), async (req, res) => {
    const out = await saveRule(req.auth!, String(req.params.trigger), req.body, req);
    sendDone(res, out.rule, 'MR-01', { trigger: out.label });
  });
  return r;
}