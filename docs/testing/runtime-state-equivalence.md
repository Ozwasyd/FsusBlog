# Runtime state isolation and order equivalence

Production runtime correctness uses one state-access authority:
`config/testing/runtime-state-domain-catalog.json`, backed by
`runtime-state-domain-registry.json`. The registry also binds every domain to
exactly one observer implementation. Scheduler code, lane scripts and fixtures
must not keep another domain, conflict or observer table.

The static command analyzer preserves operation findings inside shell conditions,
with the source expression, guard line and any recognized parameter aliases.
The public-content invocation guard requires the matrix source, a nonempty sealed
consumer and one of its two profile literals observed from the current shell
source. Explicit `conditionEnvironment` values are diagnostic inputs to a
three-valued observation (`true`, `false`, `unknown`), not sealed runtime evidence.
Missing values, dynamic fallbacks and unsupported conditions remain unknown.
Findings and undeclared-operation refusals remain present even when supplied
diagnostic values evaluate a guard to false. Step or function names do not waive
effects, and `RunTier` does not reseal a fixture profile. These source observations
grant no runtime qualification or permission to omit state-domain evidence.

## Execution sessions

`RuntimeExecutionSession` creates a distinct current-run/current-attempt root
and mutable handle for every required domain. Its identity includes run,
attempt, session, source/worktree, sealed build, fixture, execution envelope,
clock, replay and state-catalog digests. A domain adapter must implement clone,
reset, readiness and cleanup, and every returned handle must name the current
run, attempt, session and domain. Missing isolation, shared namespaces,
cross-attempt receipts and root reuse fail before runtime work begins.

The lifecycle journal is append-only. Creation, reset, cancellation, failure
and cleanup do not overwrite an earlier session or delete retained evidence.
The mutable root may be cleaned by its owner, while the lifecycle evidence is
preserved for qualification.

## Snapshots and observers

`tools/test-runtime/state-snapshot.mjs` defines the fragment and aggregate
protocol. Snapshots are required at `before-runtime`, before and after every
mutating step, and `after-runtime`. A fragment binds the complete execution
identity, domain, observer/version, boundary and semantic digest. The aggregate
contains content-addressed fragment references instead of copying payloads.

Canonical values distinguish null from absence, reject undefined and
non-finite values, sort object fields, and require each domain observer to
provide its own stable record order. PID, ephemeral ports, inode, mtime, host
paths and wall-clock collection timestamps remain diagnostic metadata. A field
that changes business meaning must instead be normalized through the sealed
clock, replay or domain contract.

The exact observer owners are declared by the registry and implemented under
`tools/test-fixtures/observers/`:

- PostgreSQL and Redis observers consume current-session readonly ports,
  canonicalize complete declared rows/keys, and bind TTL to the fixed clock.
- File-tree, auth/browser state and object-storage observers accept sealed
  session handles only. They reject path escapes, shared namespaces, partial
  pagination and unobservable state. Secrets use a protected, domain-separated
  HMAC fingerprint; plaintext and fingerprint keys never enter receipts.
- AOT generation, resolved configuration and runtime topology observers compare
  planned and actual identities exactly. They do not select `latest`, read
  ambient environment defaults, scan the host, repair state, restart services
  or use tag/name/PID/port-only truth.

Every observer reports side-effect counters. Any write, token refresh, repair,
lifecycle transition or topology mutation makes the observation terminally
invalid.

## Conflict admission and reset barriers

The production runtime DAG calls the pure `stateConflict(A, B)` evaluator
before resource admission. A mutation overlapping any access, an exclusive
domain overlap, generation invalidation overlap, or topology mutation overlap
blocks admission. Two writers may overlap only when both catalog entries name
the same proof and that proof is verified. The wait record includes blocker
step, domain, access modes, rule, proof and catalog digest.

State admission adds to dependency, CPU, memory, exclusive/countable resource
and service admission. It never replaces them and does not introduce a global
runtime lock. Catalog drift or an unknown step fails the run.

A `resetBefore` or `resetAfter` command holds only its catalog-derived affected
domains. Exit code zero is necessary but insufficient: the reset owner captures
before/after fragments and verifies every affected-domain postcondition before
atomically publishing the receipt and new generation. Failure, timeout,
cancellation, observer error, stale evidence or a mismatched postcondition
keeps the barrier closed. A retry is a new attempt and cannot hide the first
failure.

## Schedule qualification

The required matrix contains canonical, fully serial, reverse-ready and five
fixed-seed dependency-valid shuffled plans. It exercises concurrency caps one,
two and the machine-allowed maximum. A semantically duplicate serial/cap plan
retains its identity and a deduplication proof. Every executable plan creates a
new session from the same immutable source, build, fixture, clock, replay,
envelope and catalog identities.

Qualification compares exact executed step and assertion IDs, structured
outcomes, postconditions, terminal class and final semantic digest. The first
difference fails as `runtime-state-order-dependent`; retry, skip and diagnostic
downgrade are forbidden. At least one catalog-proven non-conflicting pair must
overlap with cap greater than one, which rejects global serialization.

The release command is:

```bash
node tools/test/run-runtime-order-equivalence.mjs \
  --all-required-schedules
```

The command selects
`tools/test-runtime/production-runtime-order-provider.mjs`; `--provider` is
reserved for an independently reviewed production adapter and is not a test
fallback. The canonical provider requires
`FSUSBLOG_RUNTIME_ORDER_IDENTITY_FILE`; the default binding is
`tools/test-runtime/production-current-run-binding.mjs`, while
`FSUSBLOG_RUNTIME_ORDER_BINDING_MODULE` is only an explicit reviewed override.
`tools/test-runtime/produce-runtime-order-identity.mjs` is the sole producer
for that identity file. It verifies the current production-build and replay
receipts against the same run/source, binds the canonical fixture catalogs,
execution-envelope policy, fixed epoch and state-domain catalog, and seals
their digests before any schedule is created. The current-run build-authority
producer passes that same source commit to the server build through
`FsusBlogCommitSha` and builds the migration project before the backend test
project under the same production build layout and Release writer lock.

The provider reopens and
revalidates every referenced regular non-symlink file; a stale build, replay,
fixture, envelope or catalog cannot authorize a run. Its session root defaults
to the repository-contained `.tmp/runtime-order-sessions` and may be overridden only
with another repository-contained `FSUSBLOG_RUNTIME_ORDER_SESSION_ROOT`. The binding may supply only sealed
current-session adapters, readonly observer ports, coordination verification
and reset-postcondition verification. It cannot supply snapshots, fragments,
schedule results or the final receipt: those remain owned by the canonical
runner, observers and `run-bundle` hooks.

Every executable plan starts a distinct `RuntimeExecutionSession`, runs the
actual `runtime-browser` bundle with the explicit plan, captures
`before-runtime`, both boundaries of every real mutating step and
`after-runtime`, and then performs postflight and cleanup. PostgreSQL and Redis
production ports read the exact session-owned container/table/key handles and
use readonly `SELECT`, `SCAN`, typed reads and TTL observation; they reject
shared patterns or containers before observation. Missing binding operations,
unverified coordination, incomplete reset predicates, absent domain handles or
unsupported live state abort the command without writing an equivalence
receipt. Until replay and execution-envelope chains provide current receipts,
their digests remain mandatory external inputs and qualification fails closed
rather than inventing local defaults.
