# Linux observation after canonical compiler handoff

Informational historical execution evidence for #3620; no canonical runtime
receipt, promoted qualification, independent acceptance or issue closure.
The complete one-issue assignment remains blocked, with no tracking-only or
additional assigned downstream issues. Earlier records remain historical.

## Candidate and authorized source consumption

Tested source: `b12c78aa2ae771801919dc6990b6c00292f08bb7`.
Run: `chain3620-20261008T044200Z-b12c78aa2ae7`; actual xUnit TRX run UUID is in
[observations](observations.json). Branch: `codex/chain-3620-linux-observation`;
draft PR #3844. Tooling: official Node 24.16.0, SDK 10.0.401/runtime 10.0.12.
Start master was `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`; final fetched
master was `8b1c739cacef47995f441f096835863d377dc347`. Its two new commits
only affect `.github/actionlint.yaml`; no owned source scope changed. No final
cross-chain conflict-resolution phase was performed.

The coordinator provided these exact original canonical compiler increments,
with PR #3828 and original consumer Debug/control evidence. Their changed-file
base bytes matched this candidate before consumption. They applied without
conflicts, and all seven final C# paths match their supplied source trees exactly.
No guessed source fix, moving tip, local alternate owner or assertion change was
introduced. [Exact byte comparisons](current-compiler-source-bytes.log.gz).

| Supplied exact source | Published local port | Scope |
| --- | --- | --- |
| `a95de1defd39a46f34992bed9eee3c150d990456` | `9b6902f2c069de5a9c1c306f345ad2bd423a5690` | Four legal InlineData constants; all cases/assertions retained |
| `e724251e44222c1c36388984f71f88e901a02c48` | `278f6049b9260a20cd15ab35b33a154b25edfbf2` | Two existing canonical polling member references |
| `fd08fde79cb98cd3b4dc7fc5c8af2b09045a3733` | `422f08b69cd466c23b38c84887b2402954322f4b` | Four-file namespace/async assertion compatibility |
| `9bf3ebb9779de226c369d1d0b8021ba140d2f176` | `b12c78aa2ae771801919dc6990b6c00292f08bb7` | Existing real Linux broker path verifier |

The prior #3521 inventory and #3568/#3663 dependency offers remain integrated.
The Backend and Migration audit-on locked restores already passed on exact
`d4ffe65f77ec90282b432a92bd5d0e76e3837bcf`; these four dependency paths are
unchanged by the compiler ports. No native provider, backup/restore or destructive
migration acceptance is inferred from those source/restore capabilities.

## Actual execution results

SDK PATH and DOTNET_ROOT select the task-local official tooling. DOTNET_CLI_HOME
and NUGET_PACKAGES use task-local caches; telemetry is opted out. Native commands
use `MSBUILDDISABLENODEREUSE=1`, and builds retain `--no-restore
--disable-build-servers -m:1`. No production resources are involved.

| Stage | Exit | Current observed result | Complete raw evidence |
| --- | --- | --- | --- |
| Full Backend Debug build | 0 | Actual Tests DLL produced; 1508 warnings, zero errors; 9:08.91 elapsed | [Build](current-compiler-build.log.gz) |
| Seven unchanged Node owners, first run | 1 | 67 passed, one writer-output ENOENT failure, zero skipped | [Controls](current-compiler-controls.log.gz) |
| Seven unchanged Node owners, repeat | 0 | 68 passed, zero failed/skipped | [Repeat](current-compiler-controls-retry.log.gz) |
| Original C# bootstrap/concurrency cases | 1 | 18 passed, two failed, zero skipped; actual TRX emitted | [Tests](current-dotnet-controls.log.gz), [TRX](compiler-controls.trx.gz) |
| Original lifecycle/retention owners | 1 | 45 passed, one CLI context failure, zero skipped | [Retention](current-registry-retention.log.gz) |
| Original fresh canonical lane | 1 | Rejected actual Linux cgroup path `/..` before native execution/finalizer | [Lane](current-backend-unit.log.gz) |
| Original changed-mode C# style checker | 1 | Checker exception: undefined `.trim` | [Exception](current-csharp-style.log.gz) |
| Original explicit seven-file full-mode style checker | 1 | Four using-order failures | [Style](current-csharp-style-explicit.log.gz) |
| Actual MSBuild context read | 0 | Absolute target exists; reported intermediate spelling resolves differently on Linux | [Observation](current-debug-context.json.gz) |
| Original PR contract on actual API event | 1 | Eight unchanged generated-source bindings and external-naming scope rejected | [PR](current-pr-contract.log.gz) |
| Original commit contract | 1 | Seven footer rejections; includes three new `-x` ports | [Range](current-commit-range.log.gz) |

The earlier actual Backend build on `9b6902f2c069de5a9c1c306f345ad2bd423a5690`
cleared the four CS0182 errors and exposed 13 remaining compiler/analyzer errors;
[that complete failure](canonical-compiler-build.log.gz) is retained. The final
full build now clears all those errors. Compilation proves the consumed imports
were actually compiled; it does not establish passing tests or native acceptance.

Exact commands for the stages above:

