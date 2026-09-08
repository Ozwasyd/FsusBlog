# Passkey test governance and retention mapping

This document records the reduced Passkey-test boundary from GitHub issue #1044, the WebAuthn counter state-machine behavior added by #1181, and #2331's migration of pseudo registration capacity to real PostgreSQL completion. The goal is to remove C# record/constructor compiler-semantic assertions and private SQL source-shape assertions while retaining cache security, anonymous-account metadata, random-handle ownership, atomic registration capacity, entity mapping, counter classification, and PostgreSQL concurrency behavior.

## Before / after

The count covers `tests/backend/Unit/PasskeyServiceTests.cs` and separately its PostgreSQL replacement owner `PasskeySignCountConcurrencyTests.cs`. Each Theory data row counts as one expanded case.

| Metric | Before | After | Change |
| ------ | -------- | ------- | ------ |
| `PasskeyServiceTests` test methods | 33 | 9 | -24 (-72.7%) |
| `PasskeyServiceTests` expanded cases | 39 | 20 | -19 (-48.7%) |
| `PasskeyServiceTests` lines | 560 | 168 | -392 (-70.0%) |
| Test methods including `PasskeySignCountConcurrencyTests` | 37 | 14 | -23 (-62.2%) |
| Total lines in both files | 809 | 592 | -217 (-26.8%) |

## Retention replacement

The machine-readable per-test-ID declaration is [`tests/test-retention-replacements.json`](../tests/test-retention-replacements.json). Its semantic mapping is:

| Removed or merged old evidence | Current owner | Retention reason |
| -------------------- | ------------ | ---------- |
| `CachePolicyId_PasskeyValues_AreDistinct` | two stable numeric-value tests | The exact persistence contract for `24` and `25` already implies distinctness |
| 8 fragment methods for registry presence, `SecurityCritical`, L1/L2 TTL, jitter, tags, domain, and resource | `CachePolicyRegistry_PasskeyPolicies_PreserveSecurityContract` | The two policy IDs are data rows in one table-driven theory, retaining every original assertion |
| Two independent registration/authentication-key methods | `CachePolicy_PasskeyChallenge_BuildKeyUsesPolicyDomainAndResource` | One theory locks both complete keys |
| Two empty/whitespace-identity methods | `CachePolicy_PasskeyChallenge_EmptyIdentityNormalizesToDefault` | Both inputs are rows in one normalization theory |
| 4 metadata fragment methods | `BuildAnonymousSafeMetadata_MapsAccountLabelsAndPreservesStoredRandomHandle` | Directly calls the real metadata mapping, covering anonymous fallback, public-handle trim, legacy isolation, and defensive copy |
| Stored random-handle ownership and internal-account-ID source search | `CredentialOwnership_AcceptsStoredRandomHandleAndRejectsInternalAccountIdDerivation` | Directly verifies stored-handle success, `BitConverter.GetBytes(accountId)` failure, and missing-handle failure |
| `PasskeyRegistrationLimitRace_StopsAtConfiguredLimit` and test-local `BoundedCredentialSet` | The capacity, full-account, and credential-ID-conflict PostgreSQL owners in `PasskeyRegistrationProjectionIntegrationTests` | Real `PasskeyService` completion serializes same-account capacity decisions with the account row lock, while proving different accounts do not lock each other and projection/read model/cache and response stay consistent |
| Private POD/model/service source reads for Passkey begin | `PodBinaryCodecTests.PasskeyRegisterBegin_RoundTrip_PreservesOptions` + metadata behavior + stable-handle race | Observable behavior owners cover wire, label, and concurrent persistence |
| `PasskeyCredential.AccountId` and legacy `UserId` source search | `PasskeyCredential_UsesAccountIdColumnAndIndexWithoutLegacyUserId` | Reflection locks the real entity column/index without depending on service-local variable names |
| Optimistic sign-count SQL/private-helper shape | `PasskeySignCountConcurrencyTests.UserPasskeySignCount_ConcurrentStaleRowVersionAllowsOnlyOneUpdate` | Of two PostgreSQL stale writers, only one succeeds and the final count is the new value |
| signCount boolean source shape and clone wording | classifier matrix + `PasskeyCounterRollbackIntegrationTests` | Observable behavior covers `0 -> 0`, monotonic advance, non-monotonic risk, default session isolation, and explicit account response |
| Treating every CAS conflict as rollback | `PasskeySignCountConcurrencyTests.UserPasskeyAssertion_ConcurrentCasConflictReloadsWithoutCloneResponse` | Two verified assertions competing on a stale rowVersion converge safely; the final counter is monotonic and no Session is revoked |
| Stable-handle `FOR UPDATE`/SQL shape | `PasskeySignCountConcurrencyTests.StablePasskeyUserHandle_ConcurrentFirstRegistrationReturnsOneFinalHandle` | Two real service/DB concurrent initializations produce the same final persisted handle |
| Last-credential delete SQL/private-helper shape | `PasskeySignCountConcurrencyTests.RemoveCredentialAsync_ConcurrentDeletesKeepOnePasskeyWithoutRecovery` | Two concurrent public service deletes allow only one success; the final credential and flag remain safe |
| 6 `PasskeyCredentialSummaryDto_*` constructor/record tests | `PodBinaryCodecTests.PasskeyCredentialList_RoundTrip_PreservesCredentials` | Real AEDS list round-trip preserves nullable fields, ID, time, and both backup flags; record equality is no longer a business contract |

