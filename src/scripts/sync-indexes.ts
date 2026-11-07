/**
 * Builds every index (unique business rules included, GR-12) and drops indexes left from older versions.
 * Run once per release in production (autoIndex is off there), and whenever the API warns about stale indexes.
 * Importing the app registers every model, so no module can be missed as the code grows.
 */
import mongoose from 'mongoose';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import '../app.js';

await connectMongo();
for (const name of mongoose.modelNames().sort()) {
  const dropped = await mongoose.model(name).syncIndexes();
  console.log(`${name}: indexes in sync${dropped.length ? ` (dropped ${dropped.join(', ')})` : ''}`);
}
await disconnectMongo();