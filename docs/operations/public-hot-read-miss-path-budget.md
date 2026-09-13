# PublicHotRead miss-path wait budget

End-to-end cache miss wait is bounded. Followers that still have qualified
last-good must not sit on the local singleflight semaphore for a full rebuild.

## Budget

```text
totalMissPathBudget = singleflightMaxAcquireWait + leaseWaitTimeout + rebuildTimeout
```

| Segment | Default | Applies to |
| --- | --- | --- |
| Local singleflight acquire | `750ms` max wait, `64` waiters per key | Every waiter of `CacheSingleFlightCoordinator.AcquireAsync` |
| Lease wait (`WaitTimeout`) | `750ms`–`5s` (`leaseTtl / 4`, clamped) | After acquire, when this process does not own the rebuild lease |
| Rebuild (`RebuildTimeout`) | `4 × leaseTtl` (`20s`–`120s`) | Leader only |

`CacheMissPathBudget.ComputeTotal` is the documented sum. A waiter without
last-good never waits longer than the singleflight acquire cap, then fails
closed. The leader's rebuild budget is separate and already owned by
`CacheMissCoordinator`.

## Fail-closed outcomes

- Qualified last-good (consume `PublicHotReadStore.TryGetQualifiedLastGood` /
  `TryGetRequestSnapshot` reason `last-good` from #3391): serve stale `200`
  immediately. Do not wait for the in-flight rebuild.
- No last-good, waiter cap or acquire timeout: `CacheCoordinationException`
  (`singleflight-waiter-cap` / `singleflight-timeout`) maps to `503` +
  `Retry-After: 1`.
- No last-good, lease refill timeout: existing `refill-timeout` also maps to
  `503` + `Retry-After`.

Single-rebuild-per-key (#1838) is unchanged: one leader holds the keyed
semaphore and runs rebuild. Followers either serve last-good or wait inside the
cap.

## Metrics

| Meter | Meaning |
| --- | --- |
| `fsus.cache.singleflight.wait` | Acquire wait time (ms) |
| `fsus.cache.singleflight.waiters` | Waiters observed on the key |
| `fsus.cache.singleflight.reject_by_cap` | Rejected by waiter cap or acquire timeout (`fsus.result` = `waiter-cap` / `timeout`) |
| `fsus.hotread.last_good.while_rebuild` | L0 served last-good while a coalesced refresh was already pending |
| `fsus.cache.coordination.last_good_while_rebuild` | Miss coordinator served last-good while the key was held |

Owned-frame mutation acquires do not use this wait budget; they keep caller-CT
wait so a mutation gate cannot time out independently of the owner.
