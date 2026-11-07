# Bimayantra API

Built to **Business Process Document v3.2** (Bimayantra, SkyUp Digital Solutions LLP). Node.js 22, Express 5,
MongoDB (Mongoose), Redis. What changed from the earlier InsureHub build and what is still to build:
`docs/GAP-ANALYSIS-v3.2.md`. File-by-file changes: `CHANGES-v3.2.md`.

## Run locally

```bash
docker compose up -d                 # Redis (cache + queue)
cp .env.example .env                 # then fill the keys below
npm install
npm run seed:admin                   # first SkyUp Admin, from SEED_ADMIN_NAME / SEED_ADMIN_MOBILE
npm run dev                          # http://localhost:4000/v1
```

Generate the secrets in `.env`:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"   # JWT_*_SECRET, OTP_PEPPER
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"      # PII_ENCRYPTION_KEY, PII_HASH_KEY (different)
```

`MONGO_URI` defaults to the database **bimayantra**, so data from the earlier build (database `insurehub`) is untouched.
There are no passwords: sign in on the web console with the seeded mobile number; with `SMS_PROVIDER=dev` the OTP
appears in the console's **SMS inbox** tab.

### MongoDB replica set (transactions)

Records that must be saved together (P-01 account creation, P-14 conversion, audit with its change) use a transaction
when MongoDB is a replica set. A standalone server works for local testing (writes happen in order and the API logs a
warning); production refuses to start without one. To convert the local Windows service:

1. Add to `mongod.cfg`: `replication:` / `  replSetName: rs0`, then restart the MongoDB service.
2. In `mongosh`: `rs.initiate({ _id: 'rs0', members: [{ _id: 0, host: '127.0.0.1:27017' }] })`
3. Use `MONGO_URI=mongodb://127.0.0.1:27017/bimayantra?replicaSet=rs0`

## Tests

```bash
npm test     # 410 tests: unit + integration on a real MongoDB replica set (mongodb-memory-server) and in-memory Redis
TEST_NO_TX=1 npm test   # the same suite as on a standalone MongoDB (no transactions)
```

mongodb-memory-server downloads MongoDB on first run; set `MONGOMS_SYSTEM_BINARY` to use an installed `mongod`
(for example where fastdl.mongodb.org is blocked: `micromamba create -p ./mongoenv -c conda-forge mongodb`, then
`MONGOMS_SYSTEM_BINARY=./mongoenv/bin/mongod npm test`).

## Personal data at rest

Names, mobiles, emails and KYC values are encrypted in MongoDB, field by field, so someone with database access sees
only ciphertext. The API decrypts them and returns plain values; clients change nothing. See `src/lib/pii.ts`.

| Data | How it is stored |
|---|---|
| PAN and Aadhaar | Encrypted (AES-256-GCM, random IV), hidden from queries by default, plus a keyed hash for duplicate checks and a masked copy (XXXXXX1234) for display |
| Names, mobiles, emails (customers, family, leads, users, referral submissions, advisor contact) | Encrypted, deterministic AES-256-GCM: the same value gives the same ciphertext, so sign-in by mobile, duplicate checks and unique rules work. Searched through keyed tokens in `searchIndex` |
| KYC values (name on PAN, licence number, reject note; values read from images) | Encrypted |
| Copies: consents, outbox, calls, OTP challenges and locks, notifications, campaign form answers, idempotency responses, audit snapshots, policy insured and nominees, proposals, quotation snapshots and share recipients | Encrypted |
| Meta, LinkedIn and Google tokens | Encrypted |
| Campaign keys, sign-in tokens, file checksums, referral IPs, OTPs | Hashed |

Keys: `PII_ENCRYPTION_KEY` (encryption) and `PII_HASH_KEY` (search tokens and lookup hashes); separate keys are derived
from each with HKDF. Losing them makes the data unreadable: keep them in the key service and back them up.

Rules for code:
- Query encrypted fields by exact value only (`{ mobile }`, `$in`, `$ne`, `null`, `$exists`); the layer encrypts the
  value for you. A regex on an encrypted field throws `PiiQueryError`. For search boxes use `piiSearch(text, …)`:
  names match when each typed word starts a word of the name, emails by the start of the address or its domain,
  mobiles by CFG-132+ digits anywhere.
