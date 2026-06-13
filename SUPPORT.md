# Support

FsusBlog is in public preview. Support is limited to development, evaluation, code review, and personal self-hosting experiments. There is no production SLA, paid support channel, or guaranteed response time.

## Where To Ask

- Setup, usage, and deployment routing: read this file first, then use the matching issue form if the report is actionable.
- Reproducible bugs: use the Bug report issue form.
- Documentation problems: use the Documentation report issue form.
- Deployment or self-hosting problems: use the Deployment / self-hosting report issue form.
- Feature requests: use the Feature request issue form.
- Performance evidence: use the Performance report issue form.
- Accessibility or UI defects: use the Accessibility / UI report issue form.
- Governance, release evidence, test gate, or contribution workflow drift: use the Governance / process report issue form.
- Security vulnerabilities: do not open a public issue. Follow [SECURITY.md](SECURITY.md) and GitHub private vulnerability reporting.

## Self-Hosting Evidence

For local, Docker Compose, Kestrel-only, reverse proxy, CDN, or production-like setup problems, include:

- FsusBlog version, branch, or commit SHA.
- Deployment mode and whether a reverse proxy, CDN, VPN, WAF, or managed database is involved.
- OS, CPU architecture, .NET, Node/npm, Docker, PostgreSQL, and Redis versions.
- Sanitized environment variable names and non-secret values.
- The smallest sanitized log excerpt or command output that shows the problem.
- Whether the issue reproduces with fresh demo seed data.
- Whether the same problem reproduces on a Kestrel-only baseline when a proxy or CDN is involved.

## Do Not Post Publicly

Never include these in public issues, pull requests, comments, screenshots, videos, or logs:

- tokens, API keys, passwords, session IDs, cookies, or recovery codes
- production domains, private hostnames, real IP addresses, or infrastructure identifiers
- real email addresses, user identifiers, private messages, or personal data
- production logs, database exports, Redis dumps, backups, or uploaded private files
- exploit details, proof-of-concept vulnerability steps, or private security findings

If a report might include a vulnerability or private deployment detail, stop and use [SECURITY.md](SECURITY.md) instead of a public issue.

## Response Expectations

Maintainers triage public reports when time allows. A complete report with sanitized evidence is more likely to be actionable. Incomplete reports may be marked as needing more information, but issues are not auto-closed solely because of age.

## Useful Links

- [README.md](README.md)
- [docs/development.md](docs/development.md)
- [docs/troubleshooting.md](docs/troubleshooting.md)
- [docs/production.md](docs/production.md)
- [docs/open-source-readiness.md](docs/open-source-readiness.md)
- [CONTRIBUTING.md](CONTRIBUTING.md)
- [SECURITY.md](SECURITY.md)
