# PerceptionCharacterV3 release validation v1

## Metadata and decision

- Issue: `#1369`; report schema/version: `fsusblog.release-validation.v1`.
- Code release candidate: FsusBlog `74dc0ddfc57235a65107f8081ae785d34d07c329` (tree `9c7194efdd44995670644e860fc0d25904ba9909`).
- Presentation dependency: FsusUI `006ef81f6bfebd7904a2b384ea6b86c36a0c3b81`, package version `1.5.1`.
- Protocol: `fsu.challenge/perception-character-raster@v3`, wire protocol byte `3`.
- Validation window: 2026-07-20 through 2026-07-21 UTC; .NET SDK `10.0.108`, Node `v24.16.0`, npm `11.13.0`, Redis 7 Alpine, Playwright `1.59.1`, Chromium.
- Decision: **PASS**. Both receipts target the exact same candidate SHA, the independent reviewer did not implement the reviewed path, no unresolved critical/high/medium-confidence finding remains, and the final isolated atomic release-fence dry run passed.

This report is an evidence-only commit layered after the immutable code candidate. It does not change the candidate, activate the protocol, publish a package, create a tag, or perform a release.

## Roles and independence

| Receipt | Role | Implemented reviewed path | Independent expected-result rule |
|---|---|---:|---|
| Primary | Implementer clean-checkout verifier | yes | regression/reference vectors allowed |
| Second pass | Independent QA/reviewer | no | did not call production renderer, canonical encoding, answer generation, HMAC, raster, transition, or repository reference helper to generate expected results |

The primary receipt came from detached clean checkout `/home/lyuaoss/projects/FsusBlog-issue1369-first`. The second pass came from a separate detached clean checkout `/home/lyuaoss/projects/FsusBlog-issue1369-second`. Both began and ended with empty tracked status at the candidate SHA.

## Independent derivation

### Answer space and sampling

The alphabet has `|Sigma| = 26` symbols and the answer length is `n = 5`, so the answer space is `26^5 = 11,881,376` and entropy is `log2(26^5) = 23.50219859070546` bits. Sampling accepts an unsigned byte only when `b < 234`, then maps `b mod 26`; because `234 = 9 * 26`, every symbol has exactly nine accepted preimages. Direct modulo over all 256 bytes was independently shown to create 9/10-sized buckets and is rejected.

Normalization removes only specified ASCII whitespace, maps ASCII `a..z` to `A..Z`, then requires exactly five symbols from the canonical alphabet. Full-width, non-ASCII whitespace, wrong-length, or alphabet-external input fails rather than being Unicode-normalized.

### Canonical encoding and cryptography

Canonical encoding is `u16be(fieldCount) || each(u32be(byteLength) || bytes)`. Independent empty, empty-field, 255/256-byte boundary, reversed-order, and domain-separated vectors matched the committed language-neutral vector file.

The answer tag is `HMAC-SHA256(answerKey[answerKeyVersion], LP(domain, protocolByte, challengeId, envelopeId, action, routeKey, subjectHash, deviceBindingHash, policyVersion, mediaHash, normalizedAnswer))` and is compared with a fixed-time equality primitive. The independent timing smoke compared 40,000 first-byte and last-byte mismatches; median ratio was `1.0252` under the coarse `<2.5` regression bound.

The state token is version byte + key-version length/value + 12-byte fresh nonce + AES-GCM ciphertext + 16-byte tag. AAD binds protocol identity, kind, algorithm, protocol byte, challenge/envelope/action/route, media hash, issued/expiry times, and token-key version. Plaintext additionally binds the answer tag, subject/device/IP, policy, attempt budget, representation, and answer-key version. Token and answer rings are separate; equal, missing, short, unknown, or checked-in material fails closed. Independent open/seal vectors matched byte-for-byte, while ciphertext, tag, challenge, envelope, action, route, media, time, and key-version substitutions failed.

### Raster and state vectors

The independent raster implementation performs: canonical atlas variant selection; bounded translation/rotation/shear/scale/baseline/overlap; inverse affine lookup; bounded curves and occluders; lattice displacement with Catmull-Rom interpolation; bilinear sampling; bounded additive and impulse noise; then SHA-256 over final Gray8 media. It produced `98,304` bytes with SHA-256 `87f3d19fd3629896bb2a58df292e17c9a368a56dd17e547cd191ab18095ef118`, exactly matching the committed vector (2 curves, 1 occluder, 736 impulses, 12,493 PRF blocks).

