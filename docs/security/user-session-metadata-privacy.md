# User session metadata privacy

Ordinary-account `UserSession` stores only data needed for revocation, audit, coarse session display, and low-weight login-risk comparison. Client-supplied `X-Fsus-Device-Fp` is an untrusted hint, not a credential: it cannot authorize, bind an account, widen refresh-token revocation, bypass step-up, or prove that two sessions belong to one real device/user.

## Persistence boundary

Login and first Passkey enrollment read client IP, User-Agent, and an optional device signal only during the request, then immediately transform them: normalize the device signal under `account:{accountId}` and derive `device_signal_hash` / `device_signal_epoch` with the current `Security:RiskPseudonymization` HMAC epoch; reduce IPv4 to `/24` and IPv6 to `/48` and derive `network_signal_hash` / `network_signal_epoch` under the same account scope and a separate IP domain; and parse User-Agent into only `browser_family`, `os_family`, and `form_factor` (for example `Chrome / Linux / Desktop`).

Raw fingerprints, full IPs, and full User-Agents never enter `sys_user_session`, responses, logs, traces, or telemetry. Deployment configures the `Security:RiskPseudonymization` key independently; the epoch is part of the HMAC domain, so the same signal is not directly comparable across accounts, deployments, or epochs. The rotation overlap accepts only current and one time-bounded previous epoch; after it closes, old session signals lose risk-matching ability. Internal HMAC values are never returned to the browser. See the [security-risk pseudonym contract](security-risk-pseudonyms.md) for the shared key-ring and retention boundary.

## Risk and authorization boundary

Missing device signals, empty/reduced User-Agents, UA reduction, VPNs, and proxies do not block Passkey login. A supplied but changed signal may only increase risk and require step-up; it cannot allow a request alone or correlate sessions for bulk revocation. Refresh replay and session revoke use only verified session/family authority.

The no-restart degradation switch is `Security:UserSessions:MetadataRiskSignalsEnabled=false`. Once reloadable configuration applies, login-risk evaluation ignores device/network/UA signals but retains Passkey, refresh-lineage, session limits, and revocation checks. Restoring `true` resumes current/previous-epoch comparison; the switch never restores raw-value writes.

## Migration, retention, and deletion

`20260720-pre-user-session-metadata-minimization` adds coarse/HMAC fields, converts old User-Agents to low-cardinality labels, and clears legacy `devicefingerprint`, `lastip`, and `useragent` values in the same transaction. Old columns remain only as rollback-compatible shells; application entities and write paths no longer map them.

The retention worker daily removes revoked sessions and device/network HMACs and epochs older than `Security:UserSessions:MetadataRetentionDays`; the range is 1–90 days and the default is 30. Coarse labels may remain until the session row is removed under the existing account/session lifecycle. Account deletion still removes all `UserSession` rows; backups and audit follow their own finite retention and cryptographic-erasure policies.

To accelerate privacy degradation, set retention to one day through reloadable configuration and trigger the existing leader-cleanup cycle. Never remap old raw columns as a runtime fallback.
