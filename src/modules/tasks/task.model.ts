import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Task (P-11): OPEN → DONE | CANCELLED; DONE → OPEN. Leads keep a single open follow-up task
 * (P-12, P-13, AC-P11-3). General tasks, the Tasks page and DSH-11 reminders: Module 7 (tasks.service, sweep).
 */
export const TASK_TYPES = ['CALL', 'MEETING', 'FOLLOW_UP', 'COLLECT_DOCUMENTS', 'RENEWAL', 'OTHER'] as const;
export const TASK_PRIORITIES = ['HIGH', 'MEDIUM', 'LOW'] as const;

const taskSchema = new Schema(
  {
    _id: { type: String, default: () => newId('tsk') },
    accountId: { type: String, required: true },
    kind: { type: String, enum: ['GENERAL', 'LEAD_FOLLOW_UP'], required: true },
    title: { type: String, required: true },
    /** Change #21: what kind of task (optional on older tasks) and how urgent (Medium unless set). */
    taskType: { type: String, enum: [...TASK_TYPES, null], default: null },
    priority: { type: String, enum: TASK_PRIORITIES, default: 'MEDIUM' },
    dueAt: { type: Date, required: true },
    status: { type: String, enum: ['OPEN', 'DONE', 'CANCELLED'], default: 'OPEN' },
    linkedType: { type: String, enum: ['LEAD', 'CUSTOMER', null], default: null },
    linkedId: { type: String, default: null },
    notes: { type: String, default: null },
    createdBy: { type: String, default: null },
    doneAt: { type: Date, default: null },
    /** The due time a DSH-11 reminder was sent for; a changed due time allows one new reminder (P-11). */
    remindedFor: { type: Date, default: null },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
taskSchema.index({ linkedId: 1 }, { unique: true, partialFilterExpression: { kind: 'LEAD_FOLLOW_UP', status: 'OPEN' }, name: 'one_open_lead_follow_up' });
taskSchema.index({ accountId: 1, status: 1, dueAt: 1 });
export type TaskDoc = InferSchemaType<typeof taskSchema> & { _id: string };
export const Task = model('Task', taskSchema, 'tasks');