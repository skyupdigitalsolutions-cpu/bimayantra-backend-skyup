/**
 * Import the catalogue workbook (insurers, feature templates, products, product features, add-ons). Dry run unless
 * --apply; --publish also publishes every product that passes the normal publish checks.
 *   npm run catalogue:import -- "D:\data\bimayantra-catalogue-demo.xlsx"                     # report only
 *   npm run catalogue:import -- "D:\data\bimayantra-catalogue-demo.xlsx" --apply --publish   # write and publish
 * In PowerShell, quote the separator: npm run catalogue:import '--' "D:\…xlsx" --apply --publish
 * (if npm still swallows the flags, they arrive as npm_config_apply / npm_config_publish and are honoured too).
 */
import { existsSync } from 'node:fs';
import { connectMongo, disconnectMongo } from '../lib/mongo.js';
import { importCatalogue, readCatalogue } from '../modules/catalogue/catalogueImport.js';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`) || process.env[`npm_config_${name}`] === 'true';
const file = args.find((a) => !a.startsWith('--'));
if (!file || !existsSync(file)) {
  console.error(`Workbook not found: ${file ?? '(none given)'}\nUsage: npm run catalogue:import -- <path-to.xlsx> [--apply] [--publish]`);
  process.exit(1);
}
const apply = flag('apply');
const publish = flag('publish');
await connectMongo();
const report = await importCatalogue(await readCatalogue(file), { apply, publish });
console.log(JSON.stringify(report, null, 2));
console.log('\nTotals:', JSON.stringify(report.totals));
if (!apply) console.log('\nDry run: nothing was written. Run again with --apply (and --publish to publish complete products).');
await disconnectMongo();