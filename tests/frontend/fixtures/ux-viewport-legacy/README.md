# UX viewport legacy parity snapshot

`runtime/` is a tracked, digest-bound copy of the pre-optimization viewport runner and its
assertion helpers. The parity tool copies this tree into an isolated workspace; it must not
copy `tests/frontend/support` from the current checkout into the legacy runner.

`historical-failure-signatures.json` is intentionally `incomplete`. The only retained failure
output contains 20 early-terminated Playwright group titles and no per-case error messages.
Those titles are preserved for auditability, but they are not promoted into synthetic
route/theme/media signatures. Release parity therefore fails closed with `status=blocked`
until an authoritative source supplies all 70 isolated failure signatures.

When such evidence is recovered, every baseline entry must identify one planned case, retain
the original normalized failure message and `sha256:` signature, use a `failed` or `timedOut`
outcome, and cite its Playwright JSON evidence provenance. A passing current UI is not enough
to waive the historical comparison.
