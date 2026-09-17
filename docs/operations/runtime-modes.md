# Runtime mode gates

FsusBlog v1.3.0 continues to use one repository, one Server project, and one application artifact. A runtime mode selects which runtime responsibilities the process starts; it does not create fixed business services, sidecars, or a second deployment package.

## Configuration

No configuration is required by default:

```json
{
  "RuntimeMode": {
    "Mode": "single"
  }
}
```

Supported `Mode` values:

- `single`: the default mode. Full business capability runs in this process with local in-process calls; it starts no cluster foundation, enables no adaptive scheduler, and subscribes to no cross-node Public AOT invalidation.
- `static-role`: the same program starts fixed background responsibilities from `StaticRoles` without automatic migration. Available roles are `web`, `content`, `security`, `audit`, and `maintenance`; at least one role is required.
- `adaptive`: the same program starts cluster foundation, Redis membership heartbeat, the distributed-invalidation gate, and the adaptive responsibility scheduler. The scheduler assigns responsibilities by capability, health, load, and stability policy, using lease/fencing to control module runtime eligibility.

Static-role example:

```json
{
  "RuntimeMode": {
    "Mode": "static-role",
    "StaticRoles": ["web", "audit"]
  }
}
```

`static-role` derives stable capabilities from roles by default. `static-role` and `adaptive` may also configure them explicitly:

```json
{
  "RuntimeMode": {
    "Mode": "adaptive"
  },
  "Runtime": {
    "Cluster": {
      "NodeId": "fsusblog-node-001",
      "Capabilities": ["web.api", "comment.api", "search.query"],
      "HeartbeatSeconds": 10,
      "SuspectAfterSeconds": 30,
      "DeadAfterSeconds": 90
    }
  }
}
```

Capabilities accept only stable catalog values; `adaptive` fails closed when a capability is undeclared. `NodeId` may be omitted to use the current host/process identity. Every process start still creates a new `instanceId` to reject late heartbeats or draining writes from the previous process.

Environment variables may use standard ASP.NET Core keys such as `RuntimeMode__Mode` and `RuntimeMode__StaticRoles__0`. An unknown mode, unknown role, or empty `static-role` set fails before `builder.Build()`, preventing startup with ambiguous responsibilities.

## Startup and health semantics

`RuntimeModeRuntimeState.Capture()` is the authority for the runtime-mode health snapshot. It includes mode, static roles, the cluster/membership/scheduler/distributed-invalidation gates, local-invocation boundary, and whether cluster foundation started. Startup logs emit the same plan; `single` explicitly records related distributed capabilities as `disabled`.

`single` removes only the cross-node invalidation subscriber and does not start membership heartbeat; local workers and local invalidation continue. `static-role` trims only background workers owned by registered roles; lifecycle, startup validation, and unknown core hosted services remain enabled, preventing silent shutdown when a new worker is not registered. `adaptive` changes neither HTTP entry points nor the artifact and introduces no node-location dependency in business code.

The multi-node membership view lives in a runtime-scoped Redis hash. Heartbeat timeouts converge as `Alive -> Suspect -> Dead`; operations explicitly control `Draining` and `Maintenance`, which the failure detector does not override. The protected `GET /api/ops/cluster/nodes` permits only an independent admin principal + `system.config` + `fixed_ip` and supports backend/diagnostic views of nodes, capabilities, low-sensitivity resource hints, and active responsibility.

The same route's `scheduler` field gives the responsibility/replica assignment graph, placement score/reason, and unassigned reason. Each round selects only Alive, network-reachable nodes whose capabilities match; cooldown, minimum runtime, hysteresis, and migration cost prevent short-lived load changes from migrating work, while a failed node is replaced immediately. High pressure performs only bounded scale-out; low pressure removes at most one replica per round.

Hot-update `Runtime:Scheduler:Enabled=false` to stop assignment and release the local responsibility lease. This does not stop Kestrel, public reads, login, admin, the notification stream, or binary endpoints. Before restoring it, confirm that every mandatory responsibility has at least one healthy capability candidate. See the full boundary in [`adaptive-responsibility-scheduler.md`](../architecture/adaptive-responsibility-scheduler.md).

## Stateful responsibility protocol

Stateful responsibilities in `static-role` and `adaptive` cannot infer an owner from membership alone; they must acquire a `responsibility + resource` lease. Another node may take over only after the lease TTL expires. Each new acquire creates a monotonically increasing fencing token, and renew/release accepts only the original `leaseId + token`. An old node therefore cannot overwrite state written by a new owner after recovering from a long pause.

Background tasks default to:

```text
scheduling: at-least-once
side effect: effectively-once by taskType + objectId + operationId
critical write: single writer + fencing token
long task: compare-version checkpoint
terminal failure: dead letter or explicit compensation-required
```

Task takeover is fixed as:

1. The new node obtains a larger fencing token after the old TTL expires.
2. It reads the task record with the same idempotency key.
3. It resumes from the last successful checkpoint version.
4. It rechecks the current lease at every checkpoint, complete, or failure transition.
5. After the maximum retries, it enters dead letter; a task with registered compensation enters `CompensationRequired` and never fabricates success.

The current cluster failure detector uses the `cluster:failure-detector` lease so nodes do not concurrently write membership transitions. Future search-index, media, moderation, notification, and scheduler workers must key by their own resource or partition; they may not share one global lock or bypass the idempotency record.

## Risk and rollback

The runtime mode is fixed before DI-container construction and cannot hot-switch in process. Configuration errors fail closed. If Redis state-control is unavailable or lease renew is lost, the worker must stop new checkpoints/critical writes; it must not degrade into in-process multi-writer behavior. A no-restart local downgrade marks the node `Draining` or `Maintenance`, removes active responsibility, and lets a healthy node take over after the lease TTL; public reads, login, admin, binary, and the notification stream continue. If static-role or adaptive foundations fail as a whole, restore `RuntimeMode:Mode` to `single` and start the next process generation; no data migration, image switch, or other service deployment is needed. Rollback must not add a fixed business sidecar, clear the fencing counter, delete the idempotency record, or route the single hot path through a cross-node protocol.
