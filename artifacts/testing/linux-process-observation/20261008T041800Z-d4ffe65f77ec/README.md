# Linux observation after pinned dependency handoff

This is an informational historical execution record for #3620. It is not a
canonical runtime receipt, promoted authority, independent acceptance or issue
closure. Earlier failures remain historical and are not current acceptance.

## Source and environment binding

- Tested candidate: `d4ffe65f77ec90282b432a92bd5d0e76e3837bcf`.
- Run identity: `chain3620-20261008T041800Z-d4ffe65f77ec`.
- Branch: `codex/chain-3620-linux-observation`; draft PR #3844.
- Start master: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`.
- Final fetched master: `8b1c739cacef47995f441f096835863d377dc347`.
  Its two added commits only change `.github/actionlint.yaml`. They do not change
  the owned process collector or tests; no cross-chain conflict resolution was run.
- Official Node 24.16.0, SDK 10.0.401 and runtime 10.0.12; Linux x64.
- Installed tools and caches are task-scoped. No production resource was used.

The current issue body and relevant comments were reread, including the original
#3568 session's exact authorized handoff. This issue has no recorded external
issue prerequisite, but current-source execution still depends on the original
canonical inventory, actual compile context and native resource admission.

## Exact source consumption

| Supplied source tree | Consumed scope | Published local commit |
| --- | --- | --- |
| `2c380fee5cff5fa0e368b3da0a4052a4fe124263` | Backend Tests canonical AngleSharp lock edge from the cumulative tested tree | `9e7a69017334015d72f40037cd39899d6275278b` |
| `e3553bfb1ade96bb6ac6609bf92efc42de3913be` | Migration versionless approved native PackageReference and own generated lock | `4bced095d57f85c1af121a963facb83160768486` |
| `bf518133d472bf31f67a564f68423e3a4a8a4a1b` | Backend and Migration test consumer SQLite locks | `d4ffe65f77ec90282b432a92bd5d0e76e3837bcf` |

The initial five-observer-lock offer is not represented as a seven-file diff.
The cumulative exact `2c380fee` tree includes the canonical Backend edge.
Only needed paths were consumed. No observation project, benchmark, moving tip
or intermediate C# change was consumed. All four current affected paths are
byte-identical to the authorized source trees; [comparison](source-bytes.log.gz).
The previous four exact #3521 prerequisite commits remain present, with their
original messages and historical admission limits retained.

## Commands and observed results

For SDK commands, PATH puts the installed Node and SDK first; DOTNET_ROOT,
DOTNET_CLI_HOME and NUGET_PACKAGES point at task-scoped locations. Telemetry is
opted out. Subsequent native commands use `MSBUILDDISABLENODEREUSE=1`; builds
use `--disable-build-servers -m:1`. NuGet audit and locked mode are retained.

| Stage | Exact command | Exit | Result | Raw evidence |
| --- | --- | --- | --- | --- |
| Backend restore | `dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --locked-mode` | 0 | Current graph accepted; no former NU1004 | [Restore](backend-restore.log.gz) |
| Migration restore | `dotnet restore tests/migration/FsusBlog.Migration.Tests.csproj --locked-mode -m:1` | 0 | Current graph accepted | [Restore](migration-restore.log.gz) |
| Controls | Seven original Node test owners listed below | 0 | 68 passed, zero failed/skipped | [Controls](controls.log.gz) |
| Backend Debug context | `dotnet build tests/backend/FsusBlog.Server.Tests.csproj -c Debug --no-restore --disable-build-servers -m:1 -v minimal` | 1 | 1065 warnings; four CS0182 errors | [Build](backend-debug-build.log.gz) |
| Migration Debug context | `dotnet build tests/migration/FsusBlog.Migration.Tests.csproj -c Debug --no-restore --disable-build-servers -m:1 -v minimal` | 1 | 1554 warnings; two CS0246 errors | [Build](migration-debug-build.log.gz) |
| Lifecycle/retention | `node --test tests/tools/test-lifecycle-governance.test.mjs tests/tools/test-retention-audit.test.mjs` | 1 | 45 passed; one failed; zero skipped | [Tests](registry-retention.log.gz) |
| Original canonical lane | `./tools/test.sh backend-unit --fresh` | 1 | Refused actual cgroup path `/..` | [Lane](backend-unit.log.gz) |
| PR contract | `node tools/governance/check-change-contract.mjs --github-event` with actual PR #3844 API metadata | 1 | Protected generated/naming failures | [Contract](change-contract.log.gz) |
| Commit contract | `node tools/governance/check-change-contract.mjs --range origin/master..HEAD` | 1 | Four earlier imported messages lack `Refs:` footer | [Range](commit-range.log.gz) |

The exact controls command is:

```sh
node --test tests/tools/run-once-process-identity.test.mjs \
  tests/tools/production-build-owner-identity.test.mjs \
  tests/tools/scheduler-finalizer-boundary.test.mjs \
  tests/tools/correctness-attempt-migration.test.mjs \
  tests/tools/correctness-attempt-test-producers.test.mjs \
  tests/tools/correctness-attempt-build-release.test.mjs \
  tests/tools/test-suite-convergence.test.mjs
```

The original real Linux reaped-child and live-group tests and all fail-closed
negative controls remain unchanged. Component tests do not qualify native cleanup.
All archives preserve complete raw bytes; deterministic gzip round-trip equality,
raw and compressed SHA-256 digests are in [observations](observations.json).

## Remaining blockers and handoff

Backend compilation reports CS0182 at
`tests/backend/Unit/LifecycleHostedBootstrapServiceTests.cs:23–26`.
Migration compilation reports CS0246 for `CreateTableStep` and `AddColumnStep` at
`tests/migration/OfflineMigrationExpandSafetyTests.cs:79–80`.
These are actual non-environment code failures on this candidate. Required next
handoff: canonical owners' exact compatible compiler-fix commits and their passing
Debug build evidence. No guessed C# fix or substitute assembly was introduced.

The original retention CLI case fails because a successful Backend Tests Debug
assembly/intermediate context is still missing. Earlier NU1004 is now cleared.
Native execution and normal/failure/cancellation/timeout/interrupted/repeated
finalizer cleanup remain unaccepted. The unchanged original cgroup verifier still
rejects `/..`; previous read-only capability probes establish unavailable user
systemd and writable delegation, and absent catalog-pinned MySQL fixture. Required
next capability is an isolated admitted Linux systemd/delegated-cgroup runtime
plus the exact catalog fixture for applicable execution. No fake receipt, resource
kill, host configuration change or destructive database action was used.

The generic generated binding still names eight unchanged source paths; the
external-naming manifest still has an unregistered retention path and incorrect
exact union. Four imported commit messages still lack required footers. The new
three dependency commits have proper `Refs: #3620` footers. Required admission is
from the canonical source owner; public history and original manifests were not
rewritten or resealed. Missing remote CI is not a blocker under the latest local
verification authorization; actual protected local gate failures remain blockers.

#3620 is the entire one-issue assignment and remains **blocked**. There are no
tracking-only issues or additional owned downstream issues. Current source and
local controls are verified; native runtime/finalizer and independent acceptance
are not. This candidate does not qualify the environment-only early-review
exception because code and metadata failures remain. No PR merge, issue closure,
auto-merge, direct master push or deployment was performed.
