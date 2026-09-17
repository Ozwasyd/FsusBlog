# Security Policy

Do not report security vulnerabilities as public GitHub issues. Use GitHub private vulnerability reporting for this repository:

```text
https://github.com/Ozwasyd/FsusBlog/security/advisories/new
```

If private reporting is unavailable, contact the repository owner through a private channel first; do not publish exploit details until a maintainer confirms a disclosure path.

## Supported Scope

Security reports may cover:

- authentication, authorization, session, MFA, or Passkey bypass
- PoW, rate-limit, crawler-defense, or moderation bypass with security impact
- AEDS binary frame parsing, Wasm decoder, or notification stream vulnerabilities
- admin-only data exposure or privilege escalation
- injection, XSS, CSRF, SSRF, path traversal, or unsafe file handling
- dependency vulnerabilities with a reachable exploit path
- leakage of secrets, tokens, private data, audit logs, or production configuration

Do not use the security channel for general bugs, feature requests, spam reports, or performance issues without a security impact.

## What To Include

Please include the affected version or commit SHA, endpoint/page/workflow/package, impact summary, minimal reproduction steps or proof of concept, sanitized logs or screenshots if useful, whether the issue reproduces on fresh demo data, and any known mitigations.

Remove tokens, cookies, private domains, real emails, real IP addresses, production logs, and personal data before submitting evidence.

## Handling Expectations

FsusBlog is in public preview and does not provide a production SLA. The maintainer will triage private vulnerability reports on a best-effort basis, prioritize confirmed issues by impact and exploitability, and coordinate disclosure timing through the private report thread.

## Public Issues

Public issue templates intentionally route security reports away from normal issues. If a public issue accidentally contains vulnerability details, expect it to be minimized or moved to a private channel before technical discussion continues.
