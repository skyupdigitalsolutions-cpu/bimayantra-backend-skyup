# Module 8 Stage 3b: backend changes

Apply on top of Stage 3a. 219 tests pass with and without transactions (`npm test`, `TEST_NO_TX=1 npm test`).

## Added (1)
- `tests/catalogue-own-products.int.test.ts`: 11 tests (the advisor lookups, the owner's edit round trip, read-only mode, double-submit, the empty-draft fix)

## Changed (5)
- `src/modules/catalogue/types.service.ts`: `ownProductTypes()` and `liveFeatures()`, read-only views for + My product
- `src/modules/catalogue/catalogue.routes.ts`: `GET /my-products/types` and `GET /my-products/types/:id/template` (advisor only, `products.own`); `writable` on own-product create, edit and status and on the commission save (GR-33); `idempotent()` on the own-product status change (GR-10)
- `src/modules/catalogue/products.service.ts`: `insurerId` and `typeId` on the advisor list and product; `publishedVersion.templateId`; `publishedVersion.entered` on own products (the values as typed, for editing); a new draft returns `data: {}` instead of no `data`
- `README.md`: catalogue endpoints; test count
- `OPEN-QUESTIONS.md`: Q41 to Q43

## What clients must change
- `POST /my-products/:id/status` now needs an `Idempotency-Key` header (400 GEN-01 without one), like every other status change.
- An EXPIRED (read-only) account now gets 403 `READ_ONLY` SUB-03 on own-product writes and on the commission save.
- To edit an own product, start from `publishedVersion.entered`, not `publishedVersion.data`: `data` shows "Not stated by insurer" as text (AC-P22-5), and saving that would store the text as the value.