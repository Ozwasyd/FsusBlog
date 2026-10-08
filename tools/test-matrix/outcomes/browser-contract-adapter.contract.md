# Browser Contract outcome input contract

`adaptBrowserContractSemanticOutcome({ repositoryRoot, authority })` consumes
member-level evidence and returns the existing
`fsusblog.producer-semantic-outcome-candidate.v1`. It uses the existing candidate
validator, content digest primitive and failure taxonomy. It computes the
candidate's required semantic payload digest, not a fingerprint or aggregate.

## Held authority

The caller must independently hold all of these fields:

- `identity`: the unchanged candidate identity, with producer ID
  `browser-contract-semantic-outcome`, source commit, worktree fingerprint,
  build identity, scheduler run ID, toolchain, execution envelope, replay plan
  and temporal context digests.
- `attemptEligibility`: the existing six-field attempt/aggregate binding.
  A failed or unqualified attempt produces a failed candidate with its actual
  executed/terminal membership preserved; it can never produce success.
- `policyDigest`: the exact Browser Contract policy digest.
- `runtimeIdentities`: unique `{ projectId, browserId, runtimeDigest }` records
  covering exactly the planned project/browser pairs. The digest must bind the
  actual browser/runtime observation supplied by its existing owner.
- `inputAuthorityRefs`: exactly one `{ kind, path, digest }` reference for each
  of `browser-contract-plan`, `browser-contract-catalog` and
  `browser-contract-report`. Digests cover raw file bytes, independently of
  the document's canonical content seal. Paths are relative to the supplied
  repository root; symlinks, escapes, missing/nonregular files, oversized files
  and digest mismatches are refused.

No authority or expected digest is inferred from the input document, timestamps,
file existence, a log, a qualified flag inside the report, or another producer.
The caller remains responsible for acquiring the real independently verified
plan, attempt, temporal, envelope and runtime authority. Controlled test fixtures
exercise this interface; they do not supply that runtime authority.

## Sealed documents

All three documents are closed objects with `schema`, `identity`,
`attemptEligibility`, `policyDigest`, `runtimeIdentities` and `contentDigest`.
Every binding must exactly equal the held authority. `contentDigest` uses the
existing `sealContentDigest` algorithm over all fields except itself.

`fsusblog.browser-contract-outcome-catalog.v1` adds `members`.
`fsusblog.browser-contract-outcome-plan.v1` adds `members` and `catalogDigest`.
The plan's complete members equal the catalog's; its catalog digest binds the
catalog seal. Each planned member has exactly:

```text
id, projectId, browserId, testId, assertionId, required, artifacts
```

`required` is boolean. `artifacts` is a list of unique `{ id, kind }` correctness
assertion declarations; only `dom`, `geometry`, `network` and `screenshot` are
supported. Full project/browser/test/assertion tuples and member IDs are unique.
Screenshot declaration is explicit; a failure screenshot or trace snapshot
cannot become a correctness artifact through mere file presence.

`fsusblog.browser-contract-outcome-report.v1` adds:

```text
catalogDigest, planDigest, groupStatus, members, artifacts, interruption, diagnostics
```

Both digests bind the sealed inputs. `groupStatus` is `success` or `failed` and
must agree with the member results and interruption. It does not authorize or
overwrite a member result, and cannot override attempt ineligibility.

Each report member has exactly:

```text
id, projectId, browserId, testId, assertionId, executed, status, artifactIds, failures
```

IDs and the full tuple must match the plan. `passed` and `failed` require
`executed: true`; `skipped` and `blocked` require `executed: false` and no semantic
artifact references. A required skip fails the candidate. Only a skip explicitly
permitted by the plan's `required: false` can coexist with success.

`failures` contains unique `{ kind, identity }` records. Their kind comes from
`readOutcomeFailureTaxonomy`; their identity includes the producer and member
project/browser/test/assertion tuple plus the kind's required held identity.
For example, `product.assertion` binds that member's assertion ID,
`infra.browser-crash` binds the held attempt number, `infra.service-readiness`
and `infra.environment-mismatch` bind the execution envelope, and
`infra.toolchain-mismatch` binds the toolchain digest. Failure text is never
used for classification. Failed members require canonical failures; other
terminals forbid failures.

`interruption` is null or an explicit canonical infrastructure failure with its
required held identity. After an infrastructure interruption, omitted planned
members become unexecuted `blocked` members. Explicit blocked members require
that interruption. Executed members retain their precise results. Missing
terminals without an interruption, duplicate/extra members, conflicting states
and forged group success are refused.

Every report artifact has exactly:

```text
id, memberId, kind, role, path, digest
```

`role: correctness` requires a planned declaration, matching kind/member,
exact member reference and verified file bytes. Passed assertions require their
complete artifact declarations. No orphan or duplicate artifact is admitted.
`role: diagnostic` permits trace/video/log and diagnostic DOM/geometry/network/
screenshot artifacts with separate IDs. Declared correctness IDs cannot be
reclassified as diagnostic. Diagnostic bytes, locations and `diagnostics`
metadata never enter semantic membership. The report seal still protects all
these records, so a diagnostic change requires a newly held report reference.

## Candidate and downstream ownership

