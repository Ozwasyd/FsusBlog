# Production cgroup and OCI resource enforcement

Linux local production can map scheduler grants to cgroup v2 and Docker/OCI limits. The switch is
`FSUSBLOG_CGROUP_ENFORCEMENT=auto|strict|advisory|off`:

- `auto` attempts the selected Linux cgroup backend and otherwise records an explicit advisory reason;
- `strict` has the same capability probe but fails before bundles start if enforcement cannot be created;
- `advisory` retains application-level worker grants and evidence without mutating cgroups;
- `off` is an explicit rollback switch. It does not claim enforcement.

The local production CLI selects the systemd user-manager backend for durable bundle execution. MySQL-requiring logical, workflow, and production entry points select strict enforcement; ambient advisory/off switches do not remove that fixture requirement. The scheduler derives
its exact resource context from the acquired run owner, rather than accepting another caller-selected scheduler token.
Its OS-control command and resource startup budgets come from `systemdControlCommandTimeoutMs` and
`systemdResourceStartupTimeoutMs` in the existing physical-execution process policy. They bound control operations,
not payload execution; the tier and global execution deadlines still apply.

For the direct filesystem backend, an alternate delegated root can be supplied with `FSUSBLOG_CGROUP_DELEGATE_ROOT`. It must be inside the cgroup v2
mount, writable, and expose `cpu`, `memory`, and `pids`. The production-only hierarchy is
`fsusblog-production/<run-id>/<physical-bundle>`. Ordinary tests and CI DAGs default to advisory and never create this
hierarchy. GitHub-hosted runners, rootless sessions, and non-Linux hosts therefore remain usable while their evidence
states the unsupported or permission-limited reason. Set `strict` only where systemd, the container runtime, or the
runner has delegated the controllers.

For a systemd user manager that permits delegation, an isolated strict invocation is:

```bash
systemd-run --user --scope -p Delegate=yes --quiet \
  env FSUSBLOG_CGROUP_ENFORCEMENT=strict ./tools/test.sh production --fresh
```

The direct filesystem backend moves the runner into a private manager leaf before enabling controllers, but only when it is the sole process
in the delegated scope. A shared terminal/tmux cgroup is never rearranged; it degrades with `EBUSY` instead.

## CPU and memory policy

Every bundle receives both `cpu.weight` and `cpu.max`. Weight preserves the scheduler's relative share under
contention. `cpu.max` is a hard ceiling equal to the current dynamic CPU grant, so an uncooperative Chromium, MSBuild,
Vite, testhost, or native descendant cannot consume a sibling's allocation. This quota is an isolation boundary, not
a performance technique. A benchmark receives a stable full grant only after the scheduler's exclusive
`benchmark-window` and dependency rules release sibling resources; throttling is never counted as an optimization.
Fractional CPU quota is quantized downward; enforced grants below the kernel's representable minimum are rejected
before writing controls rather than enlarged to a higher CPU allocation.

`cpuset.cpus` is deliberately disabled: topology, NUMA placement, heterogeneous cores, and dynamic redistribution are
not yet proven. A wrong cpuset can make throughput and benchmark variance worse even when CPU counts appear correct.

`memory.high` floors the scheduler memory grant to whole bytes, then projects it downward to the observed kernel page size. `memory.max` adds
machine-derived safety headroom and rounds downward to the same page size while remaining inside physical memory;
`pids.max` is derived from both granted CPU and memory. Linux enforcement observes `getconf PAGESIZE`; a caller-supplied
page size cannot replace the host observation. Grants below the existing 16 MiB process minimum are rejected rather
than enlarged beyond their admitted envelope. Expansion or contraction rewrites all
effective controls without restarting the bundle. The scheduler evidence compares every declared grant with the
values read back from `cpu.max`, `cpu.weight`, `memory.high`, `memory.max`, and `pids.max`.
Any mismatch rejects the update; it is not appended to effective grant history. A failed or partially written update
invalidates prior admission until a new update passes. Before attaching a stopped process, the owner rereads all five
controls, then verifies PID membership and rereads controls again before returning permission to resume. Reporting
objects cannot substitute for the privately retained admission grant. Dynamic worker-grant publication follows
successful enforcement read-back, never precedes it.
Any CPU or memory grant above the admitted machine envelope fails before control files are written, so enforcement
cannot silently clamp an oversold grant or emit an invalid `memory.high > memory.max` pair.