```sh
dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Debug --no-restore \
  --disable-build-servers -m:1 -v minimal
node --test tests/tools/run-once-process-identity.test.mjs \
  tests/tools/production-build-owner-identity.test.mjs \
  tests/tools/scheduler-finalizer-boundary.test.mjs \
  tests/tools/correctness-attempt-migration.test.mjs \
  tests/tools/correctness-attempt-test-producers.test.mjs \
  tests/tools/correctness-attempt-build-release.test.mjs \
  tests/tools/test-suite-convergence.test.mjs
dotnet test tests/backend/FsusBlog.Server.Tests.csproj -c Debug --no-build \
  --no-restore --filter 'FullyQualifiedName~LifecycleHostedBootstrapServiceTests|FullyQualifiedName~RealConcurrencyHarnessTests' \
  --logger 'trx;LogFileName=chain3620-compiler-controls.trx' \
  --results-directory /tmp/chain3620-current-dotnet-controls
node --test tests/tools/test-lifecycle-governance.test.mjs \
  tests/tools/test-retention-audit.test.mjs
./tools/test.sh backend-unit --fresh
node tools/dotnet/check-csharp-style.mjs --mode changed --base origin/master
```

The full-mode style command used `--mode full` and one `--file` for each of the
seven paths listed by the exact source-comparison archive. Contract commands were
`node tools/governance/check-change-contract.mjs --github-event` with the actual
PR #3844 event JSON, and `--range origin/master..HEAD` respectively.

All raw bytes are preserved in deterministic gzip archives. Round-trip equality
was checked; raw and compressed SHA-256 digests are in observations.json. A
passing repetition does not erase the writer ENOENT or qualify native cleanup.
The original real Linux reaped-child/live-group and refusal controls remain intact.

## Precise unresolved gates

The two real C# failures are unchanged bootstrap assertions at
`LifecycleHostedBootstrapServiceTests.cs:116` and `:165`: expected
`compatibility_check`, observed `current_schema_verified`. Required next handoff
is the canonical owner's exact compatible behavioral/test correction and original
passing cases, preserving the acceptance semantics rather than changing assertions
solely to obtain green. These direct unit diagnostics do not bypass the original
canonical scheduler and are not claimed as its runtime acceptance.

Retention still rejects the Backend context although the actual DLL and
`obj/Debug/net10.0/FsusBlog.Server.Tests.dll` exist. The original MSBuild query
returns `IntermediateOutputPath = obj\Debug/net10.0/`. The original Node
`projectXunitCompileContext` resolves that raw spelling as a literal Linux
`obj\Debug` directory and finds no intermediate DLL. The same exact query used
`dotnet msbuild tests/backend/FsusBlog.Server.Tests.csproj --nologo
-verbosity:quiet -property:Configuration=Debug -property:BuildProjectReferences=false
-getProperty:Configuration,TargetPath,IntermediateOutputPath -getItem:Compile`.
The real observed JSON and live existence checks are preserved. Required next
handoff is the canonical context owner's admitted cross-platform path correction
and original negative-control evidence. No symlink, copied assembly, invented
path, normalized substitute context or fabricated receipt was supplied.

Migration Debug tests still have the two actual CS0246 errors at
`OfflineMigrationExpandSafetyTests.cs:79–80` from the unchanged earlier source.
No supplied compiler increment touched those paths; the exact owner repair and
passing Debug evidence were requested. This stage is not silently omitted.

The writer readiness failure is reproduced on two exact candidates, with passing
unchanged retries. Original first-read `stat` at
`production-build-owner-identity.test.mjs:209` follows a fixed wrapper-exit delay
without waiting for the first write. It remains an unqualified intermittent test
failure; no collector defect or alternate readiness implementation is inferred.
Canonical owner correction/evidence is needed before claiming stable full controls.

Explicit style failures are at AuthoringExtensionRpcBrokerTests.cs:9,
SecurityAdminPolicyDefaultsTests.cs:3 and TaxonomyExactMetadataTests.cs:3/:9.
Keep source style repair with the supplied canonical owner. The changed-mode
checker crash is distinct from those actual diagnostics.

Protected generated/naming policy failures remain unchanged. Commit range now
rejects the four original imported inventory messages plus the new `9b6902f2c`,
`278f6049b` and `b12c78aa2` ports: `cherry-pick -x` added a non-trailer after
Refs, so the original checker rejects their footer block. This port-metadata
failure is introduced here and is reported explicitly. No already-published
history or owner manifest was rewritten merely to claim green. Other new owned
commits use valid Refs trailers. Metadata admission remains unaccepted.

The current fresh lane confirms the unchanged `/..` cgroup refusal. Prior actual
read-only probes establish unavailable user systemd/delegation and missing
catalog MySQL fixture. Needed capability remains an isolated admitted Linux
systemd/delegated-cgroup runtime plus the original catalog fixture for applicable
execution. No production credentials, host configuration mutation or unknown
process kill was used. Native normal/failure/cancellation/timeout/interrupted/
repeated cleanup and independent qualification remain not run or blocked.

Missing remote CI is not a blocker under the local-verification authorization.
Actual code/test/admission failures still prevent an environment-only early
review. No issue closure, PR merge, auto-merge, master push or deployment occurs.
