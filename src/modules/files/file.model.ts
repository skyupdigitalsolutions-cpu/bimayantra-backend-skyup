import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * Metadata for an uploaded file. The bytes live in private storage under `storageKey`.
 * Files are never changed or deleted (the BPD stores files with object lock): every update and delete
 * on this collection is refused. A "replaced" document is a NEW file; the record points at the new id.
 */
export const FILE_PURPOSES = ['PROFILE_PHOTO', 'BUSINESS_LOGO', 'KYC_PAN', 'KYC_LICENCE', 'APPOINTMENT_LETTER', 'CUSTOMER_DOCUMENT', 'BROCHURE', 'QUOTATION_PDF', 'POLICY_DOCUMENT', 'ACCOUNT_EXPORT', 'CALL_RECORDING'] as const;
export type FilePurpose = (typeof FILE_PURPOSES)[number];
/** Photos and logos are images only (CFG-126, CFG-127); documents follow CFG-26 and CFG-27. */
export const IMAGE_PURPOSES: readonly FilePurpose[] = ['PROFILE_PHOTO', 'BUSINESS_LOGO'];
/** KYC files: only the owner advisor and SkyUp reviewers (STF, ADM) can open them (P-06). */
export const KYC_PURPOSES: readonly FilePurpose[] = ['KYC_PAN', 'KYC_LICENCE'];

const fileSchema = new Schema(
  {
    _id: { type: String, default: () => newId('fil') },
    accountId: { type: String, required: true },
    uploadedBy: { type: String, required: true },
    purpose: { type: String, enum: FILE_PURPOSES, required: true },
    type: { type: String, enum: ['PDF', 'JPG', 'PNG', 'ZIP', 'AUDIO'], required: true }, // detected from the content
    mime: { type: String, required: true },
    size: { type: Number, required: true },
    sha256: { type: String, required: true },
    name: { type: String, required: true }, // cleaned original file name, for display
    storageKey: { type: String, required: true },
    /** Where the bytes were written. Reads always go there, so changing FILE_STORAGE never orphans old files. */
    backend: { type: String, enum: ['local', 'cloudinary'], default: 'local' },
  },
  { timestamps: { createdAt: true, updatedAt: false }, versionKey: false },
);
fileSchema.index({ accountId: 1, purpose: 1, createdAt: -1 });

const immutable = () => { throw new Error('Files are never changed or deleted.'); };
for (const op of ['updateOne', 'updateMany', 'findOneAndUpdate', 'replaceOne', 'deleteOne', 'deleteMany', 'findOneAndDelete'] as const) {
  fileSchema.pre(op, immutable);
}

export type FileDoc = InferSchemaType<typeof fileSchema> & { _id: string; createdAt: Date };
export const StoredFile = model('StoredFile', fileSchema, 'files');