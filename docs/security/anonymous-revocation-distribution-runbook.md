# Public revocation artifact runbook

## Observe

For the current root snapshot, record only public `epoch`, `version`,
`revocationRoot`, full/delta URL, HTTP status, ETag, response bytes and latency.
Never capture a browser credential, handle, witness, Cookie or Authorization.

Expected response properties:

- `200 application/octet-stream`, frame 196 or 197;
- `Cache-Control: public, max-age=31536000, immutable` and content-hash ETag;
- epoch/version/root/hash-binding all validate, and delta base is exact;
- two clean browser profiles request identical URL/method/header shape and
  receive the same response length and frame shape.

## Fail closed and rollback

On tamper, rollback, stale, excessive download/CPU, worker timeout or root
mismatch, stop issuing new anonymous comment tickets by hot-disabling the ZK
anonymous runtime gate. This needs no process restart. Keep public artifacts
read-only so operators can diagnose CDN/origin parity; do not delete immutable
objects and never re-enable the retired witness endpoint. Recovery requires a
new attested epoch/version artifact, focused validation, then hot re-enable.

Anonymous, logged-in and admin requests keep their existing authentication and
authorization behavior. Notification stream is unaffected. Binary public
artifact routes remain anonymous reads; ticket/proof paths continue to fail
closed while the gate is disabled.
