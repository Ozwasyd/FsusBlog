# Frontend Source Index and Rule Host

`tools/frontend/run-source-rule-host.mjs` is the canonical producer for source-bound frontend governance. Each run re-enumerates the complete `src/frontend/src` input tree and binds the commit, worktree fingerprint, run ID, parser/toolchain version, per-file SHA-256, and input-tree digest to the same index. It is not a cross-commit cache: any Vue, TypeScript, JavaScript, CSS, or SCSS input change creates a new tree digest and repeats inventory, read, and primary parse.

## Parse and diagnostic contract

A primary parse provides Vue SFC block/span, TypeScript AST/import graph, template class/ARIA/text/route/component metadata, and CSS declaration/token/span. Rules may read only the in-memory index and must not traverse source again. Every rule retains an independent rule ID, coverage ID, finding, source span, receipt digest, and pass/fail result. A missing index, parser-version drift, host crash, missing receipt, digest drift, or source span that cannot point back to an input file must fail the host.

Machine evidence is written to `.tmp/frontend/source-rule-host/`:

- `source-index.json`: complete inventory and inventory/read/parse counts;
- `owner-registry.json`: the unique owner of every `check:*` command in `src/frontend/package.json`;
- `receipts/*.json`: an independent receipt for each migrated rule;
- `rule-host.json`: resident-host summary;
- `migration-before-after.json`: equivalence conclusions for Node processes, duplicate source reads/parses, and conclusion/finding identity before and after migration.

Writers, temporary fixtures, real runner/CLI checks, and unmigrated rules remain independent processes. The owner registry must state each owner and reason explicitly; do not merge these boundaries into the read-only host merely to reduce process count.

## Local run and rollback

```bash
node tools/frontend/run-source-rule-host.mjs
```

For no-restart degradation, restore `frontend-source-rule-host` in `tests/matrix.yml` to the original independent checker entries. Keep the original `check:font-size-contract` and `check:font-weight-contract` commands, run them directly, and compare them with migration evidence. Rollback must not reuse an old index or receipt.
