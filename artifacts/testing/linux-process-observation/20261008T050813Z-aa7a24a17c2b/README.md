# Owned writer race repair and canonical dependency follow-up

Historical, informational execution record for #3620. This is not a canonical
runtime receipt, promoted qualification or issue closure. The entire one-issue
assignment remains blocked; no tracking or additional owned downstream exists.
Older failure logs remain unchanged and are not carried forward as current passes.

## Exact source binding

- Final source tested here: `aa7a24a17c2b2efa52f4f7678fc53dadd769cce0`.
- Run: `chain3620-20261008T050813Z-aa7a24a17c2b`; actual xUnit run UUID is in
  [observations](observations.json).
- Resume fetch verified master `0a755584aa256995fd9997ca974806e8a0e29d2e`.
- Final fetch found `0e9dd5751bdd584204fd149bdb1526b97ff682a6`. New work
  affects locale verification and fixture permission controls, including the
  shared generated authority. The final virtual merge-tree is clean; no master
  merge or cross-chain conflict-resolution phase was performed.
- Evidence-only head `d06aad7910272201d7663fc2d327b24e455e0cab` independently
  revalidated all 82 Node controls and five new commit messages. These results
  are archived separately from the native source candidate.
- Branch: `codex/chain-3620-linux-observation`.
- At capture, remote/draft PR #3844 remained at
  `c5778fbfac5a2c5ed02cfb369998b5298a20c60b`. New work was local under the
  continuation's no-publishing instruction. No package publishing or self-merge.
- Official Node 24.16.0, SDK 10.0.401/runtime 10.0.12; task-scoped caches.

| Local commit | Coverage and exact supplied source |
| --- | --- |
| `72693960c01af6978f6d3d7743003930257455f1` | Owned reparented writer readiness race and deterministic regression, related to #3620 |
| `b733a01c980ee5390df561f1a6ce6cfd7f05750b` | Canonical #3521 four-file separator delta from `9b1455c00389daf6472749f78c22d4a77a37766e`, PR #3903 |
| `1b91443e28ad4274c4939fb97f091baaa417138b` | Five compatible Backend fixture post-images from `f53b6b79f8cf051bd190cad2e49a57ea4a1cc1bd`, PR #3916 |
| `aa7a24a17c2b2efa52f4f7678fc53dadd769cce0` | Original complete execution-authority producer refresh; only two discovery digest fields changed |

The full `1b91443e2` identity is verified in the accompanying local Git history;
no moving source tip or independent implementation was consumed. Source, test and
manifest files from #3521 match their supplied trees; its separator documentation
paragraph matches while preserving the already-consumed inventory paragraph.
The five changed C# files match the exact supplied #3654 tree. The other two
related C# files were already identical. Current native SQLite locks are retained;
the old composite test lock and actionlint merge were not copied. Projection
`4921d772` was mentioned separately and was not consumed or treated as qualification.

## Real owned race and deterministic regression

The failed writer tests previously assumed a 120 ms wrapper exit implied its
child had made its first write. Two saved ENOENT failures disproved that assumption.
The existing callback now subscribes to wrapper exit immediately and awaits the
first actual nonempty output using a bounded five-second deadline before the
original assertions. The child lifetime, 20 ms write interval and 80 ms growth
check remain unchanged. Every original growth, descendant identity, persisted
group/start identity and active-owner assertion is retained, as is the literal
original test title and its case identity. Production process collection is not
changed; the existing Linux reaped-PID negatives and live group tests remain.

The new regression shares those exact assertions and blocks the child's first
write with a task-owned permit until after wrapper exit. The permit is issued on
the parent's next event-loop turn, so the output is certainly absent beforehand.
A temporary mutation removes only the readiness await, selects this literal new
case and deterministically fails at the original stat with ENOENT (exit 1). The
mutation file is removed in finally; no production code or gate is patched.
The current committed-source negative was repeated on the final tested source.
The initial owner/mutation diagnostics occurred before the writer commit; their
observations record the actual c5778fbf HEAD plus the edited file post-image, rather
than falsely claiming that later commit had already been checked.
The negative filtered run has ten unselected cases, and is not a qualification
run. The unmodified complete owner passes 11/11 with zero skips, independently
repeats 11/11, and passes 11/11 while the original fresh scan runs concurrently.