The independent pure-Python transition model imported no repository code. Its nine result vectors produced digest `bfc4e123fa0d7abbc6f09f2c5b1dd9d447c2e8ce87a0ca3127c22eeaa9bb31df` and proved: one active challenge per stable server identity; exact attempt budget two; exactly one success in correct-answer races; reply-loss readback without double increment; unresolved operations fenced unavailable; atomic replacement; idempotent replacement replay; and old/current key authority across rotation.

Independent result summary: crypto/oracle `59/59`, token fuzz accepted `0/3000` in `0.0416 s`, atomic model `9/9`, raster vector PASS. Script digests are recorded in the retained second-pass receipt.

## Adversarial, fuzz, and observable-branch validation

- Public issue DTO/POD and frontend transport/client/adapter surfaces contain no seed, recipe, glyph, answer verifier, answer-derived tag, solve duration, or production crypto helper. Enumerating the complete public relation therefore supplies neither deterministic reconstruction nor an offline candidate predicate.
- Token/media/AAD substitution and action, route, envelope, challenge, subject, device, IP, policy, representation, token-key and answer-key version swaps reject. Stable `DeviceAuthorityHash` remains key-rotation independent, while the old challenge binding is derived with its recorded old answer-key version.
- Real Redis tests cover correct/correct and correct/incorrect concurrency, exact attempt races, replay, expiry, explicit revocation, stale/conflict, create/replace atomicity, response loss with readback, unresolved ambiguity fencing, and unavailable fail-closed behavior.
- Typed AEDS tests cover round-trip, unknown union, malformed representation, truncation at every verify prefix, oversized media, and 500 random inputs through each of two decoders. Independent state-token fuzz covered 3,000 inputs up to 4,096 bytes. Canonical boundaries, media dimensions, and verification payload bounds are enforced before allocation/provider execution.
- Six internal issue causes and four internal verify causes collapsed to documented coarse public `rejected`/`unavailable` branches (`10/10` endpoint tests). Internal cause text was absent from public AEDS errors.
- Render deadline, queue saturation, cancellation, memory/media ceilings, replacement/refresh/close/route-change/late-response races, and exact-once resume are exercised by focused backend, frontend, Redis, and browser lanes.

## Primary clean-checkout receipt

Exact lanes included fresh `npm ci`, clean .NET build, protocol/vector generators, V3 and SecurityChallenge tests, one-shot Redis 7, frontend unit/typecheck, complete npm audit, residue/static/governance checks, benchmark harness, and real-component Playwright. Results:

| Lane | Result |
|---|---:|
| .NET build | PASS, 0 warnings / 0 errors |
| protocol/spec/property | 17/17 |
| backend V3 | 44/44 |
| endpoint/orchestrator/contract/capability | 109/109 |
| one-shot Redis | 1/1 |
| frontend focused | 53/53 |
| npm audit | 0 info/low/moderate/high/critical |
| legacy residue fixture + repository/package scan | 7/7 + clean |
| governance | PASS, strict FsusUI warnings 0, matrix 126 tiers |
| real FsusUI/Dialog Chromium | 9/9, one worker, 2.4 min |

Supplemental scenario coverage at the same artifact SHA passed `5/5`: anonymous, login, admin and notification-subscribe V3 bindings plus the dedicated notification-stream endpoint rate limiter. Binary issue/verify/cancel is included in the 109-test lane.

## Independent second-pass receipt

The reviewer independently derived the formulas and expected vectors above, then ran the candidate's tests only as a separate implementation comparison. Results: V3 `45/45`, real Redis `1/1`, frontend challenge client `33/33`, typecheck PASS, offline npm audit zero, residue `7/7`, coarse endpoint `10/10`, focused benchmark PASS, and final real-component Chromium `9/9` in 2.3 minutes.

The final browser run used real FsusUI at the exact SHA/version and rebuilt theme assets. It covered Desktop/Mobile x Light/Dark, single heading/refresh/error/live-region ownership, visual/audio, keyboard/focus return, reduced motion, forced colors, failure/expiry states, and geometry proxies for 200% and 400% zoom. An earlier loader timeout was traced to a concurrent deletion of ignored shared theme dist, occurred before dialog assertions, and was retained as infrastructure history. After exclusive deterministic rebuild, the single final run passed 9/9.

