import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * One uploaded VERSION of a customer document (P-18). Never deleted or replaced: a re-upload of the same
 * type for the same person adds version n+1 (DOC-03). Read and confirmed values of identity documents
 * are stored encrypted (GR-31). Label changes are separate rows (DocumentLabel) pointing at the version.
 */
export const VERIFY_TYPES = ['Aadhaar', 'PAN', 'Old policy'] as const;
/** Added from the vehicle screen (P-54), not from the general Add document screen. */
export const VEHICLE_TYPES = ['Vehicle RC', 'Vehicle photo'] as const;

const documentSchema = new Schema(
  {
    _id: { type: String, default: () => newId('doc') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    personKey: { type: String, required: true }, // C:<customer id> or F:<family member id>
    accountDocumentTypeId: { type: String, default: null }, // change #25: an "Other" name saved for the account
    type: { type: String, required: true }, // CFG-171 name
    name: { type: String, default: null }, // FLD-37, only for type Other
    /** Identifies the versioned series: customer + person + type (+ name for Other, + vehicle/slot for vehicles). */
    seriesKey: { type: String, required: true },
    version: { type: Number, required: true },
    fileId: { type: String, required: true },
    originalName: { type: String, required: true }, // the upload's file name, kept forever
    label: { type: String, required: true },
    labelKey: { type: String, required: true }, // lowercased, for DOC-06
    status: { type: String, enum: ['UNCONFIRMED', 'CONFIRMED'], required: true },
    /** P-18 step 5, GR-26: reading runs in the background after the save. OFF when no reader is set up. */
    readStatus: { type: String, enum: ['OFF', 'PENDING', 'DONE', 'FAILED'], default: 'OFF' },
    readStartedAt: { type: Date, default: null },
    readValuesEnc: { type: String, default: null, select: false }, // what the reader returned (encrypted JSON)
    confirmedValuesEnc: { type: String, default: null, select: false }, // what the user confirmed (encrypted JSON)
    confirmedAt: { type: Date, default: null },
    confirmedBy: { type: String, default: null },
    vehicleId: { type: String, default: null }, // P-54
    slot: { type: String, default: null }, // P-54 photo slot
    uploadedBy: { type: String, required: true },
    rev: { type: Number, default: 1 }, // concurrency for confirm and label changes
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
/** Two uploads of the same series at the same moment cannot both become version n. */
documentSchema.index({ accountId: 1, seriesKey: 1, version: 1 }, { unique: true, name: 'one_version_number_per_series' });
documentSchema.index({ accountId: 1, customerId: 1, createdAt: -1 });
documentSchema.index({ accountId: 1, customerId: 1, labelKey: 1 });
documentSchema.index({ vehicleId: 1 }, { partialFilterExpression: { vehicleId: { $type: 'string' } } });

const refuse = () => { throw new Error('Documents cannot be deleted.'); };
for (const op of ['deleteOne', 'deleteMany', 'findOneAndDelete'] as const) documentSchema.pre(op, refuse);

export type DocumentDoc = InferSchemaType<typeof documentSchema> & { _id: string; createdAt: Date };
export const CustomerDocument = model('CustomerDocument', documentSchema, 'documents');

/** P-18 step 8: each label change is its own row, so the history shows the original name and every change. */
const labelSchema = new Schema(
  {
    _id: { type: String, default: () => newId('dlb') },
    accountId: { type: String, required: true },
    documentId: { type: String, required: true },
    from: { type: String, required: true },
    to: { type: String, required: true },
    by: { type: String, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
labelSchema.index({ documentId: 1, createdAt: 1 });
export type LabelDoc = InferSchemaType<typeof labelSchema> & { _id: string; createdAt: Date };
export const DocumentLabel = model('DocumentLabel', labelSchema, 'document_labels');