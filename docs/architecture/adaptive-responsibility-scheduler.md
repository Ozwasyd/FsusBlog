# Adaptive responsibility scheduler

FsusBlog keeps one homogeneous application artifact. The adaptive scheduler changes which node may express a runtime responsibility; it does not split modules into fixed services, start a second application binary, or make domain code depend on node addresses. The [monolithic distributed boundary](monolithic-distributed-boundary.md) is the canonical deployment contract.

## Responsibility model

`Infrastructure/Distributed/Scheduling` owns the stable model:

- `ResponsibilityDescriptor` binds an ID, required capability, kind, replica bounds,
  resource profile, and scheduling policy.
- `ResponsibilityAssignment` binds one replica to one node and records the placement
  score, assignment time, reason, and runtime fencing token when active locally.
- `IResponsibilityRuntime` activates, deactivates, and lists local assignments.
- `ResponsibilityAssignmentSnapshot` is the immutable diagnostic graph.

The v1.3 catalog contains:

```text
web.api.listener
comment.audit.consumer
antispam.inference.worker
search.indexer.worker
media.processor.worker
scheduler.background.worker
sse.fanout.worker
```

IDs are scheduling identities, not source-file or hosted-service names. Each descriptor
uses a capability from the closed membership catalog.

## Modes

- `single`: the planner assigns the complete catalog to the current process without a
  membership lookup. Module invocation remains the typed local fast path and does not
  acquire a distributed lease.
- `static-role`: every healthy node keeps the responsibilities implied by its declared
  capabilities. Load does not move a responsibility; the scheduler supplies health and
  assignment observability.
- `adaptive`: only `Alive`, network-reachable nodes with the required capability are
  candidates. The planner scores CPU, memory/managed-GC-heap pressure, IO, queue length,
  P99 latency, error rate, active leases, and warm active capability locality.

Adaptive replica count stays within `MinReplicas..MaxReplicas`. High pressure adds a
bounded replica; sustained low pressure removes at most one per reconcile after the
cooldown. A healthy current owner is retained during minimum run time and cooldown, and
afterward moves only when score improvement exceeds both hysteresis and estimated
migration cost. `Suspect`, `Dead`, `Draining`, `Maintenance`, unreachable, or
capability-mismatched nodes are ineligible; their assignment is replaced immediately
without waiting for cooldown.

## State and module boundaries

Every local multi-node activation acquires
`responsibility:<responsibility-id>.<replica>` through `ILeaseManager`. Renewal keeps
the same lease identity and fencing token; loss removes local activation and fails
closed. A replacement can activate only after the prior lease expires or is released,
and receives a larger fencing token.

Activation feeds the existing [module invocation router](module-invocation-boundary.md). In adaptive mode, an explicit local activation view must confirm the required capability before the router uses the local path; remote targets must advertise the active capability in membership. The scheduler never invokes repositories, DB contexts, controllers, or mutable domain objects. `single` continues to bypass membership and serialization.

The homogeneous Kestrel host remains available on every running node. A
`web.api.listener` assignment represents module placement eligibility and operational
responsibility; it does not pretend that the process can hot-unbind Kestrel. Existing
legacy hosted workers require explicit module-runtime adapters before they can be
dynamically lifecycle-controlled; the scheduler does not infer lifecycle ownership from
class names.

## Observability and rollback

The independent-admin `GET /api/ops/cluster/nodes` response includes a `scheduler`
snapshot with generation, mode, enabled state, assignments, scores/reasons, and
unassigned causes. It is diagnostic JSON, fixed-IP limited, and `no-store`; no public,
Cookie-account, notification, or binary route receives cluster placement metadata.

`Runtime:Scheduler:Enabled=false` is read on every reconcile. It publishes an empty,
disabled snapshot and deactivates local leased responsibilities without restarting the
request-serving host. Anonymous reads, login, admin authentication, notification stream,
binary endpoints, security headers, PoW, and `X-Fsus-*` contracts remain active. Re-enable
only after membership health and capability coverage recover. Changing
`RuntimeMode:Mode` still applies to the next process generation; never switch a running
multi-node authority to in-memory `single`.