## Benchmarks

Local short-window results are regression evidence, not production capacity claims.

| Measurement | Actual | Budget/result |
|---|---:|---|
| warmed visual render | 140.113 ms; 98,304 B; 6,182,592 managed B | `<3,000 ms`, exact media size: PASS |
| audio render | 39.085 ms; 81,876 B | `<=262,144 B`: PASS |
| four concurrent visual renders | 231.158 ms total | bounded queue/concurrency recorded |
| HMAC x1000 | 37.929 ms | `<2,000 ms`: PASS |
| AES-GCM seal x1000 | 87.292 ms; 539-byte token | recorded |
| AES-GCM open x1000 | 43.888 ms; 1000/1000 | recorded |
| Redis create + verify x100 | 295.481 ms; 2.955 ms/pair | recorded; atomic correctness tested separately |

## Atomic release-fence dry run

The final run used a loopback-only temporary endpoint harness referencing the exact candidate server project, a temporary bearer principal with only `system.config`, and a disposable Redis 7 container. It validated the immutable manifest and supported rollout ordering, acquired the exact `green/generation=1/digest` fence, invoked the native cutover endpoint with `dryRun:true`, replayed the same operation, proved protocol activation stayed closed, revoked the fence, and destroyed all temporary services.

- Release identity: `20260721000000-74dc0ddfc572`.
- Composite binding: server DLL `5272897eaf46a88a3b878b34177a96a95d3d3526381baf32fdf43b1c72c5cff3`; FsusUI clean dist `871793f77ac7e8748604b1a0bcdcb23cfafd71d91751d7028a099eb95c016b7d`; theme `5cd305d2793165a5dd8a54d263cc975f3f6a271094f5dd9c50ddf08b31f5474d`.
- Receipt: `accepted=true`, `status=would-apply`, `dryRun=true`, kinds `[3,10,13]`, target fingerprint `48e9440c0b09fcd494d11f3773d7190f703bcb1295c171c3242ea9d3ea484c19`, and all three fence checks true.
- Non-empty scans: attempt `1`, used `1`, envelopes examined `1`, envelopes that would revoke `1`; all three fixture values were byte-identical before/after.
- Same-operation replay: `idempotent=true`, identical request/target fingerprints.
- Activation negative proof: `accepted=false`, `status=closed`, `errorCode=cutover_receipt_not_verified`.
- Cleanup: exact revoke accepted; ports 5089/16369, Redis container, harness, and temporary build processes absent.

Harness setup failures (generation reservation, transition kind, and candidate readiness) were retained as setup history and are not counted as passing attempts. A pre-final pass was also rejected as final evidence because a subsequent clean FsusUI build changed the aggregate dist digest. The final receipt binds the clean build digest.

## Findings and disposition

| Finding | Severity/confidence | Disposition |
|---|---|---|
| frontend refresh could issue before asynchronous cancellation settled | medium/high | fixed by atomic backend replacement contract; unit/browser/Redis replacement races pass |
| Redis create could separate state write from expiry/index | medium/high | fixed with one Lua NX state+PEXPIREAT+active-index transition |
| Redis mutation reply loss was ambiguous | medium/high | fixed with operation result readback and unresolved-operation fence |
| answer-key rotation could change the active identity/bypass replacement binding | medium/high | fixed with stable server `DeviceAuthorityHash` plus old-record answer-key version; rotation conflict tests pass |
| ECharts moderate advisory and dev brace-expansion high advisory | medium/high | updated to compatible fixed versions; complete npm audit reports zero findings |
| retired-residue fixture referenced a deleted provider test | quality blocker | fixture now points to live evidence; residue fixture and repository/package scans pass |

Unresolved critical/high/medium-confidence findings: **0**.

Accepted lower residual risks:

| Risk | Rationale / control | Owner / expiry condition |
|---|---|---|
| OCR resistance is cost-raising, not humanity proof | explicit protocol threat model; RiskControl can combine independent challenges | Security owner; revisit when observed solve economics invalidate policy assumptions |
| short local benchmark omits production network/failover latency | correctness is separately proven; production readiness remains fail-closed | Operations owner; real rollout/soak evidence required before production activation |
| browser harness has expected absent-backend proxy noise | dialog path is isolated and all dialog assertions pass; no raw internal reason rendered | Frontend owner; reassess if the production flow changes host/bootstrap ownership |

