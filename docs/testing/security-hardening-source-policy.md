# Backend security Roslyn source policy

`security/policies/backend-source-policy.json` is #1037's sole source-shape authority. `tools/security/FsusBlog.SecuritySourceAnalyzer` uses Roslyn syntax trees to report file, line, column, and stable rule ID; it never wraps production source in `Contains`/`DoesNotContain`. See the [security model](../security.md) for the wider contract.

Current rules reject `Random.Shared`/`new Random` in security directories, ordinary case-insensitive comparisons of sensitive values, raw sensitive structured-log placeholders, and raw exception details outside logs; they also check Argon2 memory/iteration and recovery-key PBKDF2 minima. Policy v2 requires stable policy ID, semver, owner, fail-closed analyzer identity, at least two documentation entries, and each rule's `severity=error`, rationale, and repository-relative include scope. Scope is an allowlist and cannot expand to generated/fixture, external, or unrelated business paths.

`tests/backend/Fixtures/security-source-analysis/positive.cs` must produce zero diagnostics; `negative.cs` must trigger every `FSUSBLOGSEC001` through `FSUSBLOGSEC008`. The Node harness analyzes the repository first, then both fixtures with the same built analyzer, and requires all fixture diagnostics to come only from `negative.cs`.

At central merge, wire `node --test tests/tools/security-source-analyzer.test.mjs` into `static-governance` and bind policy, analyzer, fixtures, harness, and #1037 evidence to one exclusive coverage ID. Do not add a maximum-error allowance; one run must retain every diagnostic.

Run the command standalone to reproduce policy-schema, repository-positive, and negative Roslyn-fixture checks. Only current output determines pass/fail; this document is not fresh evidence.
