# Bimayantra BPD v3.2 — gap analysis and what this update covers

The code was built against the earlier **InsureHub PRD** (password login, custom roles with OWN/ALL scope, one
shared team). **Business Process Document v3.2** describes **Bimayantra**: a subscription app in which every
advisor has a private account (tenant), everyone signs in with a mobile OTP, and roles are fixed. Modules 01–04
therefore had to be reworked, not patched. This document lists every gap found, what this update closes,
and what is still to build.

## 1. Platform-level changes

| Area | Earlier build | v3.2 requirement | Status in this update |
|---|---|---|---|
| Database | MongoDB | PostgreSQL is a **confirmed** decision (22.1) | **Kept MongoDB by your decision.** Raise with the client (see §6). Unique business rules are MongoDB unique/partial indexes (GR-12); multi-record writes use transactions on a replica set |
| Login | Email/mobile + password, lockout | OTP only, no passwords (P-01–P-04, v3.0 decision) | Done |
| Tenancy | One shared team, OWN/ALL data scope | One account per advisor; every record carries the account ID (GR-20) | Done (accounts, accountId on every record) |
| Roles | Custom roles, 26 permission codes | Fixed roles ADV, AST, REF, STF, ADM, SYS with the 3.2 matrix | Done (roles API removed; assistants P-53 and SkyUp users P-48 added) |
| Lead assignment | ALL-scope users assign leads | No lead assignment in this release (Section 7) | Removed |
| Sessions | 15-min JWT + 30-day refresh, Bearer | HttpOnly cookies (web), idle 30 min, longest 12 h, max 3 sessions (CFG-07–09) | Done; apps use Bearer tokens with `X-Client: app` (17A is not in the PDF) |
| Numbers | Typed in code / env | Every number from the CFG table (1.3, NFR-13) | Done for every value these modules use (`src/config/cfg.ts`) |
| Messages | Free-text errors | Exact message IDs and texts (Section 21, GR-05, 2.5) | Done: every response carries `messageId` + exact text |

## 2. Global rules (Section 2)