Linux available-memory sampling maps unified membership through mountinfo and walks every visible cgroup v2
ancestor. Non-root views require the mapped leaf's actual process membership, not directory existence alone.
Each finite memory.max contributes its own subtree headroom (max - memory.current, clamped to zero), capped
by Node free memory. A leaf max needs no numeric usage but never hides finite parents. No v2 view or all-unlimited
visible limits retain the Node fallback; ambiguous mapping, malformed finite controls, unreadable controls, missing
finite usage or membership migration fail instead of claiming unrestricted memory. Limit reads around usage retain
the smaller observed ceiling, not an atomic reservation. Darwin/Windows sampling, advisory mode, CPU/PID formulas
and enforcement remain unchanged. Zero headroom stays zero here; caller floors and workload fit require separate
admission verification.

The read-only inherited-mount locator supports only self membership `/` with the exact mountinfo root marker
`/..`. It does not normalize that marker into a filesystem path. It examines at most 256 directory entries and
64 direct child cgroups, requiring canonical contained directories on the visible mount's device, domain cgroup
types and exactly one child containing the real current PID. Missing or ambiguous observations refuse. Its result
is location information only; the existing memory sampler reads the selected child and mounted parent controls,
requires both visible directories' memory controls to be readable, and retains the existing headroom calculation.
The ordinary sampler callers acquire this capability through the same module; there is no new CLI/environment
override for a leaf, PID or capacity. Controlled I/O adapters are unit-fixture inputs and confer no authority.
This bounded increment does not attest inaccessible ancestors, identity/race/TOCTOU/custody safety, reservations
or runtime qualification. Those held audits are separate; a located PID alone cannot satisfy them.

## Process and container attribution

In direct filesystem enforced mode the bundle entry shell starts stopped, the scheduler moves it into the bundle cgroup, and only then
resumes it. Ordinary descendants therefore inherit the boundary without a spawn race. Application-level worker
planning remains authoritative inside the boundary (`FSUSBLOG_STEP_CPU_BUDGET`, Playwright workers, .NET processors,
MSBuild `/m`, and similar settings).

This inheritance claim applies to ordinary descendants, not to work launched by a separate systemd service. The
systemd-backed scheduler now launches its root service through the existing physical execution owner and verifies
the actual pre-exec PID under the shared resource ancestor. A nested controller does not inherit this in-process
capability: it requests execution from that original owner through the authenticated channel below. Root-service
enforcement alone is not proof that a separately created or unregistered service is constrained.

The canonical `runtime-browser` bootstrap starts backend, frontend and preview processes with `nohup` and
`setsid`; those calls do not transfer the processes out of their service cgroup. A producer command that exits
while its service has live descendants is rejected and terminated unless the original build owner independently
retains an exact resident transfer before the physical execution owner returns.
For a resource-bound resident producer, the owner now uses a separately bound nonblocking `systemd-run` sender and
precreated 0600 private stdout/stderr files because `--pipe` and `--no-block` cannot be combined. The durable build
owner checks the exact sender plan and file identities before creation; live recovery preflight checks identity
without assuming growing logs are static. After verified zero-member cleanup the physical owner checks the signed
sender terminal and captures the unchanged file bytes and digests. Active output
descriptors, file drift or an unproved sender terminal retain failure rather than completing a tier. For a live
producer, the scheduler additionally validates the resident inventory, actual service members and resource
ancestor; the original build owner durably binds that inventory digest, live supervisor/member identities, exact
service binding and captured output prefix. Only this read-back permits `resident-transferred` settlement. The
consumer can then use the existing resident handoff; after the consumer finishes, the original owner terminates
the exact service, verifies zero members and unchanged output (or the fsynced original cleanup plan on retry), and removes its private and nested-channel carriers
before the resource boundary may be released. Missing transfer or cleanup proof retains failure rather than
claiming success. A real scheduler/owner component fixture covers this path, but does not qualify the canonical
production lane or independent acceptance. A separate real Linux adapter fixture injects interruption before the
cleanup plan is published and after one resident output file is deleted; it retries only with the exact fsynced plan
and refuses an unknown sibling carrier. Another real resource-component fixture kills the original controller and
then the recovery process during output deletion, before proving an exact retry. Full build/scheduler recovery is
not inferred from those components.
For enforced resident leases, the scheduler now rereads each live process's `/proc` start identity and unified cgroup
before grant changes and while reconciling handoff. It rejects a process outside the exact admitted ancestor, a
changed PID incarnation, or a claimed exit contradicted by a live process; this read-back is an admission guard, not
a transfer of termination ownership.

If process registration or resource attachment rejects an unreleased stopped launcher, the scheduler terminates that
launcher through the existing process-group owner without resuming it. The resume latch stays closed once termination
starts. This prevents a rejected admission from executing its workload during error cleanup; it does not replace the
separate identity/control check for the actual durable service and nested units before their payload release.

