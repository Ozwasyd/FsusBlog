# Contributing

FsusBlog is currently a public-preview project. Contributions should keep changes focused, include evidence, and avoid promising stable compatibility for internal APIs that are not explicitly documented as stable.

## Before Opening An Issue

- Use the bug, feature, or performance issue templates in `.github/ISSUE_TEMPLATE/`.
- Do not file security vulnerabilities as public GitHub issues. Follow [SECURITY.md](SECURITY.md).
- Include a commit SHA or version, deployment mode, and sanitized evidence.
- For performance reports, state whether the measurement is the Kestrel-only baseline or includes a reverse proxy, CDN, or other deployment layer.

## Development Setup

Start with [docs/development.md](docs/development.md) and the local development section in [README.md](README.md#本地开发).

Common prerequisites:

- .NET SDK 10+
- Node.js 20+ and npm 10+
- Docker and Docker Compose for PostgreSQL and Redis
- `GITHUB_PACKAGES_TOKEN` when installing the private FsusUI package

## Test Commands

Use the smallest command that proves the change, then broaden when the risk crosses module boundaries.

```bash
./tools/test.sh fast
dotnet test tests/backend/FsusBlog.Server.Tests.csproj --filter "Category!=Integration" -v minimal
cd src/frontend && npm run test:fast
```

For release-sensitive, security, visual, load, or AEDS changes, follow [docs/testing.md](docs/testing.md) and [tests/backend/TESTING.md](tests/backend/TESTING.md).

## Coding Conventions

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

Use [.github/PULL_REQUEST_TEMPLATE.md](.github/PULL_REQUEST_TEMPLATE.md). Every PR should include:

- a linked issue
- a short scope summary
- tests run
- screenshots for UI changes
- AEDS/API/database/security impact notes when relevant
- documentation updates or a reason docs are not needed

Keep PRs reviewable. Split unrelated API, UI, database, and security changes unless one issue explicitly requires them together.

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
