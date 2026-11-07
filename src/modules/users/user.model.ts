import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';
import { STORED_MOBILE } from '../../lib/phone.js';
import { protect } from '../../lib/pii.js';

export const ROLES = ['ADV', 'AST', 'REF', 'STF', 'ADM'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  ADV: 'Advisor', AST: 'Assistant', REF: 'Referrer', STF: 'SkyUp Staff', ADM: 'SkyUp Admin',
};
export const USER_STATUSES = ['INVITED', 'ACTIVE', 'DISABLED'] as const;

/** User (4.1): name, mobile, role, status. ADV, AST and REF belong to an account; STF and ADM to SkyUp. */
const userSchema = new Schema(
  {
    _id: { type: String, default: () => newId('usr') },
    accountId: { type: String, default: null },
    role: { type: String, enum: ROLES, required: true },
    name: { type: String, required: true },
    mobile: { type: String, required: true, match: STORED_MOBILE },
    status: { type: String, enum: USER_STATUSES, required: true },
    invitedBy: { type: String, default: null },
    invitedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
    disabledAt: { type: Date, default: null },
    lastLoginAt: { type: Date, default: null },
    /** Change #57: optional, SkyUp users only (shown on the add-user form). */
    email: { type: String, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);

// Mobile unique across all users (4.1); one role per mobile (DEC-07).
/** One role per mobile (DEC-07). Callers check this exact index name when they catch a duplicate. */
export const USER_MOBILE_INDEX = 'mobile_1';
userSchema.index({ mobile: 1 }, { unique: true, name: USER_MOBILE_INDEX });
// One advisor owns each account.
userSchema.index({ accountId: 1 }, { unique: true, partialFilterExpression: { role: 'ADV' }, name: 'one_advisor_per_account' });
userSchema.index({ accountId: 1, role: 1 });

export type UserDoc = InferSchemaType<typeof userSchema> & { _id: string; createdAt: Date; updatedAt: Date };
export const User = model('User', userSchema, 'users');
/** Encrypted in the database (lib/pii.ts). Mobile is deterministic, so sign-in lookups and the unique rule still work. */
protect(User, { fields: { name: 'name', mobile: 'mobile', email: 'email' } });