import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * P-24 price versions. owner = an advisor's account ID (their private price) or 'SKYUP' (the reference price of
 * a verified product, which advisors can copy). Dates are IST days (YYYY-MM-DD). No approval is needed.
 * Which version applies is worked out from the dates when it is read (the version covering IST today), so a
 * SCHEDULED price starts on its day even if SYS-02 missed midnight.
 */
const priceSchema = new Schema(
  {
    _id: { type: String, default: () => newId('prc') },
    owner: { type: String, required: true }, // accountId, or 'SKYUP'
    productId: { type: String, required: true },
    number: { type: Number, required: true }, // v1, v2, … per owner and product
    templateId: { type: String, required: true }, // whose rating factors the rows follow
    effectiveFrom: { type: String, required: true },
    effectiveTo: { type: String, default: null }, // null = open
    cancelled: { type: Boolean, default: false },
    /** true while this is the one version without an end date (database rule below); null once closed or cancelled. */
    open: { type: Boolean, default: true },
    taxPercent: { type: Number, required: true },
    rows: { type: [new Schema({ factors: { type: Schema.Types.Mixed, required: true }, basePremium: { type: Number, required: true } }, { _id: false, minimize: false })], default: [] },
    riderPrices: { type: [new Schema({ name: String, value: Number }, { _id: false })], default: [] },
    sourceNote: { type: String, default: null },
    createdBy: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
);
priceSchema.index({ owner: 1, productId: 1, number: 1 }, { unique: true });
/** Exactly one version per owner and product has no end date (P-24 backend rule, AC-P24-3). */
priceSchema.index({ owner: 1, productId: 1, open: 1 }, { unique: true, partialFilterExpression: { open: true }, name: 'one_open_price' });
priceSchema.index({ owner: 1, productId: 1, effectiveFrom: 1 });
export type PriceDoc = InferSchemaType<typeof priceSchema> & { _id: string; createdAt: Date };
export const PriceVersion = model('PriceVersion', priceSchema, 'price_versions');