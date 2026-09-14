# PublicHotRead hit-rate accounting

L0 PublicHotRead and L1 UnifiedCache share one capacity hit-rate formula so
sampled counters cannot silently inflate or deflate cache effectiveness.

## Formula

```text
capacityHitRate = calibratedHits / (calibratedHits + exactMisses)
```

`formulaId` is always `calibrated-hits / (calibrated-hits + exact-misses)`.

| Surface | Hit accounting | Miss / error accounting | `calibratedHits` |
| --- | --- | --- | --- |
| L1 `hit` / `hit_negative` | full-fidelity striped counts (#1850) | full-fidelity miss, reject, decode, Redis error | the striped count (scale 1) |
| L0 `Striped` | full-fidelity striped counts | full-fidelity miss, reject, sanity fallback | the striped count (scale 1) |
| L0 `Sampled` | weighted samples | full-fidelity miss, reject, sanity fallback | `observedHitSamples * PublicHotRead:CounterSampleRate` |
| L0 `Off` | unavailable | not a hit-rate input | withheld |

Miss, reject, decode, Redis error, and sanity-fallback paths stay full-fidelity.
`fsus.hotread.fresh.hit` and `fsus.hotread.last_good.hit` are also full-fidelity
path labels (current snapshot vs retained last-good). They are not a second
capacity hit-rate and must not be mixed with unweighted L0 kind samples.
Sampling may reduce L0 hit-counter cost or, under #1850, L1 duration histograms.
It must not change the denominator of the capacity formula and must not treat
raw hit samples as if they were complete request counts.

## How to read the counters

- `fsus.hotread.{article,list,html}.hit` and admin `publicHotReadCounters`
  article/list/html hit fields are **calibrated** capacity counts, not raw
  samples. Use them as the numerator.
- Matching `.miss` fields, `rejected`, and `sanityFallback` are **exact**. Use
  them as the denominator with the calibrated hits. Do not scale misses.
- `publicHotReadCounters.hitRate` is the only supported combined rate. It
  repeats `formulaId`, `hitAccounting`, `missAccounting`, `observedHitSamples`,
  `calibratedHits`, `exactMisses`, and `capacityHitRate`.
- When `CounterMode=Off`, `capacityHitRate` is withheld
  (`withheldReason=counter-mode-off`). Zero hits plus recorded misses is not a
  0% hit rate.
- When there is no traffic, `capacityHitRate` is withheld
  (`withheldReason=no-observations`).
- Do **not** compute `observedHitSamples / (observedHitSamples + exactMisses)`.
  That mixes a 1/N numerator with a full-fidelity denominator and understates
  hit rate.
- Do **not** compute full-fidelity hits over sampled misses. That mix is not
  produced: L0 and L1 never sample the miss/error path used for capacity.
- L1 `fsus.cache.operation.count` hit/hit_negative totals are already
  full-fidelity. Apply the same formula with scale 1. Do not keep a second
  PublicHotRead-only rate that uses unweighted samples.

`Sampled` L0 hits use a per-family attempt ticket and record every Nth hit
(`N = CounterSampleRate`). Weighted hits therefore never exceed true hits
inside a window: remainder attempts below N stay uncounted. Short windows can
slightly understate hit rate; they cannot silently inflate it. Capacity
decisions should use windows long enough that remainder `N-1` is negligible.

The residency profiler hit rate is a synthetic request-level measurement, not
this sampled counter formula. See
[PublicHotRead residency](../performance-public-hot-read-residency.md).

Production overlay uses `PublicHotRead:CounterMode=Sampled` and
`CounterSampleRate=64`. Changing the mode does not change the formula; it only
changes whether hits are full-fidelity or weighted samples.
