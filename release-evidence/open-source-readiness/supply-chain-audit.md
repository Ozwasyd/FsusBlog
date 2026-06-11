# Supply-Chain Audit

Status: ok
Generated at: 2026-06-11T03:47:01Z

## Scope

- NuGet projects audited:
  - `src/backend/FsusBlog.Server.csproj`
  - `src/core/FsusBlog.Core.csproj`
  - `src/shared/FsusBlog.Shared.csproj`
  - `tests/backend/FsusBlog.Server.Tests.csproj`
  - `benchmarks/core/FsusBlog.Core.Benchmarks.csproj`
- npm production dependencies audited from `src/frontend/package-lock.json`.
- Lock-file presence verified for npm and each audited NuGet project.
- Security-sensitive backend dependency versions checked against README, `.csproj`, and lock file.

## Policy

- NuGet: fail on high or critical vulnerabilities from `dotnet list package --vulnerable --include-transitive`.
- npm: fail on high or critical vulnerabilities from `npm audit --omit=dev --audit-level=high`.

## Result

- NuGet high/critical blockers: 0.
- npm high vulnerabilities: 0.
- npm critical vulnerabilities: 0.

Machine-readable evidence is stored in `release-evidence/open-source-readiness/supply-chain/summary.json`, `release-evidence/open-source-readiness/supply-chain/nuget/`, and `release-evidence/open-source-readiness/supply-chain/npm-audit.json`.
