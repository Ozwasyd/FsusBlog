# Repository governance authorities

Repository-only checks are owned by five content-addressed authorities declared
in `config/governance/repository-governance-authorities.json`; the [document
lifecycle](../development/document-lifecycle.md) and [testing strategy](../testing.md)
define adjacent canonical policy.

| Authority | Purpose | Production fresh behavior |
| --- | --- | --- |
| `application-static-governance` | Static, security, configuration, contract, and architecture checks that can change application correctness | Always executes |
| `test-asset-governance` | Matrix, runner, coverage, lifecycle, flaky-test, replacement-ledger, and retention checks | `ensure` executes only when its exact declared identity changed |
| `workflow-lint` | Workflow and matrix/job topology | Never executes |
| `document-governance` | Authoritative documentation, lifecycle, public evidence, and implementation-drift checks | Never executes |
| `community-governance` | Issue/PR templates, labels, labeler, and CODEOWNERS | Never executes |

Each authority has one canonical owner and declares complete inputs, checker
sources, parser/toolchain identity, and rule/test IDs. A successful run writes an
immutable receipt at `.cache/repository-governance/<authority>/<sha256>.json` and
the `current.json` pointer. It seals source commit/worktree fingerprint, input
tree, checker and parser/toolchain digests, rule/test IDs, each command-output
digest, aggregate output digest, and its own content digest.

Receipt validity is identity-only: no TTL, age, generation timestamp, or
wall-clock expiry. Any input, checker, parser/toolchain identity, rule/test set,
output record, source commit, or worktree-fingerprint change invalidates it; file
modification time does not.

## Local entry points

Run a repository-only authority explicitly:

```bash
node tools/governance/repository-governance-authority.mjs run workflow-lint
node tools/governance/repository-governance-authority.mjs run document-governance
node tools/governance/repository-governance-authority.mjs run community-governance
```

Verify without executing its checker:

```bash
node tools/governance/repository-governance-authority.mjs verify workflow-lint
```

Run only when the current exact-input receipt is missing or invalid:

```bash
node tools/governance/repository-governance-authority.mjs ensure test-asset-governance
```

Production Fresh runs `application-static-governance` and, after Vitest settles,
`ensure test-asset-governance`; it does not invoke workflow, document, or
community governance. Full C# style is the sole C# style pass here; changed-only
style remains available for directed daily checks.

`release-final` calls `verify` for all five receipts, never `run` or `ensure`; a
missing/stale exact-input receipt therefore fails closed without silently
rerunning repository governance during aggregation.
