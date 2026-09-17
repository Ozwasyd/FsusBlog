# Anonymous credential blind issuance threat model

Scope: RFC 9474 issuance for issue #1136; this model does not authorize the
not-yet-built v5 presentation circuit. The protocol decision is the
[anonymous-credential blind-issuance ADR](../architecture/decisions/ADR-Anonymous-Credential-Blind-Issuance.md).

## Assets and trust boundaries

| Asset | Boundary | Required property |
| --- | --- | --- |
| RSA issuer private key | local server secret file and in-process signer | never enters web assets, logs, responses or hosted services |
| Credential secret/opening/final signature | browser credential vault | never sent to issuer, ticket API or telemetry |
| Authenticated account eligibility | normal account/session plane | used only before blind signing; not copied into credential material |
| Epoch quota subject | issuance quota table | epoch-scoped HMAC only, hour timestamp, 90-day retention |
| Nullifier and presentation witness | v5 prover/ticket plane | no issuance trace or quota subject input |

## Attacker goals and controls

| Goal | Control | Residual risk |
| --- | --- | --- |
| Link a final credential to an issuance request | RFC 9474 randomized prepare/blind/finalize; issuer sees only blinded representative; 2x2 unlinkability test | compromised browser can disclose its opening; issuer still observes account access and time bucket |
| Substitute or rotate issuer key | metadata/root key-hash binding; browser SPKI SHA-256, exact 3072-bit modulus and e=65537 checks before request and finalize | operator controlling root and signer together can rotate service identity, but cannot recover prior browser secrets |
| Return faulty or malicious RSA result | server public-operation fault check plus browser RSA-PSS verification | denial of service remains possible |
| Correlate through logs | blind resolver avoids high-value audit; quota row excludes account id, trace, path, identity kind and request material; migration purges old trace | database operator with pepper and account table can recompute current epoch quota subjects; no final credential value is available to match |
| Infer eligibility or quota by response | generic error and latency quantization; fixed-IP rate limit | upstream auth middleware, network jitter and sustained host load can still provide statistical signals |
| Re-enable linkable issuance | only the RFC 9474 route is registered; contract checks reject any compatibility handler | a future code change can regress unless governance tests remain required |
| Use non-current proof artifacts with the v5 credential | exact circuit/layout binding and strict decoder/config checks; production disabled | availability remains blocked until a real v5 ceremony/prover/verifier exists |
| Exfiltrate issuer key | DER-only local file, path denylist, 0600 permission, zeroized managed buffers, bounded signer concurrency | BouncyCastle big integers and runtime process memory are not guaranteed to be physically zeroizable; host compromise remains out of scope |

## Release negatives

- zero/short blinded representative rejects;
- wrong SPKI hash, modulus, exponent or key id rejects;
- malformed opening and tampered blind signature reject;
- non-current layout rejects and no compatibility issuance route exists;
- reload disable rejects metadata and signing without signer reconstruction;
- anonymous, ordinary-login, and admin principals cannot use the blind-issue
  route; only `anonymous_account` may proceed to eligibility;
- notification stream and unrelated binary endpoints keep their existing
  authentication and frame behavior.

## Rollback

Set `AnonymousCredentialIssuer:BlindRsa:Enabled=false` in the reloadable
configuration source. Metadata immediately becomes unavailable and requests
are rejected before private-key use. Do not restore the legacy route. Root and
credential data are left intact; no database rollback or process restart is
required for the emergency stop.