## Mutation evidence ownership

The table declares each mutation target, the behavioral test that must kill it, and the failure signal. The current issue phase lands code only and runs neither mutation nor other validation by task constraint; later unified verification must bind results to the current source state and write them to release evidence. This document pre-fills no success status.

| Mutation target | Evidence owner | Expected failure signal |
| ----------------- | ---------------- | -------------- |
| Change the Passkey cache-policy numeric ID | two stable numeric-value tests | Exact integers differ |
| Disable `SecurityCritical` or change TTL/jitter/tags/domain/resource | consolidated policy theory | The corresponding policy-row assertion fails |
| Remove identity trim/default normalization | key-normalization theory | An empty/whitespace key no longer equals `...:default` |
| Restore internal ID/username labels in metadata or return the caller's byte array directly | metadata theory | Label, handle content, or defensive-copy assertion fails |
| Let credential ownership accept account-ID-derived bytes | ownership behavior | The negative case becomes true |
| Restore `UserId`/the old entity column/index | entity reflection contract | Property, column, or index assertion fails |
| Restore transaction-outside count-then-insert for registration capacity or remove the account-level PostgreSQL row lock | registration-capacity PostgreSQL race | Two different credential completions at `MaxCredentialsPerUser-1` succeed together, the final count exceeds the limit, or projection/cache side effects duplicate |
| Remove concurrent serialization from stable-handle initialization | stable-handle PostgreSQL race | Returned and persisted values differ |
| Remove the stale-row guard from sign-count updates | sign-count PostgreSQL race | Both writers succeed or the final count is abnormal |
| Restore `0 -> 0` as a risk, split login and step-up, or revoke every account Session by default | counter classifier + integration state machine | Classification, success result, audit response action, or Session mock assertion fails |
| Do not reread on CAS conflict or falsely report a clone | concurrent assertion PostgreSQL race | Both assertions cannot safely complete, the final counter is not the maximum, or Session revoke occurs |
| Remove transaction protection from last-credential deletion | concurrent public delete race | Both deletes succeed or the remaining count becomes 0 |

## Unified verification entry point

Later verification must cover auth/security focused tests, `Category=Concurrency` PostgreSQL tests, backend unit tests, retention audit, the critical mutation slice, and a completely fresh production tier. A result qualifies as #1044 completion evidence only after binding it to the current commit, worktree fingerprint, and the same production run ID.