The resource-side systemd adapter is `tools/test-matrix/production-systemd-resource-boundary.mjs`. The existing resource
enforcer provides the systemd backend selected by local production's durable scheduler. The adapter creates one shared transient slice only after writing a private,
fsynced owner/state record under `.tmp/production-resource-owners/` and receiving an acknowledgement of the exact
binding from the caller's independent durable store. Records bind repository, run, namespace, bundle, source state,
scheduler-owner token, original controller, and observed local user-manager identity. A new scheduler incarnation has
a different token; old unresolved resources must still be reconciled by the capacity owner before admitting new work.
The authority directory is outside the fresh scheduler checkpoint reset and is not an allocator or a second scheduler.
`production-build-layout.mjs` provides the independent retention interface and includes exact references in its v2
process-tree receipt. The build owner accepts a new binding only before resource creation, from its own live controller
and exact source/run/scheduler context; it durably writes both owner records before acknowledgement. Its terminal and GC
checks reobserve actual resource absence, and failed finalization retains unresolved resources rather than deleting the
active marker. The local production CLI supplies these independent retention callbacks to the scheduler.

`createProductionResourceEnforcer` and its `attach` method are asynchronous; scheduler callers await both. The explicit
`systemdBoundary` configuration supplies the exact run/source/namespace/scheduler context, independent retention callback,
and command/startup budgets. This backend uses the existing grant projection, private admission, control read-back and
history; it does not allocate a grant per service. Its `executionBoundary` result requires a currently verified grant,
not a reporting object. The result carries an in-process owner capability: serializing or copying its report fields
does not preserve admission authority. A failed control observation invalidates admission until a successful new update. Missing
counter files remain unavailable (`null`), not fabricated zeroes.

`runPhysicalExecution` can explicitly receive that capability as `resourceBoundary`, with the caller's independently
selected exact `resourceContext`. The Linux process owner checks context equality and the literal working directory,
persists the intended service/resource binding in its private fsynced control root before creation, and creates the
service under the shared slice with an ownership-bound Description. Immediately before its existing one-shot pre-exec
signature, it rechecks the live owner's admission, actual service invocation/cgroup/artifacts, real process identity and
membership, ancestor and current controls. An existing service, copied capability, cross-context use, moved process or
revoked grant cannot authorize payload release. No new per-service grant is allocated.

For scheduler-owned execution, the optional `processOwner` interface is mandatory. Before unit creation it retains
the v2 containment intent in the existing build owner, bound to the exact resource reference, parent identity, process
authority UUID, service name/Description, and private control-carrier device/inode and contents. At the existing pre-exec
gate, `registerProductionBuildCompiler` advances that same intent to a receipt binding the observed service invocation,
cgroup/artifacts and actual Python pre-exec identity. It does not fabricate the image that will later replace Python
with `execve`. Both records are durably read back; a missing or different acknowledgement refuses release. The execution
owner rechecks current controls and process membership after registration and before signing. The same receipt drives
read-only build lifecycle observation and exact-identity process-owner termination; it never falls back to name-only
termination. The resource owner remains empty-only.

The scheduler pauses release until its own grant publication and process observation are ready. In-flight creation is
included in cancellation and deadline handling. Physical output is streamed with backpressure into the existing
authoritative async log pipeline, which drains before settlement; the physical owner's bounded diagnostic capture
does not truncate that log. Real scheduler tests cover actual payload ancestry, greater-than-1-MiB output, denied intent
acknowledgement/registration/receipt, pre-release timeout/cancellation, and externally requested exact service termination.

The existing process owner also checks that exact service ownership before kill/stop effects. Quota drift rejects
admission but does not by itself revoke its right to terminate the same owned service; unknown or replaced services
remain fail-closed. The resource owner still only removes empty resources. This explicit in-process API is covered by
real Linux service/payload-ancestor and pre-release-revocation tests, separately from simulated identity/drift negatives.
Its capability cannot be transported to nested controllers as an environment variable or JSON reference.
Cross-incarnation grant reconciliation now has the explicit component entry point described below. Automatic canonical
CLI orchestration and hard-controller-interruption qualification remain required before #3527 acceptance. Disk-capacity
retention uses the existing build owner; it does not substitute for those missing integrations.

For an interrupted Linux build whose services all reached independently retained pre-exec registration,
`recoverProductionBuildResourceTree` accepts the existing exact build-owner reference retained by capacity ownership.
It requires a proven-dead original controller, unchanged private dual owner records and source/directory identity,
an inactive matching scheduler owner, and exact retained resource and service bindings. It shares the build root's
exclusive reclaim marker with GC instead of scanning unit names or adopting resources. The process owner revalidates
that independent owner before every service observation/effect; only then may the resource owner remove empty parents.
An unknown sibling remains running and keeps the capacity observation retained. A later retry can finish after that
sibling's own owner has removed it. The original build receipt is not rewritten or relabeled successful.

