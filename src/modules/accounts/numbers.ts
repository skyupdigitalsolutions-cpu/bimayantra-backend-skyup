import type { ClientSession } from 'mongoose';
import { istToday } from '../../lib/clock.js';
import { Account } from './account.model.js';

/**
 * Reference numbers (Section 4.2), given by the server when the record is first saved, per account,
 * never reset: Lead LD-YYMM-NNNNN, Customer CU-NNNNNN. Inside a transaction a rolled-back save
 * also rolls back the counter.
 */
export async function nextNumber(accountId: string, kind: 'lead' | 'customer' | 'quotation' | 'comparison' | 'proposal', session: ClientSession | null): Promise<string> {
  const acc = await Account.findOneAndUpdate({ _id: accountId }, { $inc: { [`counters.${kind}`]: 1 } }, { new: true, session, projection: { counters: 1 } }).lean();
  if (!acc) throw new Error(`Account ${accountId} not found`);
  const n = acc.counters![kind];
  if (kind === 'customer') return `CU-${String(n).padStart(6, '0')}`;
  const today = istToday();
  if (kind === 'quotation') return `QT-${today.slice(0, 4)}${today.slice(5, 7)}-${String(n).padStart(5, '0')}`; // QT-YYYYMM-NNNNN
  if (kind === 'proposal') return `PR-${today.slice(0, 4)}${today.slice(5, 7)}-${String(n).padStart(5, '0')}`; // PR-YYYYMM-NNNNN (CFG-177)
  if (kind === 'comparison') return `CQ-${today.slice(0, 4)}${today.slice(5, 7)}-${String(n).padStart(5, '0')}`; // CQ-YYYYMM-NNNNN
  return `LD-${today.slice(2, 4)}${today.slice(5, 7)}-${String(n).padStart(5, '0')}`;
}