## Risk, rollback, and tested operating surfaces

Primary operational risks are Redis transition ambiguity, active-identity duplication across refresh/key rotation, and mixed frontend/backend presentation identity. The code fails closed on unsettled Redis operations, uses a rotation-stable active index, and the receipts bind exact Blog/UI SHAs and clean dist digests.

No-restart emergency downgrade is to hot-update RiskControl policy to remove `perceptionCharacterV3`, which stops new anonymous, login, admin and notification-subscribe assignments and replacements; then explicitly cancel/revoke active envelopes. Do not restore retired character generations, delete Redis state, reset attempts, add JSON fallback, or activate from a `would-apply` receipt. Key-ring recovery is a rolling deployment boundary using the prior valid independent token/answer key versions.

Tested surfaces: anonymous device authority and IP lease; login `sid`; admin `admin_sid`; notification-subscribe binding and notification-stream routing isolation; binary issue/verify/cancel; public coarse errors; Redis unavailable/stale/conflict; and real FsusUI dialog flows.

Documentation updated with the candidate: `docs/api/design.md`, `docs/api/contracts.md`, `docs/architecture.md`, `docs/security.md`, and `docs/security/perception-character-v3-protocol.md`; this versioned report is the release-validation record.

## Closure table for #1365 through #1368

Every item below maps to an executable test (`S` spec/vector, `B` backend, `R` real Redis, `F` frontend/browser, `D` residue/deployment) or an explicit inspection/proof (`P`).

