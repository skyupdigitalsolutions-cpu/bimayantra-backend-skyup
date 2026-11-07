import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/** Change #25: a document name typed under "Other", saved so the account can pick it again. Unique per account, any case. */
const schema = new Schema(
  {
    _id: { type: String, default: () => newId('adt') },
    accountId: { type: String, required: true },
    name: { type: String, required: true, maxlength: 80 },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
schema.index({ accountId: 1, name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 }, name: 'doc_type_name_per_account' });
export type AccountDocumentTypeDoc = InferSchemaType<typeof schema> & { _id: string };
export const AccountDocumentType = model('AccountDocumentType', schema, 'account_document_types');