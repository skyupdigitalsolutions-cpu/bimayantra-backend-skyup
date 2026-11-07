import { cfgNum } from '../../config/cfg.js';
import { AppError } from '../../lib/errors.js';
import { msg } from '../../lib/messages.js';
import { piiSearch } from '../../lib/pii.js';
import { Customer, FamilyMember } from '../customers/customer.model.js';
import { Lead } from '../leads/lead.model.js';
import type { AuthContext } from '../rbac/capabilities.js';

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Global search (P-09). Only inside the advisor's account. Names, emails and mobiles are encrypted, so they match
 * through keyed search tokens (lib/pii.ts): every typed word starts a word of the name (ignoring case and accents),
 * the start of an email or its domain, or CFG-132+ digits anywhere in a mobile number. Reference numbers (LD-,
 * CU-; QT-, CQ-, PL- arrive with their modules) are plain and match anywhere. Inactive records are included.
 * Results come in the P-09 group order, up to CFG-25 in total.
 */
export async function search(ctx: AuthContext, raw: string) {
  const text = raw.trim();
  const min = cfgNum('CFG-24');
  if (text.length < min) throw AppError.field('q', 'DSH-02', { 'CFG-24': min }); // AC-P09-1
  const total = cfgNum('CFG-25');
  const acc = { accountId: ctx.accountId };
  const like = new RegExp(escape(text), 'i');
  const minDigits = cfgNum('CFG-132');
  const anyOf = () => ({ $or: [{ number: like }, ...piiSearch(text, { name: true, email: true, mobile: minDigits })] });

  // Gap fix: quotations (QT- number or the customer's name/mobile) and policies (policy number, product or customer)
  const { Quotation } = await import('../quotations/quotation.model.js');
  const { Policy } = await import('../policies/policy.model.js');
  const matchedCustomers = await Customer.find({ ...acc, $or: piiSearch(text, { name: true, mobile: minDigits }).concat([{ _id: null }]) }, { _id: 1 }).limit(200).lean<Array<{ _id: string }>>();
  const cusIds = matchedCustomers.map((c) => c._id);
  const [leads, customers, family, quotes, pols] = await Promise.all([
    Lead.find({ ...acc, ...anyOf() }, { number: 1, name: 1, mobile: 1, status: 1 }).sort({ updatedAt: -1 }).limit(total + 1).lean(),
    Customer.find({ ...acc, ...anyOf() }, { number: 1, name: 1, mobile: 1, status: 1 }).sort({ updatedAt: -1 }).limit(total + 1).lean(),
    FamilyMember.find({ ...acc, $or: piiSearch(text, { name: true, mobile: minDigits }).concat([{ _id: null }]) }, { name: 1, relationship: 1, customerId: 1, status: 1 }).limit(total + 1).lean(),
    Quotation.find({ ...acc, $or: [{ number: like }, { customerId: { $in: cusIds } }] }, { number: 1, status: 1, customerId: 1 }).sort({ updatedAt: -1 }).limit(total + 1).lean<Array<{ _id: string; number: string | null; status: string; customerId: string }>>(),
    Policy.find({ ...acc, $or: [{ policyNumber: like }, { productName: like }, { customerId: { $in: cusIds } }] }, { policyNumber: 1, productName: 1, status: 1, customerId: 1 }).sort({ updatedAt: -1 }).limit(total + 1).lean<Array<{ _id: string; policyNumber: string | null; productName: string | null; status: string; customerId: string }>>(),
  ]);
  const familyCustomers = new Map((await Customer.find({ _id: { $in: [...family.map((f) => f.customerId), ...quotes.map((q) => q.customerId), ...pols.map((p) => p.customerId)] }, ...acc }, { name: 1, number: 1 }).lean()).map((c) => [c._id, c]));

  const groups = [
    { group: 'LEADS', items: leads.map((l) => ({ type: 'LEAD', id: l._id, title: l.name, subtitle: `${l.number} · ${mask(l.mobile)}`, status: l.status, open: { type: 'LEAD', id: l._id } })) },
    { group: 'CUSTOMERS', items: customers.map((c) => ({ type: 'CUSTOMER', id: c._id, title: c.name, subtitle: `${c.number} · ${mask(c.mobile)}`, status: c.status, open: { type: 'CUSTOMER', id: c._id } })) },
    // A family member opens their customer's Family tab (P-09 step 4).
    { group: 'FAMILY_MEMBERS', items: family.map((f) => {
      const c = familyCustomers.get(f.customerId);
      return { type: 'FAMILY_MEMBER', id: f._id, title: f.name, subtitle: `${f.relationship} of ${c?.name ?? ''} (${c?.number ?? ''})`, status: f.status, open: { type: 'CUSTOMER', id: f.customerId, tab: 'family' } };
    }) },
    { group: 'QUOTATIONS', items: quotes.map((q) => ({ type: 'QUOTATION', id: q._id, title: q.number ?? 'Draft quotation', subtitle: familyCustomers.get(q.customerId)?.name ?? '', status: q.status, open: { type: 'QUOTATION', id: q._id } })) },
    { group: 'POLICIES', items: pols.map((p) => ({ type: 'POLICY', id: p._id, title: p.policyNumber ?? p.productName ?? 'Policy', subtitle: [p.productName, familyCustomers.get(p.customerId)?.name].filter(Boolean).join(' · '), status: p.status, open: { type: 'POLICY', id: p._id } })) },
  ];
  // Up to CFG-25 in total, filled in group order; "See all" shows when a group was cut.
  let left = total;
  const out = groups.map((g) => {
    const shown = g.items.slice(0, Math.max(0, left));
    left -= shown.length;
    return { group: g.group, items: shown, more: g.items.length > shown.length };
  });
  const count = out.reduce((n, g) => n + g.items.length, 0);
  return { text, groups: out, count, ...(count === 0 ? { messageId: 'DSH-03', message: msg('DSH-03', { text }) } : {}) };
}

/** Results never show a full mobile number in the list: last 4 digits only. */
const mask = (m: string) => `XXXXXX${m.slice(-4)}`;