`reconcileSchedulerResourceGrants` wraps that same resource-tree recovery with an actually acquired scheduler lease for
the original run/source/candidate/target/budget. Its opaque in-process capability cannot be copied from an owner record
or a cleanup report. The build owner verifies that lease and its own reclaim marker before effects, and retains both
exclusions through actual service/ancestor/carrier absence, journal fsync and worker projection publication. Only the
existing scheduler journal writer can settle the original grants; their owner token remains the original token. A
reconciliation event preserves the prior grant/retention state, original cleanup failure and new recovery-owner binding.
An interrupted running checkpoint becomes a failure, never success; existing failures and original build receipts stay
unchanged. Unknown bundle grants, resident reservations, pending services and unknown siblings fail closed.

If journal fsync succeeds but compact/compatibility or grant projection publication fails, capacity observation continues
to reject the inconsistent projection. A retry under a new exact lease reobserves the original resources, then repairs
only the exact original-to-settled projections without appending another release event. An interrupted build
`.reclaim.json` may be replaced only after the new scheduler recovery capability proves its current exclusive lease,
the marker is a private literal singly linked record for the exact original build reference, and the different prior
recovery process incarnation is proven dead. Its file identity and contents are rechecked before removal; an unknown,
live, changed, foreign or otherwise unverifiable marker remains untouched. A direct build-reference call without that
capability still refuses even an exact dead marker. A crash after removal but before the new exclusive marker is written
cannot release resources or grants; the next owner must reobserve them. This component does not adopt another live
recovery lease or integrate resident-lease reconciliation. Those cases and full canonical lane qualification remain
incomplete work.

The inner resource owner applies the same exclusion to `recovery.lock/owner.json`. Only the capacity-owned build path
passes its exact scheduler/build recovery guard. A retry checks the private literal lock directory, its sole private
owner record, unchanged directory/file identity and bytes, a distinct dead prior recovery process, and the still-live
outer guard before replacing that lock. The guard is checked again before resource observations, state writes, each
unit stop and lock removal. Direct adapter recovery still rejects a pre-existing lock, even if its owner is dead;
empty directories, unknown entries, changed files and live or unverifiable owners remain blocked. This does not infer
that a pending service was never created, or prove a mid-effect interruption with an unrecorded inner lock owner.

The build owner durably changes a `prepared` service intent to `create-attempted` before a gated sender may submit
`systemd-run`. The adapter writes an exact private submission plan, verifies the sender's live process identity and
ephemeral public key, and requires the owner's durable acknowledgement before releasing the sender over private IPC.
After the original controller dies, an unchanged `prepared` intent proves that this owner never released a sender.
Recovery still requires the exact service to be absent and rejects a service unexpectedly present under an
unattempted binding. A real controller-SIGKILL test covers this pre-attempt window.

For a `create-attempted` intent, recovery reobserves and terminates only its exact service. It can release the
parent boundary and grant only after the retained sender is provably dead, its private plan remains bound to that
service, a signed and fsynced terminal receipt matches the retained public key, the exact manager job has no current
entry, and service termination reads back zero members. A signed `not-submitted` receipt closes the interruption
between owner acknowledgement and release; a `sender-returned` receipt requires `systemd-run --wait` to have exited
zero. That exit code proves sender completion for cleanup, not business workload success. Missing, invalid, foreign,
nonzero or still-live sender evidence retains the parent, carrier, grant and capacity even when the unit is absent.
The real controller-SIGKILL fixture covers both terminal windows, missing and forged receipts, and an unexpected
unattempted service. An unknown or drifted service remains fail closed. A killed sender during submission can lack a
terminal receipt, so this recovery deliberately retains its ledger rather than inferring a future unit is impossible.
Before removing control carriers, the same build recovery owner durably seals the verified sender plan and signed
terminal receipt in its private per-run recovery journal. A retry after carrier removal must revalidate that exact
journal against the original authority and sender key; a missing, foreign or altered journal retains capacity and
grants. This journal records cleanup proof without resealing the interrupted build's original process-tree receipt.

After capacity admission, BehaviorDoc receipt verification and the lease-bound source check, local production invokes
the reservation's `reconcilePriorBuildResources` before Fresh cleanup and physical build producers. Projection-only
resume does not invoke resource recovery. A failed admission or source check performs no recovery. It discovers prior
owners only from private, literal, singly linked capacity journals
for this exact repository, not unit names, resource-directory scans or caller-supplied cleanup reports. The new
reservation is acquired while the old admitted bytes remain charged; a capacity rejection performs no resource
recovery. Low free space is not permission to move cleanup ahead of admission. Recovery additionally reobserves the
current process's actual exclusive repository lease, candidate and owner token. The same guard runs at the existing
scheduler recovery capability checks before resource effects and grant publication. A copied lease, live original
controller, changed receipt or unknown resource refuses recovery and retains the old capacity. Only after the
scheduler and build owners prove resources and grants released does the existing capacity writer archive the old
reservation as aborted. Original build receipts and failure state remain unchanged; the new reservation stays charged.