## Current commands and results

SDK commands use installed Node/SDK first in PATH, task-local DOTNET_ROOT,
DOTNET_CLI_HOME and NUGET_PACKAGES, telemetry opt-out and
`MSBUILDDISABLENODEREUSE=1`. Locked graph/audit policy is unchanged.

| Stage | Exit | Result | Evidence |
| --- | --- | --- | --- |
| Owned writer tests and gated regression | 0 | 11 passed; zero skipped | [Owner](writer-readiness-owner.log.gz) |
| Removing only the readiness wait | 1 expected | Deterministic ENOENT; filtered negative only | [Current negative](followup-mutant.log.gz) |
| Owner independent repetition | 0 | 11 passed; zero skipped | [Repeat](readiness-owner-repeat.log.gz) |
| Owner concurrent with real fresh scan | 0 | 11 passed; zero skipped | [Concurrent](readiness-owner-during-fresh.log.gz) |
| Eight selected original Node owners | 0 | 82 passed; zero failed/skipped | [Current controls](followup-node-controls.log.gz) |
| Full Backend Debug build | 0 | Actual Tests DLL; 1430 warnings; zero errors; 8:07.57 | [Build](followup-backend-build.log.gz) |
| Seven original C# classes | 0 | 248 passed; zero failed/skipped; actual TRX | [Tests](followup-dotnet.log.gz), [TRX](followup-controls.trx.gz) |
| Original seven-file full C# style | 0 | Zero violations | [Style](followup-csharp-style.log.gz) |
| Original lifecycle/retention owners | 1 | 45 passed; one foreign SDK Compile source refusal; zero skipped | [Current retention](followup-retention.log.gz) |
| Initial fresh retry before generation | 1 | Actual dependency-closure drift; did not reach cgroup | [Initial](readiness-separator-fresh.log.gz) |
| Original complete authority producer | 0 | Only discovery content/index digests refreshed | [Generation](readiness-authority-generation.log.gz) |
| Fresh retry after generation | 1 | Passed the former closure refusal; actual cgroup `/..` rejection | [Current lane](followup-backend-fresh.log.gz) |
| Current Migration Debug build | 1 | Two CS0246; 1554 warnings; 27.40 seconds | [Build](followup-migration-build.log.gz) |
| New own commit contract | 0 | Four new source commits admitted by original message checker | [Own range](followup-own-commit-contract.log.gz) |
| Complete branch commit contract | 1 | Seven earlier footer refusals retained | [Composite](followup-composite-commit-contract.log.gz) |
| Latest-master virtual conflict check | 0 | Clean merge-tree; no actual merge or conflict resolution | [Tree](followup-master-merge-tree.log.gz) |

The 82-control command uses `node --test` with the original identity, build-owner,
finalizer, correctness-migration, test-producer, build-release and convergence
files from earlier records, plus `tests/tools/xunit-configuration-context.test.mjs`.
There are 69 cases in the first seven owners and 13 in the supplied context owner;
the handoff's 16-case receipt is not represented as this local thirteen-case run.

The native commands are:

```sh
dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Debug --no-restore \
  --disable-build-servers -m:1 -v minimal
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -c Debug --no-build \
  --no-restore --filter 'FullyQualifiedName~LifecycleHostedBootstrapServiceTests|FullyQualifiedName~RealConcurrencyHarnessTests|FullyQualifiedName~CanonicalArticleProjectionVerifierTests|FullyQualifiedName~CanonicalArticleLifecycleScheduledFailureTests|FullyQualifiedName~SecurityAdminPolicyDefaultsTests|FullyQualifiedName~TaxonomyExactMetadataTests|FullyQualifiedName~AuthoringExtensionRpcBrokerTests' \
  --logger 'trx;LogFileName=chain3620-followup-controls.trx' \
  --results-directory /tmp/chain3620-followup-dotnet
node --test tests/tools/test-lifecycle-governance.test.mjs \
  tests/tools/test-retention-audit.test.mjs
node tools/test-matrix/generate-release-final-execution-authority.mjs
./tools/test.sh backend-unit --fresh
dotnet build tests/migration/FsusBlog.Migration.Tests.csproj -c Debug --no-restore \
  --disable-build-servers -m:1 -v minimal
git merge-tree --write-tree origin/master HEAD
```

Original C# full-style uses the same seven explicit file paths as earlier records.
Contract ranges are `c5778fbfac5a2c5ed02cfb369998b5298a20c60b..HEAD` and
`origin/master..HEAD`. Old messages/history are not rewritten to obtain green.
All complete bytes are deterministically gzipped and round-trip/digest verified.

## Remaining acceptance limits

The two bootstrap stage and two projection sidecar expectation defects are now
corrected by the exact canonical source owner and actually verified in 248/248.
The observed `current_schema_verified` stage matches the existing production
startup step. The actual projection code returns before sidecar discovery when
the AOT document is missing; the canonical expectation change preserves every
scenario, caller budget and negative assertion. These unit/component results are
not product AOT, persisted-command/provider or canonical scheduler qualification.

The #3521 separator capability is actually unlocked. Its next distinct original
refusal is the NuGet-owned `Microsoft.NET.Test.Sdk.Program.cs` outside the
canonical repository boundary. Do not copy the program into the repository,
whitelist arbitrary external sources or fabricate compiled context. Required
handoff is #3521's exact admitted SDK source-ownership correction and original
negative evidence. Retention is still 45/46, not complete.

The current Migration build still fails on `CreateTableStep` and `AddColumnStep`
at `OfflineMigrationExpandSafetyTests.cs:79–80`. That file is identical in the
supplied #3654 follow-up tree, which has no corresponding Migration change. Keep
this repair with #3654; require its exact compatible type-fix and passing Debug
build. No guessed replacement step/API is introduced here.

The original source-owned authority producer refresh is limited to discovery's
two digest fields. The target roster, registrations and source-index identity are
unchanged. It removes the current static closure refusal but grants no runtime
qualification. The original owner's generic output-binding artifact still names
the prior authority SHA; [actual SHA observation](followup-binding-observation.json.gz)
records that new stale binding instead of resealing it. Existing generated/naming
admission is still unaccepted. Seven existing composite footer failures remain;
all new own source commits pass. Canonical metadata admission is still needed.

The actual current fresh lane remains blocked by cgroup `/..`. Earlier real
read-only capability probes showed unavailable user systemd/delegation and absent
catalog fixture. An admitted task-isolated Linux scheduler/cgroup and applicable
original fixture are still required for native normal/failure/cancellation/
timeout/interrupted/repeated finalizer cleanup and independent acceptance. No
production resource, fabricated backup, receipt or unknown-resource kill is used.
Missing remote CI is not a blocker; actual runtime/code/admission limits remain.

A tooling correction is also preserved: earlier direct calls to the
markdownlint-cli2 API module returned without invoking its CLI. This continuation
ran the actual `markdownlint-cli2-bin.mjs` with repository config: 364 files,
742 existing diagnostics in 40 files outside the changed documentation scope,
and zero diagnostics in current docs/testing.md. That global exit 1 is retained;
the no-op calls are not treated as linter passes. Artifact lint is separately
run with the same style rules and an explicit artifact-only selector.

Issue #3620 remains blocked despite repairing its fixable writer race. No issue closure,
actual merge, final cross-chain conflict resolution, deployment or package
publishing occurs. New local work does not silently update the earlier draft PR.
