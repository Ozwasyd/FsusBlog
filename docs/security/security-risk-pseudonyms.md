# Security-risk identity pseudonyms

## Boundary

Persistent `security_risk_event` rows never contain raw client IPs, device fingerprints, or account subjects. The event sink converts each value to a lowercase HMAC-SHA-256 pseudonym before enqueueing it. Request paths and user-agent strings are no longer retained; the bounded route key, HTTP method, reason, action, detail, and trace identifier remain available for operations.

The input frame is unambiguous and domain separated:

```text
security-risk/{ip|device|account}/v1\0epoch:{positive integer}\0{normalized value}
```

IP normalization parses the address, maps IPv4-mapped IPv6 to IPv4, and writes canonical address text. Account input is normalized case-insensitively. Each row stores `pseudonym_epoch`; a row containing an identity pseudonym is rejected if its epoch is not positive.

## Key ring and production gate

Configure `Security:RiskPseudonymization` through the deployment secret provider, not a committed file:

```json
{
  "CurrentEpoch": 4,
  "CurrentKey": "<base64 for at least 32 random bytes>",
  "PreviousEpoch": 3,
  "PreviousKey": "<independent previous base64 key>",
  "PreviousAcceptUntilUtc": "2026-08-14T00:00:00.0000000Z"
}
```

Production startup fails when the current epoch/key is missing, the key is short, low-diversity, templated, or exactly reused from another configured security secret. A previous key must have a lower epoch, its own key material, an explicit UTC expiry, and a transition window no longer than 90 days.

Generate keys from a cryptographically secure source. Rotate on or before the security-risk retention boundary: deploy a new current epoch while moving the old key to `Previous*`, retain dual-read only for the documented transition, then remove the previous key after its acceptance time. Writes always use only the current epoch; PostgreSQL fallback reads query current and still-valid previous epochs without persisting raw input.

## Migration and retention

Migration `20260715-post-security-risk-pseudonym-epoch` adds the epoch column, removes retained path/user-agent values, deletes all legacy epoch-zero rows, and creates the epoch index. Those old unkeyed SHA-256 values are deliberately deleted because they cannot be securely transformed without the original identifiers.

The daily cleanup worker also deletes any epoch-zero row that appears during a mixed-version rollout. It uses bounded chunks and the active-release commit guard. After the previous-epoch read window closes, normal event expiry governs remaining keyed rows; operators must not extend the previous-key window to preserve obsolete correlations.

## Rollout, rollback, and observation

Use a rolling candidate slot. The candidate must pass production startup validation and schema migration before receiving traffic. No-restart fallback means leaving the already-active slot serving while an invalid candidate is rejected; never downgrade to plain SHA-256 or disable pseudonymization. During rollback, keep the previous epoch configured until every row written by the rolled-back release is outside the score transition window.

Check startup validation output, migration history, cleanup counts (`legacySecurityRisk`), risk-event queue metrics, and PostgreSQL fallback failures. A sudden zero score after rotation usually means the previous key/epoch pair or its UTC acceptance time does not match the prior deployment.