Real component evidence covers original-controller `SIGKILL`, root/child/grandchild services and a setsid descendant,
live-controller refusal, source/directory/private-file drift, competing reclaim marker, revoked recovery authority,
and an unknown same-parent service. After proving the original controller dead and all exact services and parents
absent, the existing process owner reclaims only independently retained control/socket carriers. It preflights every
carrier before deleting any: original directory device/inode, private singly linked regular files, the closed producer
file roster and original prepared binding, plus the channel directory/socket identities and dead original broker.
Unknown files, replacement directories or sockets, symlinks and hardlinks fail closed. Before each control-file removal,
it revalidates the independent owner and the complete remaining file identities and bytes; the binding is removed
last among original files, followed by the resident cleanup plan when present.
Interrupted partial removal can retry against that original binding or the exact empty directory. Resident output
cleanup first durably retains its original roster and content digests in a private plan; a retry accepts only an
unchanged suffix of the planned deletion order after the service and owner are reverified. A pending unpublished
plan may be discarded only while the complete original roster is still intact. Missing output without that plan,
unexpected siblings and plan drift retain failure. File bytes, including
environment values, are not copied into recovery diagnostics. Removed directories are fsynced through their parent.
Capacity and GC/Fresh observations retain the build's ownership records until both its carriers are gone and the
original scheduler journal proves settlement. They use the scheduler's read-only, exact run/source/candidate/token
binding; missing, empty or compact-boundary-truncated journals, missing grant state and mismatched projections cannot
release capacity. Unverifiable carriers also remain fail-closed. Resource-tree recovery still observes OS/carrier
absence separately: its `resources-released` report does not claim that held scheduler grants or disk capacity were
released. A direct build-reference call does not release a scheduler grant, take over a reclaim marker, or qualify a new
run. Pending service creation retains grants even after an exact already-created service is terminated; independent
creation-job reconciliation is still required. Exact dead
outer/inner recovery-lock takeover and a downstream publication-failure retry have real component coverage; they do not
qualify unrecorded mid-effect recovery-controller interruption. The CLI connection above does not qualify resident handoff, partial
creation or a complete production lane; neither empty-parent recovery nor the pre-exec component path substitutes for
those acceptance cases.

The interrupted-controller component fixture executes a materialized copy of the actual scheduler, build owner and
physical execution modules. The shared ESM fixture materializer follows static and literal dynamic imports using
syntax parsing, including literal `new URL(..., import.meta.url)` imports; comments and string contents are not
dependency declarations. Runtime entry scripts are separate ESM roots, and Python/PowerShell/shell assets and the
canonical release-final evidence-input JSON are explicit
entrypoint-owned paths: all must be present, literal regular files within their declared roots before copying. The
fixture preserves source bytes and file modes and rechecks the resulting closure. These component observations do not
replace canonical matrix/input-authority admission or the complete production lane.
In particular, copying these inputs does not authorize a reduced CLI matrix: the finalizer graph, finite argv/source
index, generated execution-target authority and the canonical correctness-attempt producer inventory must remain
mutually consistent. Materialization tests alone do not prove CLI execution reached its intended scenario.

For build-owned root services, the existing physical owner creates a private per-bundle Unix channel. The v2 service
intent includes its descriptor: exact resource reference, original controller and broker identities, directory and
socket device/inode and response-verification key. It is retained with the same independent build receipt before root execution.
`FSUSBLOG_PHYSICAL_EXECUTION_CHANNEL` carries only this locator/descriptor, never the resource capability or private key.
The Python standard-library transport obtains `SO_PEERCRED`; it cannot execute commands or grant resources. The original
owner verifies the kernel peer's full process identity and membership in an exact independently registered service
with that channel. The caller independently checks the retained descriptor/socket/owner and a fresh signed challenge
response. A copied descriptor outside the service, changed channel identity, missing channel inside the resource
hierarchy or an alternate/injected platform route cannot authorize nested execution.

The original owner executes accepted requests through the same `runPhysicalExecution` path and current live resource
capability. Every nested service gets its own exact prepared/create-attempted/pre-exec termination receipt in the existing build owner,
but shares the original bundle resource ancestor and grant; no allocator, scheduler or per-unit grant is added.
Nested cancellation, caller disconnection and root settlement cancel outstanding executions through their existing
process owners and await terminal observations. On owner EOF or shutdown the broker stops accepting, cancels peer tasks
and closes their connections before awaiting the server's terminal state; drain remains bounded. Carrier recovery never
deletes a live broker's socket. The broker uses bounded framing, startup and drain budgets, and private
socket-carrier cleanup rejects changed identity or unexpected contents. The channel requires Linux Unix peer credentials
and Python 3.6-or-newer standard-library asyncio Unix transport, launched with the same isolated `-I -S` interpreter
flags as the pre-exec helper; it creates no installed daemon or global host configuration.

