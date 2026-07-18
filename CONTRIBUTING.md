# Contributing

FsusBlog is currently a public-preview project. Contributions should keep changes focused, include evidence, and avoid promising stable compatibility for internal APIs that are not explicitly documented as stable.

## Before Opening An Issue

- Use the dedicated issue templates in `.github/ISSUE_TEMPLATE/`:
    - bug reports for reproducible code defects
    - feature requests for focused product or engineering changes
    - performance reports for measured latency, throughput, resource, or browser regressions
    - documentation reports for stale, missing, confusing, or incorrect docs
    - deployment/self-hosting reports for local, Docker, Kestrel, reverse proxy, CDN, or production-like setup problems
    - accessibility/UI reports for keyboard, screen reader, reduced-motion, dark-mode, mobile, or responsive defects
    - governance/process reports for public-preview policy, test gate, release evidence, contribution workflow, and issue/PR routing drift
- Do not file security vulnerabilities as public GitHub issues. Follow [SECURITY.md](SECURITY.md).
- For setup, usage, deployment, or self-hosting routing, start with [SUPPORT.md](SUPPORT.md) and then use the matching issue form only when the report is actionable.
- Never put security vulnerability details or private deployment data in public support threads, issue comments, or PRs.
- Include a commit SHA or version, deployment mode, and sanitized evidence.
- For performance reports, state whether the measurement is the Kestrel-only baseline or includes a reverse proxy, CDN, or other deployment layer.
- New issues and pull requests use the namespaced label taxonomy in [docs/repository-labels.md](docs/repository-labels.md).

## Development Setup

Start with [docs/development.md](docs/development.md), the [cross-language coding conventions](docs/development/coding-conventions.md), and the local development section in [README.md](README.md#本地开发).

Common prerequisites:

- .NET SDK 10+
- Node.js 20+ and npm 10+
- Docker and Docker Compose for PostgreSQL and Redis
- `GITHUB_PACKAGES_TOKEN` when installing the private FsusUI package

By participating in this project, follow [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). Repository code is licensed under [Apache-2.0](LICENSE); do not contribute code or assets that cannot be redistributed under compatible terms.

## Test Commands

Use the smallest command that proves the change, then broaden when the risk crosses module boundaries.

```bash
./tools/test.sh fast
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter "Category!=Integration" -v minimal
npm --prefix src/frontend run test:fast
```

For release-sensitive, security, visual, load, or AEDS changes, follow [docs/testing.md](docs/testing.md) and [tests/backend/TESTING.md](tests/backend/TESTING.md).

## Coding Conventions

- Follow the canonical [cross-language coding conventions](docs/development/coding-conventions.md), derived from the Microsoft .NET C# conventions.
- Preserve external wire, ABI, database, and third-party names at their boundary, then adapt them to the repository naming rules internally.
- Language syntax takes precedence over the cross-language mapping. Formatter/linter defaults and personal IDE settings do not override repository rules.
- Run `node tools/docs/check-authoritative-development-docs.mjs` when changing authoritative development docs, repository paths, style ownership, or command examples.
- Follow [code intent governance](docs/development/code-intent-governance.md) for ownership/security markers, public contract documentation, TODO lifecycle, and performance claims; run `node tools/governance/check-code-intent.mjs` after changing those surfaces.
- Follow the [change contract](docs/development/change-contract.md) for commit/squash titles, format and naming migration commits, PR classification, performance/generated evidence, release-note labels, and rollback metadata.
- Label performance statements as structural (`S`), local measured (`M`), route measured (`R`), or capacity measured (`C`). A stale SHA, missing artifact or machine identity, or incomplete statistics must remain blocked instead of being reported as measured.
- Keep changes scoped to the issue being closed.
- Prefer existing patterns and local helpers over new abstractions.
- Update API docs when changing request/response contracts, AEDS frame semantics, routes, or binary/JSON behavior.
- Update security docs when changing authentication, authorization, PoW, MFA, Passkey, moderation, crawler defense, or privacy behavior.
- For frontend UI, preserve responsive layout, keyboard access, dark mode, and `prefers-reduced-motion` behavior.

Useful references:

- [docs/architecture.md](docs/architecture.md)
- [docs/api/design.md](docs/api/design.md)
- [docs/api/contracts.md](docs/api/contracts.md)
- [docs/security.md](docs/security.md)
- [docs/frontend/motion-guidelines.md](docs/frontend/motion-guidelines.md)

## Pull Request Workflow

Use [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md) together with the executable [change contract](docs/development/change-contract.md). Every PR should include:

- a linked issue
- a short scope summary
- tests run
- screenshots for UI changes
- AEDS/API/database/security impact notes when relevant
- documentation updates or a reason docs are not needed

Keep PRs reviewable. Split unrelated API, UI, database, and security changes unless one issue explicitly requires them together.

`.github/CODEOWNERS` routes review responsibility for touched paths, but it does not replace the PR checklist, linked issue, tests, screenshots, or risk notes.

Default-branch merge expectations, required status checks, CodeQL/Scorecard posture checks, and GitHub Actions permission rules are documented in [docs/repository-governance.md](docs/repository-governance.md).

## Public-Preview Stability Policy

During the v1.1.x public-preview phase:

- internal AEDS frames are experimental unless explicitly documented as stable
- undocumented internal APIs may change
- database schema and admin routes may change
- deployment configuration may change
- third-party client compatibility is not guaranteed

Standard external protocols such as RSS, Atom, Sitemap, `robots.txt`, and health probes should remain documented separately from internal AEDS APIs.

## Security Reports

Never include exploit details, tokens, private domains, real emails, real IP addresses, or logs with personal data in public issues or PRs. Use [SECURITY.md](SECURITY.md) for vulnerability reporting.
