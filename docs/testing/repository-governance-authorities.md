# Repository governance authorities

Repository-only checks are owned by five content-addressed authorities declared
in `config/governance/repository-governance-authorities.json`:

| Authority | Purpose | Production fresh behavior |
| --- | --- | --- |
| `application-static-governance` | Static, security, configuration, contract, and architecture checks that can change application correctness | Always executes |
| `test-asset-governance` | Matrix, runner, coverage, lifecycle, flaky-test, replacement-ledger, and retention checks | `ensure` executes only when its exact declared identity changed |
| `workflow-lint` | Workflow and matrix/job topology | Never executes |
| `document-governance` | Authoritative documentation, lifecycle, public evidence, and implementation-drift checks | Never executes |
| `community-governance` | Issue/PR templates, labels, labeler, and CODEOWNERS | Never executes |

Each authority has one canonical owner and explicitly declares its complete
inputs, checker sources, parser/toolchain identity, and rule/test IDs. A
successful run writes an immutable receipt under
`.cache/repository-governance/<authority>/<sha256>.json` plus a `current.json`
pointer. The receipt seals the source commit and worktree fingerprint, input
tree digest, checker digest, parser/toolchain digest, rule/test IDs, individual
command output digests, aggregate output digest, and its own content digest.

Receipt validity is identity-only. There is no TTL, age, generation timestamp,
or wall-clock expiry. A changed input, checker, parser/toolchain identity,
rule/test set, output record, source commit, or worktree fingerprint invalidates
the receipt. File modification time does not.

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

Production fresh uses `run application-static-governance` and, after Vitest
settles, `ensure test-asset-governance`. It does not invoke workflow, document,
or community governance. Full C# style is the sole C# style pass in this path;
changed-only style remains available for directed daily checks.

`release-final` calls `verify` for the five receipts. It never calls `run` or
`ensure`, so missing or stale exact-input receipts fail closed without silently
rerunning repository governance during release aggregation.
