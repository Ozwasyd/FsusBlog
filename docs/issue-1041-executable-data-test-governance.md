# Issue #1041 executable data test governance

Issue #1041 replaces source-shape assertions for recovery-key throttling, site subscriptions, and local demo seed data with tests that execute the production service, endpoint handler, cache contract, and PostgreSQL schema.

## Reduction summary

| Scope | Previous tests | Current test methods | Current expanded cases | Primary evidence |
| --- | ---: | ---: | ---: | --- |
| Recovery Key limiter | 3 | 4 | 4 | production service, controlled expiring counter, PostgreSQL |
| Subscription | 5 | 5 | 8 | production endpoint/service, PostgreSQL, TestServer |
| Demo seed | 4 | 1 | 1 | production entity schema and actual `psql` seed file |
| Total | 12 | 10 | 13 | observable behavior and persisted data |

The three historical filenames remain so ownership stays discoverable, but none of them now treats SQL fragments, cache method names, documentation wording, or shell output as the primary proof.

## Executable evidence

### Recovery Key limiter

- Attempts one through seven return the same generic invalid result; attempt eight returns the stable rate-limited result.
- A controlled clock expires the ten-minute counter window and the next failure starts again at one.
- Thirty-two requests cross the pre-check together and exercise an atomic counter; all thirty-two increments are retained.
- After reaching the threshold, the test drops `account_recovery_key` before the next request. A rate-limited response without a database exception proves credential lookup did not occur.
- Existing and missing lookup IDs return the same code and message, and cache identities contain neither lookup IDs nor secrets.

### Site subscription

- Two normalized subscribe requests against PostgreSQL retain exactly one active row.
- The persisted email hash is compared with an independently computed HMAC, differs from bare SHA-256, and carries `hmac-v1`.
- Missing, expired, wrong-email, and wrong-channel proofs all return 428 and leave the live row enabled.
- Dropping `site_subscription` after proof validation forces a real mutation failure; the proof remains present and uncommitted.
- A successful mutation disables the row, commits the proof once, and a replay returns 428.
- A minimal TestServer invokes the production binary handler and decodes stable 428 precondition and 400 validation AEDS error frames.

### Demo seed

- A fresh database receives the relevant production entity tables with no application rows.
- `tools/dev/demo-seed.sql` is executed by `psql`, then executed a second time through the same path.
- Both snapshots contain one anonymous account container, one separate disabled non-root admin principal, two categories, four tags, two articles and bodies, four article-tag edges, two comments, and two audit events.
- Database inspection rejects legacy username, password, role, and login-IP columns and confirms that the demo admin is not a `sys_user` row and has no Passkey credential.
- Joins prove category, tag, article, body, and comment references are valid. Both comments retain anonymous privacy fields while keeping `user_id` and `public_handle` null.

Documentation prose and shell echo text are intentionally maintained by documentation/static governance, not by xUnit substring tests.

## Retention replacement ownership

`tests/test-retention-replacements.json` maps all twelve removed test IDs to the ten current behavior methods. The central historical-residue checker remains a secondary replacement for the removed password-seed residue assertion; all other replacements point to production-object or PostgreSQL behavior.

## Mutation expectations

The existing full backend Stryker `Services/**/*.cs` scope covers `RecoveryKeyService` and `SiteSubscriptionProofService`. Endpoint and seed invariants are retained by executable PostgreSQL/TestServer coverage without widening the nightly mutation scope.

| Mutation | Required failing evidence |
| --- | --- |
| Change limiter threshold or generic/rate-limited result | threshold and expiry behavior |
| Replace atomic increment with a read/write pair | concurrent no-loss behavior |
| Move lookup before the lock check | dropped-table locked-identity behavior |
| Expose credential existence | existing-versus-missing response equivalence |
| Remove upsert uniqueness, HMAC, or `hash_version` | repeated subscribe persistence behavior |
| Consume proof before mutation or allow replay | failure-uncommitted and success-once behavior |
| Change 428/400 endpoint mapping | TestServer AEDS error-frame behavior |
| Make seed non-repeatable or reintroduce legacy identity data | double execution and database residue assertions |
| Break taxonomy/comment relations or privacy fields | joined seed-data invariants |

## Matrix handoff

The following central files were under active ownership elsewhere while #1041 was implemented and must be updated by that owner without overwriting concurrent work:

- `tests/backend/Fixtures/backend-test-requirements.json`
    - add `RecoveryKeyAttemptLimiterContractTests.cs` to `BACKEND-FAKE-CLOCK`, `BACKEND-CONCURRENCY-RACES`, and `BACKEND-SECURITY-MATRIX` evidence;
    - add `SubscriptionEndpointsContractTests.cs` to `BACKEND-WEBAPPLICATIONFACTORY`, `BACKEND-TRANSACTIONS`, `BACKEND-IDEMPOTENCY`, and `BACKEND-SECURITY-MATRIX` evidence;
    - add `DevSeedSqlContractTests.cs` to `BACKEND-IDEMPOTENCY`, `BACKEND-MIGRATION-FAILURE-DRILLS`, and `BACKEND-SECURITY-MATRIX` evidence;
    - add the subscription file to the `backend-api-integration` profile and the recovery file to the `backend-concurrency` profile.
- `tests/matrix.yml`
    - add the subscription file to `backend-api-integration.evidence`;
    - add the recovery file to `backend-concurrency.evidence`;
    - keep all three files covered by `backend-unit` and production/nightly dependency closure.
- `tests/coverage-registry.json`
    - include the three behavior files under backend endpoint/security/concurrency coverage ownership without adding duplicate coverage IDs.
- `tools/test/lanes/static-governance.sh`
    - no new source-shape check is required; if an evidence-path allowlist is present, include the three behavior files only.

No test, build, lint, restore, syntax check, or other validation was run while preparing this change. Later acceptance evidence must be generated from the final merged source state for backend unit, integration, security, API integration, concurrency, mutation, retention, and production fresh tiers.