| Rule | Status |
|---|---|
| GR-01 server is the judge | Done: all rules enforced in the API, also tested by calling it directly |
| GR-02/03/07 field errors under fields, GEN-02 summary, required marker | Done (API returns `fields[]`; console shows them) |
| GR-04 keep input; only OTP cleared | Done in the console |
| GR-05 a message ID per cause; GEN-99 with reference otherwise | Done |
| GR-06 clean input (trim, collapse spaces, no emoji/control chars, case) | Done in validators |
| GR-08 CFG placeholders show live values | Done (`msg()` fills `{CFG-xx}`) |
| GR-10 idempotency keys | Done: `Idempotency-Key` header on create, send, status-change; replay → 409 `ALREADY_SUBMITTED` (GEN-06) with the saved result |
| GR-11 record versions | Done: `version` on every editable record; stale write → 409 `VERSION_CONFLICT` (GEN-05) with the current record |
| GR-12 duplicates by database rule | Done: open-lead and active-customer partial unique indexes, one open OTP per mobile+purpose, unique mobile per user |
| GR-13/14/15 back, refresh, server drafts | Partly: console keeps forms; **server drafts (long forms) arrive with quotations** |
| GR-16/17 session ends during a form, network loss | Partly: console keeps entries; re-verify dialog not built |
| GR-18 hide controls; GEN-03 / GEN-11 | Done (404 for other accounts' records, never revealing existence) |
| GR-19/21 state machines, GEN-04 | Done for leads, customers, family, consent, users, sessions, OTP |
| GR-20 account isolation | Done |
| GR-22 no physical delete | Done (nothing in these modules deletes) |
| GR-24 money | Wallet balance in integer paise; rest arrives with quotations |
| GR-25 dates/times | Done: UTC stored, IST "today", date-only fields as YYYY-MM-DD |
| GR-26/27 provider isolation and retries | OTP SMS is sent in-request (the user must see AUTH-13). **Job queue (outbox) not built yet** |
| GR-29 plan checks | Done for assistants (P-53); more with Premium features |
| GR-30 audit | Done: who, role, account, record, record number, old/new (masked), result, request ID, step-up ID; append-only |
| GR-31 masking | Done in audit and logs; SkyUp lists show masked mobiles |
| GR-33 read-only mode | Done: EXPIRED subscription → writes refused with SUB-03 |
| GR-34 confirmation dialogs | Done in the console |
| GR-35 paging (CFG-23) | Done |
| GR-36/37 PAN/Aadhaar encryption, masking, consent first | Done (AES-256-GCM per field; keyed hash for duplicate PAN; audited reveal) |
| GR-38 age from DOB | Done |
| GR-39 SkyUp access only via support grant | Refused with SUP-03 and logged; **support grants (P-57) not built** |

## 3. Processes closed in this update

| Process | What was missing | Done |
|---|---|---|
| P-01 Register | Did not exist | OTP registration; account, ADV user, empty profile, TRIAL (no plan), ₹0 wallet and CFG-169 pipelines in one transaction; AUTH-07 / AUTH-08 cases; terms version stored |
| P-02 Log in | Password login | OTP login; order of checks account → user → role; AUTH-09…AUTH-20; INVITED → ACTIVE on first login; read-only notice |
| P-03 Sessions | Partly | Idle CFG-07, longest CFG-08, CFG-09 sessions (oldest ends: AUTH-17), device list, end session (AUTH-22), logout (AUTH-16), refresh rotation with reuse detection, idle warning (AUTH-21) in the console |
| P-04 Change mobile | Did not exist | Two OTPs, AUTH-23/24/25, other sessions end, SMS to the old number |
| Step-up OTP (CFG-83) | Did not exist | `/auth/step-up/*` + `X-Step-Up-Token`; used by P-48 and P-53 |
| P-48 SkyUp users | Generic users/roles admin | STF/ADM only, OTP on every change, ADM-01/02/03, role change ends sessions |
| P-53 Assistants | Did not exist | Plan check (AST-04), seat limit CFG-158 (AST-02), INVITED → ACTIVE, disable ends sessions (AST-03), recent actions |
| P-12 Create lead | Different fields, statuses and rules | Pipelines, LD numbers, alternate mobile, priority, interests, follow-up, referrer / referring client / campaign by source (CFG-133), duplicates LD-02 (blocked) / LD-03 / LD-04 (warnings with "Save anyway"), follow-up task |
| P-13 Work a lead | Provisional transitions incl. QUOTATION; auto-CONTACTED | Exact 4.3 table; FOLLOW_UP needs a date (task created/moved); LOST needs a CFG-33 reason (+note for Other), advisor only; reopen LOST → CONTACTED with note; contact outcomes; stage history; source correction advisor-only and audited |
| P-14 Convert | Only from QUALIFIED/QUOTATION; mobile-unique customers | From any open stage; link or create (CU-02 forces link, CU-03 warns); copies source, referrer and lead consent; cancels follow-up task; LD-10 / LD-11; one transaction |
| P-15 Customers | Mobile globally unique; few fields | CU numbers; name+mobile duplicate rule (CU-02/03); all P-15 fields; CU-21/22 before changing mobile/email (resets consent); PAN/Aadhaar (CU-23, CU-25, CU-29, CU-30) |
| P-16 Family | Did not exist | Roster with CFG-36 relationships, CFG-35 limit (CU-06), duplicates (CU-07), deactivate/activate (CU-19) |
| P-17 Consent | One yes/no flag | Per person × channel (WhatsApp, Email, SMS) + personal-data consent; how given, declaration (VAL-29), exact address, history; CU-11/12/13/14/30 |
| P-19 Deactivate | Did not exist | Reason list, INACTIVE blocks edits (CU-20), reactivate (CU-10). The CU-08 open-items check waits for quotations/payments |
| P-50 Audit (view) | No API | `GET /v1/audit` (ADV own account, STF metadata only, ADM all). CSV export with OTP not built |

## 4. Not built yet (next modules, in build order)

| Next | Processes |
|---|---|
| Advisor profile, KYC, agent codes | P-05, P-06, P-07 (licence expiry SYS-12) |
| Document vault and vehicles | P-18 (versions, labels, OCR verify, object lock), P-54 |
| Default nominee, family links, cover map | rest of P-15 |
| Dashboard, search, notifications, tasks | P-08–P-11 (Tasks page and reminders SYS-07; the lead follow-up task already exists) |
| Insurance catalogue | P-20–P-25, P-58 (maker-checker, price versions SYS-02, OCR P-23) |
| Best-fit ranking | P-26 |
| Quotations and comparisons | P-27–P-30 (server drafts GR-14, snapshots GR-23, expiry SYS-01) |
| Payments and proposals | P-31, P-32, P-55 |
| Policies and nominees | P-33–P-36 |
| Renewals | P-37, P-38 (SYS-03) |
| Communications, WhatsApp, wallet | P-39–P-43, P-56 (job queue, GR-26/27/28) |
| Referral app | P-44–P-46 (REF users; leads already accept "Referred by a referrer") |
| Plans, admin, audit export, account export, support grants | P-47, P-49–P-52, P-57 (SYS-05, SYS-13, SYS-14) |
| System jobs | SYS-01…SYS-15 (only the subscription status is derived from dates until SYS-05 exists) |
| Mobile apps | Section 17A — **not in this PDF** (separate tab) |
| Providers | MSG91 (DLT templates), WhatsApp Cloud API, SES, Document AI, Claude API |

## 5. Choices made where the document is silent (each is one place in code)

- **Trial plan**: 4.3 says TRIAL has plan NORMAL; P-01 says "no plan chosen". Stored as `plan: null`, features per CFG-173.
- **AUTH-08**: P-01 lists REF, STF and ADM; assistants (added in v3.1) are treated the same.
- **Who may work leads/customers**: P-12/P-13/P-15 say "Who: ADV"; the 3.2 matrix says AST "Own". The matrix is followed (P-53 AC-1 agrees). Lost/reopen, source correction, deactivation and PAN reveal are ADV-only.
- **Disabled assistant login message**: not defined; AUTH-11 ("contact the advisor who invited you") is used.
- **Mobile masking**: assistants see full mobiles of their own account (they make the calls); SkyUp lists and logs are masked. Confirm against GR-31.
- **Idempotent replay**: 2.5 says 409; the API returns 409 `ALREADY_SUBMITTED` (GEN-06) with the saved result in `details.result`.
- **Change-mobile window**: not in CFG; the token from the first OTP is valid for 2 × CFG-02.
- **Lead sources with special rules** are recognised by their CFG-133 text ("Referred by a referrer", "Referred by a client", "Campaign"). Renaming them in configuration would break the rules: ask for stable source codes.
- **Insurance interest** uses the CFG-115 type names until the catalogue's insurance types exist.
- **Logging a contact** does not change the lead's version (it is a timeline entry, not an edit).
- The provisional rule "first activity moves NEW to CONTACTED" was **removed**: it is not in v3.2.

## 6. Raise with the client

1. **Database**: 22.1 confirms PostgreSQL; the build uses MongoDB. Either the document changes, or a migration is planned before go-live. Production on MongoDB must be a replica set (the API refuses to start otherwise).
2. **Section 17A** (mobile apps, GR-40–GR-49, CFG-182–188, DEC-26–30) is referenced but missing from this PDF.
3. The open decisions that affect these modules: DEC-07 (one role per mobile), DEC-08 (lost mobile), DEC-10 (consent wording), DEC-12 (retention), DEC-19 (DLT SMS templates), DEC-22 (storing full Aadhaar).
4. The items in §5.