- Do not sort in the database by an encrypted field; sort after reading.
- Fields stored as encrypted JSON (`json` kind) are written whole; an update inside one (`'frozen.x'`) throws.
- A new model that holds personal data calls `protect(Model, { fields, search })` after `model(...)`.

Upgrading a database that has plain-text rows (take a backup first; run in a maintenance window, because lookups and
search do not find plain rows until they are migrated):

```bash
npm run db:migrate:encrypt-pii             # dry run: counts per collection
npm run db:migrate:encrypt-pii -- --apply  # encrypt; safe to run again
npm run db:indexes                         # search-token indexes
```

## Conventions every client must follow

| Topic | Rule |
|---|---|
| Sessions (P-02) | Web: HttpOnly cookies set by the API; send `credentials` and a trusted `Origin` on writes. Apps: header `X-Client: app` on verify/refresh returns tokens; then `Authorization: Bearer …` |
| Idempotency (GR-10) | `Idempotency-Key` header (8–128 chars) on create, send and status-change requests. Make it when the form opens, reuse it on Retry. A repeat → 409 `ALREADY_SUBMITTED` (GEN-06) with `details.result` |
| Versions (GR-11) | Send the `version` you loaded on edits and status changes. Stale → 409 `VERSION_CONFLICT` (GEN-05) with `details.current` |
| Warnings | 409 `CONFIRMATION_REQUIRED` with `details.warnings` (LD-03, LD-04, CU-03, CU-21, CU-22). Repeat with `confirm: ["LD-03", …]` to "Save anyway" |
| Step-up OTP (CFG-83) | `POST /auth/step-up/otp`, `POST /auth/step-up/verify` → send `X-Step-Up-Token` with the sensitive request |
| Messages | Success: `meta.messageId` + `meta.message`. Error: `error.code`, `error.messageId`, `error.message`, `error.fields[] {field, messageId, message}`, `error.requestId` |
| Lead sources (change #17) | Send `source` as a stable code (`META_ADS`); labels are still accepted. Responses carry `source` (label) and `sourceCode`. Picker: `GET /reference` `leadSourceOptions` |
| Feature switches | Read `GET /flags` at sign-in; web and mobile show the changed screens from the same values |
| Read-only (GR-33) | Writes from an EXPIRED subscription → 403 `READ_ONLY` (SUB-03) |

## Endpoints (all under `/v1`)

| Area | Endpoints |
|---|---|
| Access (P-01–P-04) | `POST /auth/register/otp`, `/auth/register/verify`, `/auth/login/otp`, `/auth/login/verify`, `/auth/refresh`, `/auth/logout`; `GET /auth/me`, `/auth/sessions`; `DELETE /auth/sessions/:id`; `POST /auth/step-up/otp`, `/auth/step-up/verify`; `POST /auth/mobile/current/otp`, `/current/verify`, `/new/otp`, `/new/verify` |
| Team | `GET/POST /assistants`, `POST /assistants/:id/disable|enable` (P-53); `GET/POST /staff`, `POST /staff/:id/role|disable|enable` (P-48) |
| Leads (P-12–P-14) | `GET /pipelines`; `GET /leads`, `GET /leads/duplicate-check`, `POST /leads`, `GET/PATCH /leads/:id`, `POST /leads/:id/status`, `/contacts`, `/convert` |
| Customers (P-15–P-17, P-19) | `GET /customers`, `/customers/duplicate-check`, `POST /customers`, `GET/PATCH /customers/:id`, `POST /:id/deactivate|reactivate`, `PUT /:id/identity`, `POST /:id/identity/reveal`, `GET/POST /:id/family`, `PATCH /:id/family/:memberId`, `POST /:id/family/:memberId/deactivate|activate`, `GET/POST /:id/consents` |
| Catalogue (P-20–P-25) | SkyUp: `/admin/insurers`, `/admin/types`, `/admin/templates/:id`, `/admin/products`, `/admin/product-versions/:id` (`PUT`, `/submit`, `/approve`, `/reject`, `/use-current-template`), `/admin/approvals`. Advisors and assistants: `GET /products`, `GET /products/:id`; advisor only: `GET/PUT /products/:id/commercials`, `GET /my-products/types`, `GET /my-products/types/:id/template`, `POST /my-products`, `PUT /my-products/:id`, `POST /my-products/:id/status` |
| Feature switches | `GET /flags` (values for the signed-in account); ADM: `GET /admin/flags`, `GET /admin/flags/:key/accounts`, `PUT /admin/flags/:key`, `PUT /admin/flags/:key/accounts/:accountId` (step-up OTP + reason; `enabled: null` clears an account value) |
| SkyUp admin panel (Stage E2) | `GET /admin/dashboard` (STF, ADM); `GET /admin/accounts` (`?view=tabs&tab=&kyc=&plan=&q=` for tab counts), `GET /admin/accounts/:id`, `/subscription`, `/kyc`, `/insurers`, `/wallet`, `/assistants`, `/support-grants`, `/activity?type=`; ADM with OTP: `POST /admin/accounts/:id/plan`, `/suspend` (`reasonCode` and/or `reason`), `/close` (+ `confirmText: "CLOSE"`); `GET /admin/agent-code-flags?view=items&status=`, `POST /admin/agent-code-flags/:id/resolve`; `GET /admin/support-grants?status=`, `POST /admin/support-grants/:id/end`; under a grant: `GET /support/:accountId/overview`, `/leads`, `/quotations`, `/documents`, `/customers`; `GET /notifications?filter=` |
| Catalogue Stage F | Advisor: `GET/POST /my-products/insurers` (private insurer, name only), `POST /my-products/types` (private category); `POST /my-products` and `PUT /my-products/:id` take `variants` (and `ocrJobId`); `data.customFeatures`; brochure reading `POST /my-products/brochure-reading`, `GET /:id`, `PUT /:id/decisions` (`section`: FEATURE, DETAIL, VARIANT, SUGGESTION), `POST /:id/accept-high`, `/result`, `/retry`. `GET /products/:id` returns `variants` and `customFeatures`. SkyUp: `GET/PUT /admin/product-versions/:id/variants`. Best fit results carry `variantId`, `variantName`; choose takes `variantId` |
| Quotations Stage G | Inputs: `variantId`, `typedBasePremium` (2+ people or renewal, rate table), `riderPrices`, `customAddOns`, `benefits`, `discount.preset`; breakdown adds `entryMode`, `calculatedBase`, rider `typed`/`custom`; revisions carry `variantId`; `renewal` (last year vs this year). Comparison options take the same pricing inputs; Choose takes `variantId`. `POST /renewals/:id/renewal-quotation` takes `mode` (SAME_POLICY, NEW_QUOTATION, COMPARISON) and its fields |
| Other | `GET /reference` (CFG lists for screens), `GET /audit` (P-50 view), `/health/live`, `/health/ready` |
| Test tools (`DEV_TOOLS=true`, never production) | `GET/DELETE /dev/sms`, `POST /dev/sms/failing`, `GET/POST /dev/clock`, `GET /dev/config`, `PUT/DELETE /dev/config/:id`, `POST /dev/reset-limits` |

## Layout

```
src/
  config/      env.ts (infrastructure only), cfg.ts (every CFG value with its documented default)
  lib/         messages.ts (Section 21 catalogue), fields.ts (Section 2A validators), errors, response, clock (IST, test clock),
               phone (FLD-01), crypto (PII encryption, OTP hashing), pii (field encryption layer, search tokens), mongo (transactions), pagination, rateCounter, logger, redis
  middleware/  authenticate (cookie/Bearer, per-request session checks, CFG-99), authorize (3.2 matrix, read-only),
               idempotency, validate, errorHandler, requestId
  modules/     accounts, auth (OTP, sessions, step-up, SMS), rbac, users, team, leads, tasks, customers (customers, family,
               consent, identity), audit, reference, dev, health
  scripts/     seed-admin.ts, sync-indexes.ts (run `npm run db:indexes` once per release in production)
tests/         *.int.test.ts (MongoDB replica set) and *.unit.test.ts
```