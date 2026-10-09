# Protocol negative-control formatting handoff

This is ordinary current-source evidence, not format-only qualification, runtime acceptance or issue completion.

- Base: `0015897304873f75858e0e5546313b43007834d8`; source: `6324264ab60fbf6b196f14c09a447eca58402bbe`.
- Published branch: `codex/shared-protocol-format-20261009`; exact source remote verified before evidence publication.
- Sole source delta: `tests/tools/aeds-protocol-generation.test.mjs`, preimage `396ebcdab7c902de4765a9874e95d2ec71ea9e3a`, formatted blob `bb866e27a28c9758422288efa0e4dffa6148e95b` (see authoritative `scope-manifest.json` for recomputed identity).
- Original formatter fixed 63 brace diagnostics across 21 existing callbacks. It did not rewrite the remaining import at line 8, add assertions, remove controls, change checker/config, regenerate any product or install packages.
- Both original formatter passes exit 1 for that one residual import diagnostic. Their tree digests match: `ce43405912c19a08c1405e3329bdab1488670287051892d2377397aaf76fa101`. Idempotence is a byte observation; it does not claim a successful style result.
- At exact source `6324264ab60fbf6b196f14c09a447eca58402bbe`, current preflight selected all 36 fully qualified cases, including 21 negative controls, checked all nine call sites and both data loops, and found zero hooks or held bodies. Original Node24.16 runner: 36 pass, 0 fail, 0 skip, exit 0. Original producer `--check`: five outputs in sync, exit 0. Syntax and diff checks exit 0.
- Canonical raw-token/AST/literal/comment equivalence remains blocked by the missing original pinned `tools/governance/javascript-format-parser/node_modules`. The original attempt exits 1 ENOENT. No package installation, symlink bypass or alternate comparator was used. No full-token equivalence claim is made. `.git-blame-ignore-revs` is untouched by explicit parent direction while this gate is blocked.
- Remaining source rule is `import-x/no-relative-parent-imports` at `8:43`, on `../../tools/frontend/generate-aeds-protocol.mjs`. This needs a separate lawful import-contract correction owned by the parent, not a rewrite in the mechanical commit.
- The branch inherits the earlier consumer closure. At known master `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`, source head has 155 changed paths; this increment newly qualifies only its focused ordinary checks. Do not treat the branch aggregate as a one-file format-only PR.
- Parent is the sole PR/content API writer. Use the exact minimal source commit in the authorized consumer combination. No merge, close, auto-merge, deployment or denied audit attempt occurred. Original #3735/#3736/#3738 acceptance remains open.

Raw logs, exact test command/results, original negative names, unchanged producer/products/config identities, failed setup and canonical-comparator attempt are retained in this directory. The initial style wrapper attempt failed EISDIR before lint because an unignored task-local dependency symlink was visible to its source digest. Reusing existing dependencies under an ignored real directory corrected only the local layout; checker and tool bytes remained unchanged.

Smallest follow-ups: parent supplies an existing genuinely installed pinned parser checkout or separately authorizes the repository's original locked setup; after canonical equivalence succeeds, the metadata owner registers this exact mechanical SHA in a later commit. Separately implement the lawful import correction and rerun focused applicable source checks. Full inherited/full CI and runtime acceptance are not established here.