Nested stdout/stderr preserve the existing writable, synchronous-sink and null-sink interfaces; writable backpressure
has a bounded drain, and sink errors cancel the caller connection. With forwarding sinks, output reaches the original log. Diagnostic capture limits
do not cap the authoritative stream. If a caller disconnects after output without receiving terminal evidence, the
channel does not claim complete logging even when exact process cleanup succeeds. Scheduler evidence keeps
`physicalExecutionNested` separately from the root service's admission/termination record. Real component regressions
exercise root/child/grandchild ancestry, copied-descriptor peer refusal, cancellation, caller exit and output exceeding
1 MiB; these are not proof of interrupted-controller recovery or complete production-lane qualification.

Off/advisory and non-Linux modes do not create systemd resources. Auto may explicitly report an unavailable local
capability before creation; identity/protocol drift and failures after creation intent remain failures with retained
references and exact partial cleanup evidence. An explicitly selected filesystem delegate root is not silently replaced
with the user-manager hierarchy. Cleanup closes new admission immediately and retains unresolved boundaries until exact
absence is proven; cleanup may be retried, but update/attach cannot reopen a finalizing owner. These backend guarantees
do not establish complete interrupted-run or production-lane qualification.

The adapter uses atomic `StartTransientUnit` creation with an owner-bound Description and verifies the actual
InvocationID, cgroup identity, transient fragment and finite property drop-in roster. Grants go through
`SetUnitProperties`, followed by exact kernel read-back: direct cgroup writes alone are insufficient because systemd
can reset them when a child service starts. Fractional CPU quota transport uses exact integer arithmetic; it must
preserve the already-projected kernel quota, not add a tolerance or allocate a grant per child unit. Subsequent
observations reject changed manager connections, unit invocations, cgroup inodes, authority records or unit artifacts.
The user-manager binding uses the local bus socket, broker-authenticated peer UID/PID, bus identity, unique connection
name, and kernel boot/start identity. It does not fabricate a workload executable identity when a nondumpable user
manager denies `/proc/<pid>/exe`; actual workload identity remains owned by the existing process-execution authority.

The resource adapter can attach one stopped, identity-verified launcher to an atomically created transient scope beneath
that same slice. It persists the exact process identity and scope intent before creation, verifies the scope's ownership,
InvocationID, cgroup inode, literal artifacts, actual PID membership and unchanged parent controls, and leaves the
launcher stopped for the execution owner to release. Activation is awaited within the caller's explicit startup budget;
the adapter checks ownership and the stopped process throughout, and reads cgroup identity only once the scope is
active. Expiry rejects admission and retains the partial creation for reconciliation. The scope inherits the total grant; it does not receive another
copy of the allocation. A boundary permits only one launcher admission attempt. A failed attempt invalidates admission
and retains its reference for reconciliation. This resource API neither registers nor replaces process termination
authority: canonical callers must retain that existing authority before attaching or releasing a launcher.

Empty-only recovery requires an independently retained reference, a proven dead original controller, and an exclusive
recovery lock. A direct adapter call never steals an interrupted lock; only the independently guarded capacity path
may replace an exact lock whose recorded owner is proven dead. It never stops a populated slice, removes unknown
descendants, or releases capacity on behalf of its caller. Process termination remains with the execution owner. Normal and recovery cleanup
may collect only their exact empty launcher scope, then reobserve the unit, cgroup, transient fragment and
property-directory absence; ownership records remain for audit. A crash after scope creation but before InvocationID
persistence remains bound by the previously retained intent and atomically installed ownership description; populated
scope recovery still waits for the process owner to terminate its workload.
These adapter guarantees and component tests do not establish canonical scheduler/nested-unit acceptance for #3527.

Production container helpers translate the admitted step grant to `--cpus`, `--memory-reservation`, `--memory`, and
`--pids-limit`. Containers are labeled with run, bundle, and step identity. Existing acceptance PostgreSQL/Redis
containers are updated before restart. Bundle evidence reads Docker's effective `HostConfig` back and compares it to
the labeled step limits; unavailable Docker or a missing binding is never reported as zero or success. Rootless Docker
is supported only when its daemon accepts the same flags, otherwise the real Docker error remains visible.
Once any OCI limit is present, the entire CPU/memory/pids tuple and all three identity fields are mandatory; partial,
zero, inverted memory, or anonymous configurations fail closed instead of starting an unconstrained container.

### Scoped container reservations

