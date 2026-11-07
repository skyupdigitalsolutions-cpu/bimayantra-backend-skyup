import { Schema, model, type InferSchemaType } from 'mongoose';
import { newId } from '../../lib/ids.js';

/**
 * A customer's vehicle (P-54). States ACTIVE ↔ INACTIVE (sold or no longer insured, §4). Nothing is deleted:
 * the RC and photos are CustomerDocument versions with this vehicle's id (photos belong to the vehicle,
 * never just to the customer).
 */
export const VEHICLE_TYPES = ['Private car', 'Two-wheeler', 'Commercial vehicle'] as const;
export const FUELS = ['Petrol', 'Diesel', 'CNG', 'Electric', 'Hybrid'] as const;

const vehicleSchema = new Schema(
  {
    _id: { type: String, default: () => newId('veh') },
    accountId: { type: String, required: true },
    customerId: { type: String, required: true },
    registration: { type: String, required: true }, // FLD-35: capitals, no spaces
    vehicleType: { type: String, enum: VEHICLE_TYPES, required: true },
    make: { type: String, required: true },
    model: { type: String, required: true },
    year: { type: Number, required: true },
    fuel: { type: String, enum: FUELS, required: true },
    status: { type: String, enum: ['ACTIVE', 'INACTIVE'], default: 'ACTIVE' },
    createdBy: { type: String, required: true },
    version: { type: Number, default: 1 },
  },
  { timestamps: true, versionKey: false },
);
/**
 * DECISION (OPEN-QUESTIONS Q36): a registration is unique among the account's ACTIVE vehicles, so a vehicle
 * one client sold can be recorded for the client who bought it. The database enforces it (two tabs).
 */
export const VEHICLE_REG_INDEX = 'one_active_registration_per_account';
vehicleSchema.index({ accountId: 1, registration: 1 }, { unique: true, partialFilterExpression: { status: 'ACTIVE' }, name: VEHICLE_REG_INDEX });
vehicleSchema.index({ accountId: 1, customerId: 1, status: 1 });

export type VehicleDoc = InferSchemaType<typeof vehicleSchema> & { _id: string; createdAt: Date };
export const Vehicle = model('Vehicle', vehicleSchema, 'vehicles');