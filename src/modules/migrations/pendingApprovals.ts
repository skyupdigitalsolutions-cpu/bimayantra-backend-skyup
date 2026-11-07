/**
 * No admin approval (client decision, OPEN-QUESTIONS Q92): items still waiting for approval when this release goes
 * live. Dry run lists them; `publish` publishes each through the same code as a direct publish (every check applies,
 * the original maker is recorded in the audit log); `toDraft` returns them to draft for their makers to publish.
 * An item whose publish check fails is returned to draft and reported with the reason, never left waiting.
 * Message templates already with Meta stay with Meta (that is Meta's approval, not ours).
 */
import type { Request } from 'express';
import { audit } from '../audit/audit.service.js';
import { ConfigChange } from '../admin/admin.model.js';
import { decideConfigChange } from '../admin/admin.service.js';
import { MessageTemplate } from '../comms/outbox.model.js';
import { approveTemplate } from '../comms/comms.service.js';
import { ProductVersion } from '../catalogue/product.model.js';
import { adminApprove } from '../catalogue/products.service.js';
import { TemplateVersion } from '../catalogue/types.model.js';
import { approve as approveTemplateVersion } from '../catalogue/types.service.js';
import { approve as approveInsurer } from '../catalogue/insurers.service.js';
import { Insurer } from '../insurers/insurer.model.js';
import type { AuthContext } from '../rbac/capabilities.js';

type Item = { kind: string; id: string; name: string; maker: string | null; result?: string };
const ctx = { userId: 'SYSTEM_MIGRATION', role: 'ADM', accountId: null } as unknown as AuthContext;
const req = { auth: ctx, ip: null, headers: {}, get: () => undefined } as unknown as Request;

export async function runPendingApprovals(opts: { mode: 'dry' | 'publish' | 'toDraft' }) {
  const items: Item[] = [];
  const ins = await Insurer.find({ $or: [{ status: 'PENDING_APPROVAL' }, { 'pendingChange.status': 'PENDING' }] }).lean<Array<{ _id: string; name: string; status: string; makerId?: string | null; version: number; pendingChange?: { makerId?: string | null } | null }>>();
  for (const i of ins) items.push({ kind: i.status === 'PENDING_APPROVAL' ? 'INSURER' : 'INSURER_CHANGE', id: i._id, name: i.name, maker: (i.status === 'PENDING_APPROVAL' ? i.makerId : i.pendingChange?.makerId) ?? null });
  for (const t of await TemplateVersion.find({ status: 'PENDING_APPROVAL' }).lean<Array<{ _id: string; typeId: string; number: number; makerId: string }>>()) items.push({ kind: 'TEMPLATE', id: t._id, name: `template ${t.number} (${t.typeId})`, maker: t.makerId });
  for (const v of await ProductVersion.find({ status: 'PENDING_APPROVAL' }).lean<Array<{ _id: string; productId: string; number: number; makerId: string; data?: { name?: string } }>>()) items.push({ kind: 'PRODUCT_VERSION', id: v._id, name: `${v.data?.name ?? v.productId} v${v.number}`, maker: v.makerId });
  for (const m of await MessageTemplate.find({ status: 'PENDING_APPROVAL', metaStatus: { $ne: 'SUBMITTED' } }).lean<Array<{ _id: string; name: string; makerId: string }>>()) items.push({ kind: 'MESSAGE_TEMPLATE', id: m._id, name: m.name, maker: m.makerId });
  for (const c of await ConfigChange.find({ status: 'PENDING_APPROVAL' }).lean<Array<{ _id: string; cfgId: string; requestedBy: string }>>()) items.push({ kind: 'CONFIG_CHANGE', id: c._id, name: c.cfgId, maker: c.requestedBy });
  if (opts.mode === 'dry') return { mode: opts.mode, count: items.length, items };

  for (const it of items) {
    try {
      if (opts.mode === 'toDraft') { await toDraft(it); it.result = 'RETURNED_TO_DRAFT'; }
      else { await publish(it); it.result = 'PUBLISHED'; }
      await audit({ entity: 'migration', entityId: it.id, action: opts.mode === 'publish' ? 'PENDING_ITEM_PUBLISHED' : 'PENDING_ITEM_RETURNED_TO_DRAFT', after: { kind: it.kind, name: it.name, originalMaker: it.maker } }, { ctx });
    } catch (e) {
      await toDraft(it).catch(() => undefined);
      it.result = `RETURNED_TO_DRAFT: ${(e as Error).message?.slice(0, 160) ?? 'publish check failed'}`;
    }
  }
  return { mode: opts.mode, count: items.length, items };
}

async function publish(it: Item) {
  if (it.kind === 'INSURER' || it.kind === 'INSURER_CHANGE') { const i = (await Insurer.findById(it.id).lean<{ version: number }>())!; await approveInsurer(ctx, it.id, { version: i.version }, req, { direct: true }); }
  else if (it.kind === 'TEMPLATE') { const t = (await TemplateVersion.findById(it.id).lean<{ rev: number }>())!; await approveTemplateVersion(ctx, it.id, { rev: t.rev }, req, { direct: true }); }
  else if (it.kind === 'PRODUCT_VERSION') { const v = (await ProductVersion.findById(it.id).lean<{ rev: number }>())!; await adminApprove(ctx, it.id, { rev: v.rev }, req, { direct: true }); }
  else if (it.kind === 'MESSAGE_TEMPLATE') await approveTemplate(ctx, it.id, req, { direct: true });
  else if (it.kind === 'CONFIG_CHANGE') await decideConfigChange(ctx, it.id, true, req, { direct: true });
}
async function toDraft(it: Item) {
  if (it.kind === 'INSURER') await Insurer.updateOne({ _id: it.id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT' }, $inc: { version: 1 } });
  else if (it.kind === 'INSURER_CHANGE') await Insurer.updateOne({ _id: it.id, 'pendingChange.status': 'PENDING' }, { $set: { 'pendingChange.status': 'REJECTED', 'pendingChange.reason': 'Returned for direct publishing (no admin approval)' }, $inc: { version: 1 } });
  else if (it.kind === 'TEMPLATE') await TemplateVersion.updateOne({ _id: it.id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT' }, $inc: { rev: 1 } });
  else if (it.kind === 'PRODUCT_VERSION') await ProductVersion.updateOne({ _id: it.id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT' }, $inc: { rev: 1 } });
  else if (it.kind === 'MESSAGE_TEMPLATE') await MessageTemplate.updateOne({ _id: it.id, status: 'PENDING_APPROVAL' }, { $set: { status: 'DRAFT' } });
  else if (it.kind === 'CONFIG_CHANGE') await ConfigChange.updateOne({ _id: it.id, status: 'PENDING_APPROVAL' }, { $set: { status: 'REJECTED' } });
}