`createProductionResourceEnforcer().reserveContainerResources` partitions an already admitted bundle grant; it is not
a second scheduler or an additional grant. Its closed request binds the current run, repository, namespace, exact
producer/source and positive CPU/memory-high/memory-max/PID tuple. The reservation is available only from a live
enforced owner, never advisory/off mode. Reservation IDs are single-use within that owner.

The bundle's total grant remains the scheduler accounting unit. Reserved container CPU, both memory limits and PIDs
are subtracted before applying the process cgroup controls. CPU quota is rounded down within the residual share;
memory safety headroom is partitioned once, not re-created for each participant. Container memory reservations must
themselves be page-aligned; they are never silently rounded away from the lifecycle's declared identity. A reservation or dynamic contraction
that leaves no valid process share fails before writing controls. Subsequent dynamic updates retain the same container
allocation and recompute only the process share. Launcher admission and PID are retained as a separate frozen private snapshot; mutable evidence cannot replace them. The scheduler publishes its total bundle grant only after control
read-back succeeds; the resource-owner evidence separately records process, total and container shares.

The returned capability's `assertHeld` checks exact caller identity/limits, the live systemd launcher or independently
retained managed-service binding and process membership, and all effective process controls. It does not treat OCI
labels as a resource lease. `releaseAfterCleanup`
retains the allocation while awaiting the canonical lifecycle's cleanup, and reclaims it only after that owner
confirms both container absence and credential removal. Rejected, incomplete or concurrent cleanup does not release
the grant. Enforcer cleanup reports `retained-container-reservations` while any allocation remains, even if its process
cgroup is empty. Evidence records total/process/reserved shares and each allocation alongside effective controls.

This API does not start, adopt or delete containers, establish fixture admission, or discover grants from environment
variables. Its caller must be the enclosing canonical supervisor, which owns durable recovery binding and invokes the
exact lifecycle cleanup before releasing scheduler usage. MySQL preparation, private admission and normal cleanup
are wired into the canonical local-production and applicable standalone/CI supervisors. Original-owner recovery
also consumes the exact durable MySQL allocation roster under its scheduler recovery lease before build-tree release,
reobserves container and credential absence at grant commit, and seals the cleanup proof in the existing journal.
Publication retry reobserves that original sealed proof, including its exact lifecycle state digest, before writing
checkpoint or grant views; a newly rehashed observation with the same immutable binding cannot replace it.
Any binding, lifecycle, observation or lease failure retains scheduler resources. This wiring and controlled component
tests are not live canonical execution, crash-recovery or fixture qualification. Existing
PostgreSQL/Redis and resident-runtime handoff semantics are unchanged.

## Evidence and cleanup

The #1071 canonical resource report embeds `resourceEnforcement` from the final checkpoint. Per bundle it includes:

- cgroup path and grant history;
- effective controls and consistency status;
- `cpu.stat` throttling counters;
- CPU and memory PSI;
- `memory.current`, `memory.events` including high/max/OOM/OOM-kill;
- `pids.current`, `pids.events`, and Docker effective limits.

Normal completion, failure, SIGINT, and SIGTERM terminate bundle process groups, sample final counters, and remove empty
owned cgroups. Cleanup retains a cgroup containing live processes and reports `retained-active`, so an active run is
never deleted. The next enforced run removes only empty stale run groups left by a crash; a SIGKILL cannot run cleanup
code, so this stale-empty recovery is the crash path. Existing runtime cleanup remains responsible for labeled service
containers.

Scheduler success also requires the resource owner to return `removed` or `not-applicable` at finalization. Retained,
failed or missing cleanup results mark the checkpoint failed and resource utilization partial, with a separate
`resourceCleanupFailure` alongside the original execution failure. If an exception exits the scheduler before terminal
checkpoint publication, finalizer errors remain attached to that original exception as `schedulerFinalizationFailures`.
The scheduler keeps a settled tier in active CPU/memory accounting until its asynchronous `afterTierSettled` owner
callback resolves. When the execution owner returns a physical termination report, the scheduler requires both
`terminated: true` and `postObservation: zero-members` before invoking that callback; an unverifiable or nonempty
result must not reach the capacity owner's producer-completion hook. This also applies to reports returned by an
in-process executor. An incomplete termination report or callback rejection closes new admission even with `collectFailures`, requests termination of
in-flight siblings through their existing execution owners, and drains each settlement once. The rejected tier's last
grant remains in `resource-grants.json`, final utilization samples, and
`resourceUtilization.retainedResourceGrants`; it is not expanded, recycled, or converted to a resident handoff. The
tier's separate `settlementFailure` preserves cleanup diagnostics without replacing an earlier execution failure.
Ordinary execution failures whose settlement succeeds still allow independent collect-failures work.

