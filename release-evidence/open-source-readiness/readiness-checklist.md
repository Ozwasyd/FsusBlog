# v1.1.0 Open Source Readiness Checklist

Status: green
Generated for issue: #121
Release target: v1.1.0-public-preview

## Required Files

| Gate | Status | Evidence |
|------|--------|----------|
| Repository license | OK | `LICENSE` uses Apache-2.0 |
| Security policy | OK | `SECURITY.md` |
| Contribution guide | OK | `CONTRIBUTING.md` |
| Code of conduct | OK | `CODE_OF_CONDUCT.md` |
| Safe local environment example | OK | `.env.example` |
| Safe app settings examples | OK | `appsettings.example.json`, `appsettings.Production.example.json`, `src/backend/appsettings.example.json`, `src/backend/appsettings.Production.example.json` |
| Public preview README | OK | `README.md` links status, setup, tests, deploy docs, roadmap, known limits, license, security, conduct, and readiness evidence |
| Public preview release notes | OK | `docs/releases/v1.1.0-public-preview.md` |
| Known limitations | OK | `docs/known-limitations.md` |
| Roadmap with v1.2.0 / v1.3.0 direction | OK | `ROADMAP.md` |
| Issue templates | OK | `.github/ISSUE_TEMPLATE/` |
| Pull request template | OK | `.github/PULL_REQUEST_TEMPLATE.md` |
| Repository governance | OK | `docs/repository-governance.md` documents branch protection, required checks, merge policy, and workflow permissions |
| Architecture overview | OK | `docs/architecture/overview.md` |
| Development setup | OK | `docs/development.md`, `docs/development/demo-data.md` |
| Troubleshooting | OK | `docs/troubleshooting.md` |

## Audit Evidence

| Gate | Status | Evidence |
|------|--------|----------|
| Secret/history/issue scan | OK | `release-evidence/open-source-readiness/secret-scan.md` |
| Dependency license audit | OK | `release-evidence/open-source-readiness/dependency-license-audit.md` |
| Supply-chain vulnerability audit | OK | `release-evidence/open-source-readiness/supply-chain-audit.md`, `release-evidence/open-source-readiness/supply-chain/summary.json` |
| GitHub dependency review policy | OK | `.github/workflows/dependency-review.yml` denies AGPL/GPL/LGPL/SSPL families |
| CodeQL code scanning | OK | `.github/workflows/codeql.yml` scans C# and JavaScript/TypeScript on PRs, default-branch pushes, weekly schedule, and manual dispatch |
| OpenSSF Scorecard posture scan | OK | `.github/workflows/scorecard.yml` runs on default-branch governance changes, weekly schedule, and manual dispatch, then uploads SARIF |
| Branch protection expectations | OK | `docs/repository-governance.md` lists required status checks, stale review refresh, force-push restriction, and merge strategy policy |
| Workflow permissions policy | OK | `docs/repository-governance.md` documents default `contents: read`, justified write/read exceptions, and untrusted PR secret rules |
| Privacy, identity, and brand scrub | OK | `docs/open-source-readiness.md`, `docs/assets/screenshots/README.md`, sanitized screenshots, fictional demo data |
| Uploaded database export ignored | OK | `.gitignore` covers `/.tmp/`, `*.sql.gz`, and `/.tmp/db_blog_*.sql.gz` |

## Commands

```bash
node tools/security/open-source-secret-scan.mjs
node tools/security/open-source-license-audit.mjs
FSUSBLOG_SUPPLY_CHAIN_AUDIT_DIR=release-evidence/open-source-readiness/supply-chain tools/security/check-supply-chain-audit.sh
node tools/docs/check-community-workflow.mjs
```

The secret scan generated `Status: ok` with 0 findings. The dependency license audit generated `Status: ok` with 712 packages audited, 11 packages with unavailable license metadata, and 0 denied licenses. The supply-chain audit generated `status: ok` with 0 NuGet high/critical blockers and 0 npm high/critical vulnerabilities.
