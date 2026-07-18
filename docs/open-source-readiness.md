# Open Source Readiness

FsusBlog v1.1.0 is a public-preview release for development, evaluation, code review, and personal self-hosting experiments. It is not a stable production release and does not provide a production SLA.

## Required Policies

| Area | File |
|------|------|
| Repository license | [LICENSE](../LICENSE) |
| Security reporting | [SECURITY.md](../SECURITY.md) |
| Support routing | [SUPPORT.md](../SUPPORT.md) |
| Contribution workflow | [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Issue form taxonomy | [.github/ISSUE_TEMPLATE/](../.github/ISSUE_TEMPLATE/) |
| Label taxonomy | [docs/repository-labels.md](repository-labels.md) |
| Repository governance | [docs/repository-governance.md](repository-governance.md) |
| Code of conduct | [CODE_OF_CONDUCT.md](../CODE_OF_CONDUCT.md) |
| Known limitations | [docs/known-limitations.md](known-limitations.md) |
| Release notes | [docs/releases/v1.1.0-public-preview.md](releases/v1.1.0-public-preview.md) |

## Safe Configuration Examples

Runtime configuration starts from `src/backend/appsettings.json`; Production adds the checked-in `src/backend/appsettings.Production.json` overlay. The only backend example is the minimal development overlay at `src/backend/appsettings.Development.example.json`, while production operators copy `.env.production.example` to a private `.env.production` and replace every `CHANGE_ME` value. The root `.env.example` remains the local-development environment template. Do not recreate standalone full appsettings examples or commit a production env file.

Do not commit copied `.env`, production `appsettings*.json`, database exports, Redis dumps, log bundles, or generated local credentials.

## Secret And Privacy Scrub

Current scanner output is generated under the untracked `.tmp/open-source-readiness/` directory. These reports describe the invocation that produced them; they are not release-closeout evidence unless a release-bound collector independently includes and seals them.

| Evidence | Command |
|----------|---------|
| Secret/history/issue scan | `node tools/security/open-source-secret-scan.mjs` |
| Dependency license audit | `node tools/security/open-source-license-audit.mjs` |
| Supply-chain vulnerability audit | `FSUSBLOG_SUPPLY_CHAIN_AUDIT_DIR=.tmp/open-source-readiness/supply-chain tools/security/check-supply-chain-audit.sh` |
| CodeQL SARIF analysis | `.github/workflows/codeql.yml` |
| OpenSSF Scorecard posture scan | `.github/workflows/scorecard.yml` |
| Branch protection and workflow permissions | [docs/repository-governance.md](repository-governance.md) |
| Historical v1.1.0 checklist | `docs/reports/open-source-readiness/v1.1.0-public-preview/readiness-checklist.md` |

The retained [v1.1.0 public-preview snapshot](reports/open-source-readiness/v1.1.0-public-preview/README.md) is dated, revision-scoped provenance. Historical `green` or `ok` fields there do not state current master readiness and cannot satisfy fresh or release gates.

The secret scan covers the tracked tree, git history, public GitHub issue text, issue comments, and a documentation image inventory. It blocks unapproved private keys, tokens, production-looking credentials, public IPs, and personal email patterns.

The supply-chain audit verifies npm and NuGet lock files, runs `dotnet list package --vulnerable --include-transitive`, runs `npm audit --omit=dev --audit-level=high`, and blocks high or critical vulnerabilities.

## Repository Security Posture

GitHub-native posture checks are part of public-preview readiness:

- CodeQL scans C# backend/shared/core source and JavaScript/TypeScript frontend source on pull requests, default-branch pushes, weekly schedule, and manual dispatch. It stores SARIF artifacts while this private repository has code scanning disabled.
- OpenSSF Scorecard runs on default-branch governance changes, weekly schedule, and manual dispatch. It stores a SARIF artifact without Code Scanning upload while this private repository has code scanning disabled; no Scorecard checks are ignored.
- Branch protection expectations, required merge checks, and workflow permission rules are maintained in [docs/repository-governance.md](repository-governance.md).

Workflow permissions default to `contents: read`. Write scopes must be justified by workflow purpose, such as `actions: read` for CodeQL/Scorecard metadata, `pull-requests: read` for Dependency Review and private-repository Scorecard metadata, `issues: read` / `checks: read` for private-repository Scorecard metadata, or `packages: read` for trusted Quality Gate package access. CodeQL and Scorecard remain read-only artifact workflows until code scanning is enabled. Secret-dependent workflows must not execute untrusted fork PR code.

## Brand And Demo Content

The repository does not include separate trademark artwork, production logo assets, real production content, real public registration numbers, private domains, private IP addresses, or personal account data. Public-preview screenshots and demo seed data are fictional examples for documentation and local testing.

The visible `FsusBlog` wordmark in screenshots is rendered as plain text for documentation context. Future brand or trademark rules can be added without changing the Apache-2.0 license for repository code.