The existing scheduler journal also records each changed active/held grant and resident reservation, bound to run,
source and the original scheduler owner token. Kernel read-back precedes that fsynced event; the existing worker-facing
`resource-grants.json` projection and resource-service payload release follow it. Unchanged grants do not add events,
and compact checkpoint frequency is unchanged. Journal recovery applies the referenced patch payload, not the event
envelope, so a crash between compact boundaries cannot hide an admitted grant.

Both fresh and resume attempts on that same checkpoint reject retained grants, still-active grants/resident reservations,
failed resource-owner cleanup even when worker grants are zero, or an enforced run interrupted during establishment
before rebinding resource context or resetting evidence. The durable journal is authoritative for this decision;
inflating the mutable compatibility checkpoint's revision cannot replace its grant state. A missing,
malformed, linked, foreign-owned or mismatched worker projection cannot erase the durable journal; a legacy projection
with active grants remains blocking too. Scheduler completion, an empty resource-enforcer result, or a reporting-field change cannot prove
that a separate owner reclaimed its workload. Independent owner reconciliation across run incarnations and safe
release of retained grants remain required; this guard is not a recovery implementation. Canonical hard-interruption
qualification, pending-creation reconciliation and full production qualification for #3527
are still pending despite the capacity-owned CLI connection above. The focused scheduler tests
separate simulated owner refusals (including a real subprocess with an injected refusal) from real OS cleanup proof.

Production's disk-capacity journal retains an exact reference to its existing build owner before scheduler admission:
repository/run, source/namespace, controller identity, creation identity and build-directory device/inode. It does not
copy or replace the build owner's service/resource ledgers. The reference is part of the compare-owner identity;
another run, replacement directory or resealed removal cannot authorize release. A legacy journal missing this field
is unverifiable, not automatically recoverable. Unbound early preflight and projection-only reservations explicitly
record `null`, since they have not prepared a physical build owner.

The CLI invokes normal release from the build lifecycle's post-seal callback. Both that call and the outer error path
reobserve the retained owner, real resources, containment and writer identities. A still-active or unverifiable owner
keeps all admitted bytes in `recovery-required`, closes producer admission and supplies a retention error; it does not
write a terminal release receipt. A release failure remains secondary to an existing execution error. Recovery of a
dead reservation controller also consults this exact reference rather than treating an empty Unix process group as
proof that systemd units are gone. Missing, altered or replaced build records retain the reservation. This observer
does not terminate resources, delete build roots or release the separate CPU/memory ledger.

Real Linux scheduler tests check refusal while the registered service exists and release only after actual cleanup
and build sealing on success, refusal, cancellation and timeout paths; disk sizes in that fixture are explicitly
simulated. Separate capacity tests exercise an actually exited controller with an empty retained build owner. These
do not establish crash cleanup with live nested units or full production-lane acceptance. Live service descendants
are checked against the exact retained service cgroup and process identity; an identity that exits during observation
does not authorize its replacement or bypass an unverifiable live member.
The resident component fixture also covers a real listener, inventory publication, consumer handoff, exact
service settlement and capacity release. Separate live-owner and dead-controller resource fixtures cover injected
and hard-interrupted resident cleanup retries; they do not qualify a full build/scheduler recovery run.
For a systemd-bound enforced resident inventory, the scheduler also requires its producer's retained service authority:
each live process must still occupy that exact active service cgroup, not merely another unit beneath the same bundle
ancestor. The nonblocking resident-output path separately rejects a live service without a durable transfer; its
real scheduler fixture demonstrates a component handoff, not full canonical-lane acceptance.

The existing resource-enforcement component suite also exercises real Linux kernel pressure through the canonical
resource enforcer and physical-execution owner. Two independently owned services share one bundle ancestor while
the same live worker identities observe increasing and decreasing CPU and memory controls. The CPU oracle reads
the actual quota, period, eligible CPUs and kernel bandwidth slice; it requires aggregate usage within that bound
and advancing throttling counters, not a fixed throughput target. Separate memory cases distinguish `memory.high`
reclaim/throttling from `memory.max` failure with advancing `max` and `oom_kill` events. The OOM payload attempts at
most 256 MiB in aggregate across 16 children beneath a 128 MiB boundary; PID pressure uses at most 65 fork attempts
against a 64-task parent limit. PID rejection requires `EAGAIN`, the full parent count, a looser service limit and an
advancing denial counter on that exact service, rather than assuming which ancestor reports the event. Every case
requires the existing process owner to verify zero members and the resource owner to remove its exact boundary;
timeouts are failures, not proof of enforcement. These are real OS component checks with controlled source IDs and
machine-budget inputs, not full canonical scheduler/production-lane qualification or independent acceptance.

The complete rollback is `FSUSBLOG_CGROUP_ENFORCEMENT=off`; it leaves ordinary development test behavior unchanged.
