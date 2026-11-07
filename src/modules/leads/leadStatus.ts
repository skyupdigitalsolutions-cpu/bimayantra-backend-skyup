import type { Role } from '../users/user.model.js';

/** Lead statuses = the pipeline stages (CFG-170). "Quotation" was removed (DEC-02). */
export const LEAD_STATUSES = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP', 'CONVERTED', 'LOST'] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];
export const STATUS_LABEL: Record<LeadStatus, string> = {
  NEW: 'New', CONTACTED: 'Contacted', QUALIFIED: 'Qualified', FOLLOW_UP: 'Follow-up', CONVERTED: 'Converted', LOST: 'Lost',
};

/**
 * Section 4.3 Lead transitions, exactly. Anything not listed is refused with GEN-04 (GR-21).
 *   NEW → CONTACTED, FOLLOW_UP, LOST          CONTACTED → QUALIFIED, FOLLOW_UP, LOST
 *   QUALIFIED → FOLLOW_UP, LOST               FOLLOW_UP → CONTACTED, QUALIFIED, LOST
 *   NEW, CONTACTED, QUALIFIED, FOLLOW_UP → CONVERTED (only through P-14 conversion)
 *   LOST → CONTACTED (reopen, note required)  CONVERTED is final.
 * FOLLOW_UP needs a date; LOST needs a reason (CFG-33).
 */
const MOVES: Record<LeadStatus, readonly LeadStatus[]> = {
  NEW: ['CONTACTED', 'FOLLOW_UP', 'LOST'],
  CONTACTED: ['QUALIFIED', 'FOLLOW_UP', 'LOST'],
  QUALIFIED: ['FOLLOW_UP', 'LOST'],
  FOLLOW_UP: ['CONTACTED', 'QUALIFIED', 'LOST'],
  CONVERTED: [],
  LOST: ['CONTACTED'],
};
export const CONVERTIBLE: readonly LeadStatus[] = ['NEW', 'CONTACTED', 'QUALIFIED', 'FOLLOW_UP'];

export const canMove = (from: LeadStatus, to: LeadStatus) => MOVES[from].includes(to);
/** Marking lost and reopening are advisor-only (Section 3.2: assistants "No"). */
export const advisorOnly = (from: LeadStatus, to: LeadStatus) => to === 'LOST' || from === 'LOST';
const works = (role: Role) => role === 'ADV' || role === 'AST';

/** The moves this caller may make from this status: computed on every read, never stored (AC-P13-1). */
export const allowedMoves = (status: LeadStatus, role: Role): LeadStatus[] =>
  works(role) ? MOVES[status].filter((to) => role === 'ADV' || !advisorOnly(status, to)) : [];
export const canConvert = (status: LeadStatus, role: Role) => works(role) && CONVERTIBLE.includes(status);
