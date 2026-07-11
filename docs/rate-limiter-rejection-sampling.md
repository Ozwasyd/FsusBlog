# Rate limiter rejection risk sampling

`RateLimiterRejectionRiskSampler` protects the `OnRejected` path from turning a
rate-limit response into repeated database, Redis, or background risk writes.
Issue #1055 additionally requires the sampler itself to remain cheap under
hostile cardinality.

## Threat model and invariants

An unauthenticated caller can choose many raw paths, and a distributed caller
can also present many client IP subjects. Neither input is allowed to create an
unbounded process-level collection or make a later rejection enumerate every
tracked key.

The bounded sampler therefore maintains these invariants:

- the production window retains at most 4096 logical buckets;
- a bucket is `normalized client IP + normalized HTTP method + endpoint route
  pattern/display name`, never the raw request path;
- unmatched paths share one fixed route kind per normalized HTTP method;
- uncommon HTTP methods share `OTHER`, so arbitrary method tokens do not create
  another attacker-controlled dimension;
- endpoint identity longer than 192 characters is represented by a fixed-size
  SHA-256 digest;
- an existing bucket may emit at most four `RateLimited` risk signals per
  minute;
- once capacity is full, new buckets are dropped while existing buckets retain
  their four-write limit;
- the rejection hot path uses bounded dictionary probes and atomic counters. It
  never reads `ConcurrentDictionary.Count`, enumerates keys, or removes keys;
- each minute window allocates dictionary capacity from the fixed hard limit up
  front, avoiding attacker-driven resize/rehash spikes while buckets grow;
- minute rollover swaps the entire window behind one compare-exchange rotation
  gate. Contending requests spin/yield briefly and re-read the published window
  rather than queueing repeated cleanup or allocating replacement windows;

The capacity counter is reserved with compare-exchange before insertion. A
duplicate-key race releases its unused reservation, so the retained bucket count
cannot exceed the configured hard limit even under parallel rejection traffic.

## Security behavior

The ASP.NET Core limiter still returns `429 Too Many Requests` with
`Retry-After: 60`. Sampling affects only the best-effort risk-signal side
effect; it cannot permit a rejected request or bypass endpoint authorization,
PoW, MFA, Passkey, notification stream, binary framing, or crawler policy.

At capacity the sampler automatically degrades without a restart: it refuses
new logical buckets and the existing `rate_limiter_risk` dropped metric remains
the operator-visible signal. Existing buckets continue their per-minute write
budget. This trades some new-subject telemetry for bounded CPU and memory while
preserving the rate-limit decision itself.

The key is process-local and is never logged. Production route identity comes
from endpoint metadata, not attacker path text. Client IP continues to come only
from `GetClientIp()` after the configured forwarded-header trust boundary.

## Risk and rollback

- Route metadata collisions can intentionally coalesce risk-write budgets, but
  cannot weaken the actual rate limiter. Tests cover matched, unmatched, long
  metadata, and uncommon-method normalization.
- A distributed attack can fill all 4096 buckets and cause telemetry drops.
  The hard cap is deliberate; the gateway and normal ASP.NET rate-limit policy
  remain the enforcement layers.
- If production needs immediate relief without restarting, retain the automatic
  capacity-drop mode and tighten the existing edge gateway limits for the
  affected route family. Do not restore raw-path keys or per-request scans.
- A code rollback requires a normal deployment and must not reintroduce the old
  dictionary enumeration. The safe functional fallback is to skip risk writes
  for new buckets, not to make rejection processing unbounded.

## Behavior coverage

`RateLimiterRejectionRiskSamplerTests` covers high-cardinality matched and
unmatched paths, hard capacity, exact per-bucket write limits, cross-minute
whole-window rotation, duplicate-key and unique-key concurrency, long route
metadata, unknown methods, and anonymous/login/admin/notification-stream/binary
route families. Its performance-tagged concurrency case compares saturated 64
and 4096 bucket windows using identical capacity-drop operations.

No test or performance command was executed while this implementation was
written. Thresholds and intended commands are recorded separately in
`docs/rate-limiter-rejection-sampler-operations.md`; measured results must come
from a later fresh run.