Membership contains planned project/browser/test/assertion/member ID sets,
executed and disjoint terminal member sets, exact member records, canonical
member/interruption failure kinds and correctness artifact content digests.
Input authority references provide sealed evidence locations separately.
Changing diagnostic text, timestamps, trace/video/log digests or locations does
not change the semantic payload; changing correctness bytes does.

The current Browser Contract runner does not yet emit this complete sealed
member/assertion input set. Its scenario-level receipt alone is insufficient.
The original runner/report owner must supply individual assertion emission
without changing tests, projects, workers, retries or assertions, including
canonical failure identity and explicit correctness artifact disposition. The
shared capability below supplies its DATA_ONLY member profile. Canonical source
registration and execution-owner verification remain required before runtime
admission. This adapter does not modify shared authority, authorize sealed outcomes, execute browsers,
compute fingerprints, aggregate results or claim runtime qualification.

## Original runner binding

`readBrowserContractOutcomeRunnerBinding` reopens a byte-bound original native
Browser Contract receipt with `validateBrowserContractReceipt`. Its independently
held `expected` object has exactly `identity`, `attemptId`, `fixtureNamespace`,
`browserPlanDigest`, `browserActualDigest` and `fixtureCapabilities`. Native
source, build, run, attempt, fixture lifecycle, selected scenario membership,
browser plan/actual identity and finalization must match. Pending source
scenarios remain unexecuted. Original coarse classifications remain diagnostic;
they cannot supply canonical individual assertion failure kinds.

A successful native source requires explicit independent `temporalAuthority`
and `rawObservationReferences` with byte references named `candidatePlan` and
`receipt`. The original `verifyBrowserContractRaw` independently reopens the
production build, runner, preview and temporal sources. Its upstream path must
identify the same native receipt. A failed native source requires
`rawObservationReferences: null`; a successful observation cannot replace its
failed or pending terminals.

`releaseReliability` must be explicit: null outside that context, or exactly
`{ environment, identityReference }`. In context, the original
`readReleaseReliabilityEvidenceBinding` checks its five held environment fields
and canonical identity path/seal; the byte-held identity must bind the same
source, build and run. This consumes the existing #1590 source API without
claiming the #1591 exact-seven lifecycle or terminal acceptance.

`adaptBrowserContractRunnerSemanticOutcome` composes that binding with the
independently held member documents above. The report must hold the identical
native reference at `diagnostics.runnerReceipt`; planned test IDs must equal
the native `browser-contract:<scenario-id>` set. A native pending scenario
cannot acquire executed assertions; successful scenarios cannot mask failed
members; failed scenarios require failed or blocked members. Native failure
also preserves failed, unqualified first-attempt provenance. Launched runtime
identities must match the native browser. The existing candidate receives
verified native/raw/reliability input references, with unchanged semantic
membership fields. The bridge does not generate assertions from group status
or treat raw observation diagnostic facts as correctness artifacts.

The contract tests use the existing original source fixture and readers. Their
synthetic member documents exercise consumer behavior, not a physical browser
run, an independently admitted global outcome profile or release qualification.
The success-path control also exercises the original canonical raw-source
admission. The single registry owner's exact correction
`54fa4caf4bcafc65685ece847da09c2a3c16944c` registers the native finalizer's
existing `attemptStatus`, `cleanFirstAttempt` and `qualificationEligible`
fields in the closed Browser v2 source-field list. Producer, validator and
other registry data remain unchanged. After consuming this correction, all
14 ordinary bridge controls pass, including the original success-path control
and failed/pending/provenance refusals. Earlier failed evidence remains
separately source-bound. This source-fixture result grants no physical Browser
or release qualification.

## Canonical profile and held-input custody composition

The source capability in PR #3998, exact commit
`3f6f443ac4e253f7a9b80e7c7c910d2de8fce824`, supplies
`validateOutcomeAdapterCandidateData` and `verifyOutcomeInputCustody`.
`verifyBrowserContractOutcomeInputCustody(encodedCandidate, encodedExpected,
custodyOptions)` calls these original APIs, requires the Browser producer and
identical physical input/payload paths, and returns their separate DATA_ONLY
profile and custody results. Expected candidate/source/context/registry/mapping
digests, aggregate reference, byte budget and execution-owner verifier remain
independent host inputs. There is no search, automatic mapping or synthetic
authority. Original locator/publication and file-backed attempt checks execute
unchanged, including failed first-attempt eligibility and post-verifier rechecks.

`adaptBrowserContractRunnerSemanticOutcomeWithCustody` first runs the existing
native adapter, then verifies the resulting candidate with those canonical
owners. It pins the caller's repository root over options overrides. The return
value is `{ candidate, verification }`; membership, reasons and candidate seal
are unchanged. Custody never authorizes execution or Browser qualification;
`producerVerificationPending: true` and `qualificationEligible: false` remain
explicit on the composition result.

The published catalog still pins the original adapter's `36bcb99` source
contract. That pin identifies its DATA_ONLY contract; it does not attest to
execution of this later bridge implementation. Refreshing source registration
belongs to the single catalog owner. The new APIs require the exact shared
capability to be integrated. Local composition imports its commits verbatim;
no shared registry, schema or authority file is independently edited.
