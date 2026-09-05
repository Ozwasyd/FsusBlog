# Support

FsusBlog is in public preview. Support is limited to development, evaluation, code review, and personal self-hosting experiments. There is no production SLA, paid support channel, or guaranteed response time.

## Where To Ask

- Setup, usage, and deployment routing: read this file first, then use the matching issue form when the report is actionable. Use the Bug report form for reproducible bugs, Documentation report form for documentation problems, Deployment / self-hosting report form for deployment or self-hosting problems, Feature request form for feature requests, Performance report form for performance evidence, Accessibility / UI report form for accessibility or UI defects, and Governance / process report form for governance, release-evidence, test-gate, or contribution-workflow drift.
- Security vulnerabilities: do not open a public issue. Follow [SECURITY.md](SECURITY.md) and GitHub private vulnerability reporting.

## Self-Hosting Evidence

For local, Docker Compose, Kestrel-only, reverse proxy, CDN, or production-like setup problems, include the FsusBlog canonical ReleaseId or full commit SHA; deployment mode and whether a reverse proxy, CDN, VPN, WAF, or managed database is involved; OS, CPU architecture, .NET, Node/npm, Docker, PostgreSQL, and Redis versions; sanitized environment variable names and non-secret values; the smallest sanitized log excerpt or command output showing the problem; whether it reproduces with fresh demo seed data; and whether it also reproduces on a Kestrel-only baseline when a proxy or CDN is involved.

## Do Not Post Publicly

Never include these in public issues, pull requests, comments, screenshots, videos, or logs: tokens, API keys, passwords, session IDs, cookies, or recovery codes; production domains, private hostnames, real IP addresses, or infrastructure identifiers; real email addresses, user identifiers, private messages, or personal data; production logs, database exports, Redis dumps, backups, or uploaded private files; or exploit details, proof-of-concept vulnerability steps, or private security findings.

If a report might include a vulnerability or private deployment detail, stop and use [SECURITY.md](SECURITY.md) instead of a public issue.

## Response Expectations

Maintainers triage public reports when time allows. A complete report with sanitized evidence is more likely to be actionable. Incomplete reports may be marked as needing more information, but issues are not auto-closed solely because of age.

## Useful Links

- [README.md](../README.md)
- [development.md](development.md)
- [troubleshooting.md](troubleshooting.md)
- [production.md](production.md)
- [open-source-readiness.md](open-source-readiness.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
