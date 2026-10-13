# Linux observation after canonical inventory prerequisite

This historical execution record continues #3620 after receiving the exact canonical
#3521 source prerequisite. It is not a canonical runtime receipt, promoted authority,
independent acceptance, or issue closure. The earlier record remains an immutable
observation of its prior source candidate, not a current acceptance receipt.

## Exact source consumption

- Current master verified before work: `3bc9bacd55b4453ed0abd48632c6a1bb3f7944f8`.
- Source and tests in this record: `1625f11cc4570ffa02516ff6a93cf1ef085412b2`.
- Branch: `codex/chain-3620-linux-observation`; draft PR #3844.
- Supplied prerequisite: draft PR #3859. Its later moving tip was not consumed.
- Run identity: `chain3620-20261008T033144Z-1625f11cc457`.
- Exact parent order was verified from current master. All nine affected owner paths
  are byte-identical between the supplied final source and the integration candidate.
  There were no generated-file conflicts or manual digest re-sealing.
- The complete four-commit chain preserves the upstream metadata's declared source
  scope, canonical lifecycle owner and every original retention replacement-ID union.

| Supplied exact source | Local port preserving source bytes |
| --- | --- |
| `f7b29774ae4aebad286539cc033aa736b9dbe613` | `db09bc7eceebfd5cae2126d0a926c8281526dd2b` |
| `86841bac2fb0cdbeb8baa02b218869529abbf093` | `7273eb2f1ba66578057f1a58204a9a5e8cb9d5d1` |
| `eeb4e84096571ecb3a989629825f2508e2de7b71` | `8527aca7b75acd06a159dfd7633b34273acbeb2e` |
| `e38a0badac3867560b5d0fdc1b8d1c648d15ee37` | `1625f11cc4570ffa02516ff6a93cf1ef085412b2` |

## Fresh executed stages

| Stage | Exact command or source owner | Exit | Outcome | Evidence |
| --- | --- | --- | --- | --- |
| Focused current source | Node 24.16.0; original identity, build owner, finalizer model and migration test files | 0 | 46 passed, zero failed/skipped | [Focused](focused.log) |
| Canonical roster/refusal controls | `node --test tests/tools/correctness-attempt-migration.test.mjs tests/tools/correctness-attempt-test-producers.test.mjs tests/tools/correctness-attempt-build-release.test.mjs` | 0 | 11 passed, zero failed/skipped | [Roster](roster-controls.log) |
| Original inventory check | `node tools/test/generate-correctness-attempt-producers.mjs --check` | 0 | Current checked-in source output matches | [Check](inventory-check.log) |
| Original repeated generation | Two unmodified producer executions, compared to each other and the checked-in output | 0 | All 226 producers and 8 source bindings; exact byte equality | [Repeat](repeat-generation.log) |
| Original canonical lane | `./tools/test.sh backend-unit --fresh`, with installed Node 24.16.0 and SDK 10.0.401 | 1 | Beyond inventory admission; refused `Linux cgroup memory invalid path: /..` | [Lane](backend-unit.log) |
| Lifecycle/retention tests, default PATH | Original two test owners | 1 | 45 passed, 1 failed; standalone producer could not find SDK | [Initial](registry-retention.log.gz) |
| Lifecycle/retention tests, SDK PATH | Original two test owners, SDK available | 1 | 45 passed, 1 failed; actual Debug assembly/intermediate context missing | [Retry](registry-retention-sdk.log.gz) |
| Backend context setup, initial attempt | Direct SDK build attempt used an unsupported restore-only CLI argument | 1 | Setup error retained; no compiled context produced | [Initial SDK setup](backend-debug-context.log) |
| Corrected locked dependency setup | `dotnet restore tests/backend/FsusBlog.Server.Tests.csproj --locked-mode` | 1 | `NU1004`: Server dependency graph and Tests lock file disagree | [Locked restore](backend-locked-restore.log) |
| Convergence fixture controls, initial attempt | Original test owner | 1 | Local governance-tools package not installed; no cases ran | [Initial convergence](convergence-controls.log) |
| Convergence fixture controls, after documented locked package install | `node --test tests/tools/test-suite-convergence.test.mjs` | 0 | 17 passed, zero failed/skipped | [Convergence](convergence-controls-retry.log) |
| Commit contract | `node tools/governance/check-change-contract.mjs --range origin/master..HEAD` | 1 | Four supplied/ported commit messages lack required `Refs:` footer | [Range](commit-range.log) |
| PR metadata contract, after fixing local body path enumeration | Original checker on actual PR metadata | 1 | Original generated-only and naming metadata remains unadmitted | [PR gate](pr-contract-retry.log) |

The focused command was `node --test tests/tools/correctness-attempt-migration.test.mjs
tests/tools/run-once-process-identity.test.mjs tests/tools/production-build-owner-identity.test.mjs
tests/tools/scheduler-finalizer-boundary.test.mjs`. Tests preserve the original real
Linux child-exit case and refusal controls. Component models, canonical source-roster
registration and inventory qualification fields do not attest a native execution.

`npm ci --ignore-scripts --prefix tests/tools` used the existing lockfile and a task-local
cache to supply the real repository package; no compatibility module was invented.
After the actual locked SDK restore refused `NU1004`, dependent Debug compilation
and the real retention producer were left unaccepted. No lockfile was regenerated,
locked mode disabled, guessed upstream fix consumed or missing output fabricated.

## Genuine remaining gates

The original canonical lane now passes the specific inventory capability that previously
blocked it. Its new refusal is actual cgroup memory admission, not an open-issue status.
[Fresh sandbox capabilities](capabilities.log) and an approved, read-only
[probe outside the filesystem sandbox](capabilities-unsandboxed.log.gz) preserve the real results:

- systemd user manager is offline/unavailable;
- cgroup mount root is `/..`, rejected by the original path verifier;
- current UID cannot write delegation controls even outside the filesystem sandbox;
- the catalog-pinned MySQL image is still absent.

No host configuration, cgroup, user unit, Docker fixture, production service or quota
was modified. No native Migration/MySQL execution or finalized canonical cleanup
occurred. Native normal/failure/cancellation/timeout/interruption/repeated cleanup and
independent qualification therefore remain unverified.

The upstream source refresh also remains unaccepted for generic generated-only repair.
The trusted metadata checker rejects unchanged generator/source paths and the supplied
external-naming manifest's retention-path registration and exact changed-surface union.
The original four commit headers/bodies are preserved as supplied; their missing footer
failure is reported, not waived or silently described as a passing gate. The two upstream
current-epoch retirement admissions remain unaccepted; fixture convergence tests are
not those history gates. This record changes none of those policies or historical seals.

#3620 remains **blocked**. It is the only assigned execution issue; there are no tracking
issues or additional assigned downstream nodes. Required next handoffs are a genuinely
usable isolated Linux systemd/delegated-cgroup runtime, a canonical owner correction for
the actual Tests/Server locked dependency graph, and independently admitted metadata
for the supplied source refresh where publication gates require it. Keep every original
runtime and qualification gate. Do not substitute component passes or a source candidate
for cleanup evidence. No PR merge, issue closure, auto-merge or deployment is performed.
