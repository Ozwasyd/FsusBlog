# Module invocation and ownership boundary

v1.3.0 keeps one application artifact and one set of business contracts. Runtime
placement is an infrastructure concern:

```text
single       contract -> local typed operation
static-role  contract -> local operation or assigned remote node
adaptive     contract -> local operation or capability-selected remote node
background   contract -> durable queue
event        contract -> event transport
```

`ModuleContractDescriptor` is the stable boundary. A contract has a closed identifier,
major/minor version, required cluster capability, owner, and storage prefixes. Callers
depend on `IModuleInvoker` and typed `ModuleCall<TRequest,TResult>`; they do not receive a
node id, transport client, repository, `DbContext`, or mutable implementation object.
The local path passes the original typed request directly and does not serialize or
perform membership I/O in `single` mode.

## Core ownership

| Contract | Capability | Storage owner |
| --- | --- | --- |
| `comment@1.0` | `comment.api` | `comment`, `comment_*` |
| `audit@1.0` | `comment.audit` | `audit_*`, `security_audit_*` |
| `search@1.0` | `search.query` | `search_*` |
| `media@1.0` | `media.processor` | `media_*`, `upload_*` |
| `notification@1.0` | `web.api` | `msg_*`, `notification_*` |

Only the owner writes those prefixes. A different module requests a mutation through
the public contract or emits an event; it must not inject or call the owner's internal
repository, SQL client, context, mutable cache, or implementation class.

## Routing and failure semantics

Request/response routing prefers a healthy local node with the capability. Otherwise
it selects a healthy remote node, preferring its active assignment and then lower queue
and p95 latency. Queue and event calls are location-independent. A missing capability
fails closed as `module_route_unavailable`.

Remote calls carry the current W3C trace parent/state and baggage. They have bounded
concurrency, per-call timeout, idempotency-gated retry, and a per-contract circuit
breaker. A call without an idempotency key is attempted once. Queue calls require an
idempotency key. The transport must preserve that key end to end; the owner combines it
with issue #113 fencing/checkpoint state for effectively-once side effects. No
cross-module distributed transaction is introduced.

Contract compatibility is same-major, backward-minor only: a `2.3` handler accepts
`2.0` through `2.3`, not `1.x` or `2.4`. Breaking changes require a new major contract
and a grey period with both handlers. Additive fields must retain defaults during mixed
node rollout.

## Risk and no-restart fallback

Remote transport failure, timeout, breaker-open, saturation, or no healthy capability
fails the affected module call; it never silently writes through another module's
storage. Operators can drain the target node or remove its active responsibility.
After health/capability recovery, new calls route normally and the circuit closes after
its open interval; no application restart is required. Queue consumers can be paused
while durable messages remain. `single` remains the emergency next-generation
deployment mode, but changing the storage authority in a running process is forbidden.