| Criterion | Evidence and result |
|---|---|
| 1365-1 | Versioned spec + machine contract normative-field test (`S`, 17/17). |
| 1365-2 | Public DTO/source oracle scan + independent enumeration proof (`P`, crypto 59/59). |
| 1365-3 | Exact nine-preimage rejection sampling + statistical/property tests (`S/P`). |
| 1365-4 | Separate key rings; missing/short/equal/unknown/checked-in failures (`B`). |
| 1365-5 | Independent LP empty/boundary/order vectors (`P`). |
| 1365-6 | Independent raster implementation and exact SHA/size (`P`). |
| 1365-7 | Independent atomic model + real Redis concurrency/replay/expiry/revoke/failure (`P/R`). |
| 1365-8 | Internal causes collapse to coarse public responses (`B`, 10/10). |
| 1365-9 | Atomic same/cross-representation replacement and old identity revoke (`B/R/F`). |
| 1365-10 | Threat model states cost-raising, not humanity proof (`P`). |
| 1365-11 | Canonical V3 identity and zero executable retired-character alias/fallback (`D`). |
| 1365-12 | All protocol tests local; only disposable Redis 7 external fixture (`S/R`). |
| 1366-1 | Enum/wire/capability/provider/policy/AEDS registration (`B`, 109/109). |
| 1366-2 | Typed final Gray8/WAV + opaque state; no truth fields (`B/F/P`). |
| 1366-3 | Sampling matches independent and committed vectors (`S/B/P`). |
| 1366-4 | LP/HMAC/AAD/AES-GCM byte vectors independently reproduced (`P`). |
| 1366-5 | Key-ring startup fail-closed matrix (`B`). |
| 1366-6 | Fresh 12-byte nonce and test-only deterministic source (`S/B`). |
| 1366-7 | One-success, attempt, replay/exhaust/expire/revoke/unavailable invariants (`R/P`). |
| 1366-8 | All authoritative substitutions reject (`B/R/P`). |
| 1366-9 | Verify accepts no solve duration/truth fields (`B/F/D`). |
| 1366-10 | Issued policy remains authority; explicit revoke is immediate (`B`). |
| 1366-11 | Issue/verify/cancel coarse public result and bounded audit detail (`B`). |
| 1366-12 | IP/device/subject/action/active/global gates precede render/crypto (`B`). |
| 1366-13 | Render ceilings, deadline, cancellation, concurrency and saturation (`B`, benchmark). |
| 1366-14 | Typed AEDS roundtrip/truncate/oversize/unknown/fuzz (`B/F`). |
| 1366-15 | Provider/crypto/Redis/endpoint/orchestration/audit/perf lanes and recorded values (`B/R`, benchmark). |
| 1366-16 | Backend implementation commit did not add UI/layout ownership (`P`, diff inspection). |
| 1367-1 | Shared host inventory for login/recovery/comment and zero unsupported account/admin owners (`F`). |
| 1367-2 | Only public FsusUI adapter; no internal selector/local substitute (`F`, static). |
| 1367-3 | Dialog material/density/focus/motion against real FsusUI (`F`, 9/9 twice). |
| 1367-4 | Exactly one heading/refresh/error/live region owner (`F`). |
| 1367-5 | Retry retains command; reissue preserves pending command (`F`). |
| 1367-6 | Double/late/route/unmount exact-once resume (`F`). |
| 1367-7 | Cancel/Escape/refresh/switch/route revoke and media disposal (`F/B`). |
| 1367-8 | Refresh/switch creates new identity without token/attempt reuse (`F/R`). |
| 1367-9 | AEDS bounds enforced before allocation (`B/F`). |
| 1367-10 | No solve duration/recipe/seed/glyph/verifier in frontend (`F/D/P`). |
| 1367-11 | Localized coarse copy; raw backend cause never rendered (`F`). |
| 1367-12 | Desktop/Mobile x Light/Dark + audio/a11y/motion/colors/zoom (`F`, independent 9/9). |
| 1367-13 | Real Vite/FsusUI component E2E, not worker-only harness (`F`). |
| 1367-14 | Unit/static/typecheck/AEDS/Playwright lanes all pass (`B/F`). |
| 1368-1 | First retired character kind absent from executable enum/catalog/provider/config/cache (`D`). |
| 1368-2 | First-generation frontend/service/worker/Wasm/derivation/glyph paths absent (`D`). |
| 1368-3 | Second retired character kind removed end-to-end (`D`). |
| 1368-4 | No character/text-task or retired-to-current alias (`D/B`). |
| 1368-5 | Localization/MicroInteraction V2 remain independent and pass (`B/F`). |
| 1368-6 | Residue checker rejects identifiers/algorithms/keys/recipes/workers (`D`, 7/7). |
| 1368-7 | Generated docs/config/matrix/package outputs contain only V3 character identity (`D`, matrix 126). |
| 1368-8 | Exact 3/10/13 isolated cutover dry-run scans non-empty legacy state without mutation (`D`, final fence PASS). |
| 1368-9 | Retired raw kind/manifest fails closed with no translation (`B/F`). |
| 1368-10 | Backend/frontend/static binding and active fence use one release identity (`D`, composite SHA binding). |
| 1368-11 | Candidate build and scoped security/API/frontend/AEDS/docs/residue/package gates pass; unrelated full-suite schema/release-id baseline failures are not represented as green (`B/F/D`, receipts). |
| 1368-12 | No executable/configured source retained only for retired-character compatibility (`D`). |

## Retained artifact index

Local evidence contains no token, cookie, admin header, key material, or user data. Temporary credentials and services were destroyed.

| Artifact | SHA-256 | Retention |
|---|---|---|
| `/tmp/fsusblog-1369-first-final-rerun/receipt.md` | `6628ee883f0790670ad2efec0f8e2876f5646ff3c0618ea7f2ed02cbb39bcf1c` | local validation receipt; removable after issue close/archive |
| `/tmp/fsusblog-1369-first-final-rerun/results.json` | `f0f77173517540836fbb2b4fa20a3dbc02f8a3c4d54e331fd6f5293c92b156bb` | local machine summary |
| `/tmp/fsusblog-1369-second-final-rerun/receipt-phase-a.md` | `a61305aa7c2ba8dc211c6d89235f0c6780f91182cef2aa5dda86b55fb3f88e9c` | local independent receipt |
| `/tmp/fsusblog-1369-fence-final/report.json` | `e03519f2707dcbdb3124c0c9f64f991d17b0538a6cd6e09d473c2978f5342a4b` | local fence summary |
| `/tmp/fsusblog-1369-fence-final/SHA256SUMS` | `653742a244a9c4e57006be3aaada7decb68187d66a119934cc37b91ad026ed97` | local artifact index; all entries verified |

The committed report is the durable summary. Raw local artifacts may be removed after the issue comment is posted, live closure is verified, and any desired external artifact archival has completed.
