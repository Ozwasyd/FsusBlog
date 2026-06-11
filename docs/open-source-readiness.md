# Open Source Readiness

FsusBlog v1.1.0 is a public-preview release for development, evaluation, code review, and personal self-hosting experiments. It is not a stable production release and does not provide a production SLA.

## Required Policies

| Area | File |
|------|------|
| Repository license | [LICENSE](../LICENSE) |
| Security reporting | [SECURITY.md](../SECURITY.md) |
| Contribution workflow | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
| Known limitations | [docs/known-limitations.md](known-limitations.md) |
| Release notes | [docs/releases/v1.1.0-public-preview.md](releases/v1.1.0-public-preview.md) |

## Safe Configuration Examples

The root `.env.example`, `appsettings.example.json`, and `appsettings.Production.example.json` files use placeholders only. The backend keeps matching copies in `src/backend/` for local ASP.NET Core workflows. Replace every `replace-*`, `example.com`, and local demo value before any shared or production deployment.

Do not commit copied `.env`, production `appsettings*.json`, database exports, Redis dumps, log bundles, or generated local credentials.

## Secret And Privacy Scrub

The public-preview gate records evidence under `release-evidence/open-source-readiness/`:

| Evidence | Command |
|----------|---------|
| Secret/history/issue scan | `node tools/security/open-source-secret-scan.mjs` |
| Dependency license audit | `node tools/security/open-source-license-audit.mjs` |
| Supply-chain vulnerability audit | `FSUSBLOG_SUPPLY_CHAIN_AUDIT_DIR=release-evidence/open-source-readiness/supply-chain tools/security/check-supply-chain-audit.sh` |
| Final checklist | `release-evidence/open-source-readiness/readiness-checklist.md` |

The secret scan covers the tracked tree, git history, public GitHub issue text, issue comments, and a documentation image inventory. It blocks unapproved private keys, tokens, production-looking credentials, public IPs, and personal email patterns.

The supply-chain audit verifies npm and NuGet lock files, runs `dotnet list package --vulnerable --include-transitive`, runs `npm audit --omit=dev --audit-level=high`, and blocks high or critical vulnerabilities.

## Brand And Demo Content

The repository does not include separate trademark artwork, production logo assets, real production content, real public registration numbers, private domains, private IP addresses, or personal account data. Public-preview screenshots and demo seed data are fictional examples for documentation and local testing.

The visible `FsusBlog` wordmark in screenshots is rendered as plain text for documentation context. Future brand or trademark rules can be added without changing the Apache-2.0 license for repository code.
