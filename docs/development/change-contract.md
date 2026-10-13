# Change contract

This document defines FsusBlog's commit, pull-request, format-migration, and release-note flow. The sole executable enumeration is in `tools/governance/change-contract-registry.mjs`; `tools/governance/check-change-contract.mjs` is the authoritative PR/push executor. `commitlint.config.mjs` is only a compatibility adapter for editors or external commitlint integrations: it is not an independent authority and cannot replace the repository checker. GitHub release configuration and focused tests consume or verify the same registry; no second type/scope list is maintained.

This contract governs Git and review metadata and does not change the source rules in [cross-language coding conventions](coding-conventions.md). Git branches, GitHub labels, test IDs, and CLI keys are external tool interfaces; do not mechanically apply C# `PascalCase` to them.

## Commit header

Every mergeable commit and squash title uses:

```text
type(scope): imperative summary

Optional body explains why and risk instead of replaying the diff.

Refs: #1234
```

The PR title validates only the header; the final squash message and commits entering the default branch must also carry a `Refs` footer. An English summary starts with a lowercase imperative verb, ends without a period, and avoids uninformative summaries such as `update stuff`, `fix bug`, or `cleanup`. A breaking change uses both `!` in the header and a `BREAKING CHANGE:` footer.

Allowed types are: `feat`, `fix`, `perf`, `refactor`, `style`, `test`, `docs`, `build`, `ci`, `chore`, `security`, and `revert`.

- `style` is only for mechanical `format-only` or `naming-only` changes; it must not carry runtime logic, contract, or test-expectation changes.
- `perf` must include `Performance-Claim: S|M|R|C` and an in-repository `Evidence:` path; level semantics come from #1155 code-intent governance.
- `security` must include `Security-Disclosure: private|not-applicable`; public header/body text must not include exploit details.
- `refactor` declares structural equivalence only; it does not claim performance, a bug fix, or behavior improvement.
- `docs` changes must not mix with runtime logic; `test` must not modify product runtime.
- `revert` writes `Reverts: <commit-sha>` and retains the linked issue.

The allowed stable scopes are: `admin`, `aeds`, `api`, `auth`, `backend`, `build`, `cache`, `ci`, `cmake`, `contracts`, `core`, `cpp`, `csharp`, `database`, `deployment`, `docs`, `frontend`, `governance`, `json`, `markdown`, `operations`, `performance`, `privacy`, `public`, `release`, `security`, `shared`, `shell`, `style`, `test`, `tooling`, `wasm`, `yaml`, and `zk`. A scope expresses a stable review boundary; do not add one for each directory, page, or temporary task.

Valid examples:

```text
feat(frontend): expose article reading progress

Keep progress local to the reader session so a failed sync cannot block reading.

Refs: #1234
```

```text
perf(cache): reduce measured hot-read latency

The cache lookup avoids a repeated allocation on the measured route.

Performance-Claim: R
Evidence: artifacts/performance/hot-read.json
Refs: #1234
```

```text
security(auth): harden session transition checks

Keep public history limited to the defensive boundary.

Security-Disclosure: not-applicable
Refs: #1234
```

## Mechanical migration sequence

Issues #1158, #1159, #1160, and later repository-wide format migrations are strictly split into this order:

1. A `build(style)` or `feat(governance)` rules/config commit;
2. A separate baseline/evidence commit that records pre-migration facts without adding an allowed-debt count or error ceiling;
3. A separate `style(<language>)` mechanical-only commit;
4. A later commit registering the complete SHA from step 3 in `.git-blame-ignore-revs`;
5. Naming or structural fixes separated by module and contract boundary.

The format-only commit must also include:

```text
Change-Class: format-only
Formatter: formatter-name@version :: exact formatter command
Idempotence-Evidence: artifacts/style/idempotence.json
Refs: #1234
```

The `Format-only` gate independently reviews language tokens, structural semantics, or standard formatter output for each declared format-only commit. It must not approximate semantic preservation by deleting all whitespace: C/C++ token boundaries, Shell/YAML indentation, and Markdown whitespace can change behavior. Any database migration, API schema, generated contract, or test-expectation change fails and must move to a behavior, naming, or generated commit. A format-only commit does not regenerate unrelated artifacts or modify external contracts.

The formatter must run twice to prove idempotence. PR `Formatter idempotence evidence` is a JSON file changed by this PR with schema `fsusblog.format-idempotence-evidence.v1`; it must include formatter identity, version, the complete command, checked repository-relative paths, the same algorithmic tree digest from the first and second runs, and `idempotent: true`. The checker recomputes or verifies paths and digests; free text, unchanged paths, or a claim that it “ran” is not evidence.

JavaScript (`.js`, `.mjs`, and `.cjs`) format equivalence uses the pinned Espree parser from the checker's own checkout. It compares the complete AST, raw tokens and literals, and comments anchored to adjacent tokens while discarding only source locations. ASI, regex, template, and directive changes cannot bypass review by deleting whitespace. Parsing failure or a missing parser rejects the change; TypeScript, Vue, and indentation-sensitive languages retain their existing conservative checks. The parser installation entry point is `npm ci --ignore-scripts --prefix tools/governance/javascript-format-parser`; PR and push checks use the trusted checkout, do not load parsers from the candidate or `NODE_PATH`, and do not run package lifecycle scripts.

Install-time lock integrity and runtime path binding are separate evidence. Runtime validation checks dependency names and versions plus the canonical regular-file paths of direct and transitive entry points, rejecting symlinks and entry redirection; a matching version does not prove complete byte identity. After the first load, every format decision in the same process revalidates the dependency tree digest so a cached parser cannot hide later file changes. This validation does not replace the trusted checkout's locked installation or claim atomic isolation from concurrent filesystem attacks.

Mechanical naming commits use:

```text
Change-Class: naming-only
External-Contracts: preserved
Refs: #1234
```

Database identity, wire/API schema, and generated contracts cannot use `Naming-only` as an escape; changes require public-contract review. A commit cannot register its own SHA, so `.git-blame-ignore-revs` must be updated in a separate commit after the format-only commit. The PR gate finds format-only commits from merge base to head, checks each parent diff, and then requires a later governance commit to register exactly the same SHA set; a PR aggregate diff containing blame metadata is not mistaken for one format-only diff.

Register only complete SHAs that are reviewed, reachable, non-merge, genuinely `format-only`, and verified against the real diff. Migrations #1158/#1160 merged before #1163 took effect and lacking a `Change-Class` footer may be grandfathered only through per-SHA legacy review metadata in the executable registry; a subject beginning with `style` is insufficient, and scope, prefix, or wildcard cannot expand the legacy exception:

```bash
git config blame.ignoreRevsFile .git-blame-ignore-revs
node tools/governance/check-change-contract.mjs --repository
```

To roll back a format migration, revert the corresponding mechanical commit; rules/config and evidence remain separate so reviewers can distinguish a temporary rollback from a standards rollback. Removing a gate does not require an application restart, but it requires a separate `ci(governance)` change describing the risk; do not remove a blame-ignore SHA that remains historically valid.

## Pull request contract

`.github/PULL_REQUEST_TEMPLATE.md` is the structural entry point, and the `Change Contract` status check is the authoritative machine gate for squash titles and PR metadata. Every PR must identify a linked child issue, substantive scope summary, at least one checked test entry, classification, coding convention, docs/intent, compatibility/risk, performance, release note, generated binding, rollout, and rollback; removing these sections cannot pass the parser.

The parser reads fields by Markdown section: headings must be unique and part of the real document structure, fenced examples cannot fake sections, and fields cannot cross or repeat sections. Required contract checkboxes must actually be checked; when a field does not apply, explain why in `Notes For Reviewers` and confirm that it was reviewed. `Behavior change`, `Format-only`, and `Naming-only` remain mutually exclusive and cannot be bypassed by retaining an unchecked template.

- `Behavior change`, `Format-only`, and `Naming-only` are mutually exclusive; the latter two require a `style` title.
- `Generated output`, `Public contract change`, and `External naming exception` are supplemental classifications.
- `External naming exception` requires a repository-relative JSON manifest changed by this PR, with schema `fsusblog.external-naming-exceptions.v1`. Each entry independently names the exact exception ID from the #1157 registry, affected paths, and why internal naming cannot be used; the checker binds each ID/path scope and requires the union of all entries to equal every registered naming surface in the changed files. Duplicate IDs, paths repeated across entries, unchanged or out-of-scope paths, and uncovered surfaces all fail closed; one broad ID cannot cover unrelated paths.
- When a merged PR's authoritative head omitted its declared external-naming manifest, a repair PR uses `fsusblog.post-merge-external-naming-evidence-repair.v1`. The repair manifest binds the repository, original PR, base/head/merge parents and ancestry, original candidate and current source blob, unchanged source revision, registered surface ID/reason, and missing-artifact path/digest. The checker also proves the artifact was absent from the original head, merge, and current base; the candidate adds only the exact artifact and does not modify registered source. If the repair itself changes a registered surface, `currentExceptions` must still bind every ID/path/reason under the ordinary rules and its path union must exactly cover the PR's current governed changes. Wrong repository/history/blob/path/surface, any field, extra or missing exception, later source drift, and `latest`, mtime, or mutable PR-body discovery all fail closed. Only this strict repair class allows merged source to be absent from the repair diff; ordinary exception rules are not broadened.
- A generated diff normally belongs in the same PR as its generator source and lists source, outputs, and the changed JSON binding manifest. The only exception is the strict post-merge repair below.
- A generated binding manifest uses `fsusblog.generated-output-binding.v1` and includes at least generator source paths, each output's repository-relative path, and a SHA-256 recomputed from the head blob. The checker disables local Git replacement refs, resolves the candidate revision to an exact commit, reads an exact regular blob of no more than 16 MiB from the tree, rejects symlinks, non-file objects, oversized or truncated content, and does not trust worktree bytes. The manifest itself must be a changed path in this PR but is not recursively bound as relationship evidence; arbitrary 64-bit placeholders or unresolved evidence files cannot pass.
- When a merged source revision omitted generated output, a generated-only PR uses `fsusblog.post-merge-generated-output-repair.v1` and may select only a canonical producer in the trusted registry. The manifest binds the source revision, named merged PR, outer merge commit, current source/generator blob, canonical command, and each output's checked-in digest at the current PR base, expected digest from replaying the source revision, and current digest at the candidate head. An existing single-parent source revision still requires its parent to align with the canonical producer and may change only trusted source. If the current last source revision is a two-parent merge inside the merged PR head, the only extension requires the first parent to be the isolated replay parent and the second parent to equal the outer PR base byte-for-byte; the source revision must be on the exact first-parent chain of the outer PR head and be the only current last trusted-source revision between the outer head and current base. Relative to the replay parent, the source revision must change trusted source without changing generator/output, and both parents' checked-in outputs must remain unchanged at the source revision. Historical same-blob pass-through is not a general relaxation: additional proof is admitted only for an immutable tuple fixed in the trusted registry to one repair base/head, all source/merge and pass-through/outer-merge parents, and source/generator/output object identities. The checker revalidates the second-parent authoritative blob, source provenance from that second parent only, both first-parent lineages, outer-merge isolation, the unique source event in all history, zero generator/output events, and every fixed regular-blob/mode identity. It disables local Git replacement refs and runs the producer in isolated worktrees for the replay parent, source revision, and candidate head. Any unregistered or approximate tuple, inversion, wrong or extra parent, side-parent/ambiguous/non-last history, non-current source owner, source/generator/output change-revert, unknown command/output, extra producer output, arbitrary field, `latest`/mtime discovery, stale digest, unchanged output, or non-canonical candidate bytes fails closed. Reusable future semantics require an explicit schema-version increase; this historical exception must not be expanded. The trusted policy itself may be upgraded only through owner-controlled bootstrap; a candidate checker cannot self-approve.
- A multi-step producer must not masquerade as the single-source/command case above. `fsusblog.post-merge-generated-output-repair-dag.v2` accepts only trusted-registry canonical repair/external-naming manifest paths and an ordered DAG: each step binds its executable, arguments, dependencies, actually consumed predecessor output, generator closure, and complete output roster verbatim. Starting from the latest canonical synchronized revision and its named outer merge, the manifest covers up to 64 ordered source events through the exact PR base; each event's source revision must be on the corresponding outer head's first-parent chain and must not modify DAG output, generator closure, or trusted policy. Before running any candidate/history generator, the checker completes full-history closure/policy preflight from exact Git blobs and accepts at most 128 unique replay revisions and 1536 producer executions per verification; a candidate-supplied naming-manifest path is not added to the preflight allowlist. The checker disables replacement refs, runs every step in order in an isolated worktree, and uses a second fresh replay to prove determinism. Each step may write only its own regular, non-symlink output; later steps may not overwrite earlier output, and declared dependencies must be proven consumed by a tamper probe. The checker recomputes the synchronized/base/head canonical scanner semantic projection and the tracked input tree after excluding all outputs and exact repair metadata. Base drift, `repairRequired`/`changed`, PR-declared outputs, and candidate changed files must be the same exact subset; unchanged outputs stay byte-identical and cannot be fabricated as changed. The candidate must reach a fixed point and add nothing beyond repair metadata, necessary external-naming metadata, and that subset. Omission, duplication, reordering, over-limit input, unknown step, partial repair, unexpected tracked/untracked/ignored write, non-deterministic producer, source supersession, or candidate-side source/policy mutation fails closed. Upgrading the v2 registry/schema/checker and establishing a new synchronized anchor must regenerate the complete DAG in the same owner-controlled bootstrap PR; expected rejection by the old checker must not be described as trusted approval.
- `fsusblog.post-merge-generated-output-repair.v2` is reserved for the registered correctness-attempt inventory's digest-only repair. Its trusted registry binds the complete 13-file source/import closure, canonical `node tools/test/generate-correctness-attempt-producers.mjs --write` command, output roster/schema, regular Git modes/object IDs and SHA-256 digests, and the exact source parent/source commit plus merged PR #3271's merge, base, and head identities. The shared checker dispatches this schema only through an authority checkout at the candidate base; the candidate may change only the exact repair manifest and canonical output, and the candidate output identity is read from the trusted external PR head rather than selected by the manifest. It verifies all-parent history, no closure/policy drift or change-revert, exact source/merge topology, two fresh isolated replays plus fixed-point passes for source parent/source/base/candidate, and preservation of every non-digest output field. This v2 policy bootstrap changes trusted checker/registry/schema sources and therefore requires owner-controlled promotion; an old/base checker rejection is expected and is not production qualification. Synthetic adapter fixtures and non-Linux local skips are not evidence of canonical Linux production qualification. Existing v1 and DAG v2 semantics remain unchanged.
- Historical DAG synchronization imports may consume only finite history sealed in the trusted registry: the complete first-parent and side-parent graph, regular Git objects and modes, synchronized source ownership, and reviewed generator closure epochs must be recomputed and match the history seal. Imports must preserve the second-parent authoritative entry from a mainline ancestor; reviewed policy transitions must not include generator or output changes. Each old epoch executes its original tracked tree and producer bytes. Before execution, every replay rejects nonregular, symlink, outside-tree, or Git executable-mode drift while retaining output scope, execution bounds, and double replay. A sealed historical branch may contain multiple semantic transitions only when source events match every replayed transition exactly once and in order, with an explicit unique outer merge; unregistered branches still require a single transition. Beyond the historical frontier, each policy path may retain its reviewed initial identity or move once to the exact current identity at the loaded trusted base; rollback, unregistered intermediate identities, and transitions mixed with generator or output changes fail closed. This does not allow repair candidates to change policy or admit arbitrary ancestors as reviewed history.
- `fsusblog.post-merge-generated-output-repair.v3` is restricted to the backend evidence-path inventory and the exact mainline history sealed for #3520. It does not infer merged-PR approval from reachability: the synchronized anchor, historical frontier, ordered matrix source events, complete parent graph and regular mode/object/SHA-256 identities require independent bootstrap review. The six-file producer/import closure, output and historical policy paths cannot change except at those matrix events. After the frontier, source and output remain fixed; each policy path may move only from its historical identity (or proven absence for a new policy file) to the exact trusted base identity, never through an intermediate identity or rollback. The repair candidate may change only its registered manifest and output throughout its full history. The checker completes closed-shape, bounded history, blob and policy preflight before two fresh isolated replays plus fixed-point passes at the anchor, every source event, frontier, base and candidate; repeated revisions are executed once per pair. Exact read/write sets, all non-source output fields, canonical source digests and final bytes are checked. The metadata preparation command reads the producer registration from an isolated checkout of the exact base and cannot promote candidate rules; preparation itself executes no producer and grants no qualification. The old/base checker rejects this policy bootstrap until owner-controlled promotion through the current ruleset. Controlled adapter tests do not replace independent review or actual Linux isolation evidence. Existing v1, correctness digest v2 and DAG v2 semantics and historical seals are unchanged; the shared gate separately protects the newly introduced v3 policy files.
- The [finite embedded fact-section history preflight](../../tools/governance/fact-section-repair-history.design.md) is a read-only review component, not an active generated-only repair schema. Its exact graph and document checks return `preflight-only` with `qualification: false`; successful preflight cannot substitute for original producer-epoch replay, a freshly executed current-source observation, complete generated-range checks, independent acceptance, or separately authorized trusted promotion. Existing generated repair schemas and ordinary PR metadata requirements remain unchanged.
- A bot PR must still check generated, provide an automation identity exactly matching the PR author's login, and satisfy title, issue, release-note, and evidence rules; the sender of a label/edit/synchronize event is not the bot-identity authority.
- Split unrelated API, UI, database, security, and style changes; generated output may share a PR with its source but must be separately marked for review.
- There is no universal line-count limit; #1162 governs complexity and responsibility evidence.
- `Linked Issue` contains exactly one canonical primary directive line: `Refs #1234` for an unfinished child or WIP issue, or `Closes #1234` for the child whose complete acceptance conditions are met by this PR. `Refs` links the work without asking GitHub to close that issue on merge; merging source preservation does not complete unverified SDK/native/runtime or full CI acceptance. The gate checks this metadata declaration, not live issue state or acceptance results.
- Duplicate, mixed, malformed, or multi-issue primary lines fail closed. Use a positive decimal issue number without leading zeroes. Ordinary prose and related child/tracking issues as standard Markdown links remain allowed in `Linked Issue` or `Notes For Reviewers`; they do not count as primary directives. Real duplicate headings, fenced examples, and hidden comments retain the existing section parser's refusal boundaries.
- Existing canonical `Closes #1234` remains supported. Change an unfinished issue's declaration to `Refs #1234` before merging; the author/reviewer must separately verify its OPEN state and avoid other GitHub closing statements for that issue. A previously merged PR or historical `Closes` text is not rewritten by this metadata rule.

The PR description must not expand scope by saying “while here.” Template checkboxes are machine input and do not replace test results or reviewer judgment.

Example external-naming manifest:

```json
{
    "schema": "fsusblog.external-naming-exceptions.v1",
    "exceptions": [
        {
            "id": "c-abi-wasm-export",
            "paths": [
                "src/frontend/wasm/aeds/src/exports.cpp"
            ],
            "reason": "preserve the caller-visible C ABI spelling"
        },
        {
            "id": "shell-environment-variable",
            "paths": [
                "tools/example.sh"
            ],
            "reason": "preserve the caller-visible process environment key"
        }
    ]
}
```

S/M/R/C are allowed only with a `perf` PR title, and a PR must have exactly one bound perf commit. `Evidence path` is a `fsusblog.performance-claim-evidence.v1` JSON manifest among this PR's changed paths and must include at least:

```json
{
    "schema": "fsusblog.performance-claim-evidence.v1",
    "changeRevision": "0123456789abcdef0123456789abcdef01234567",
    "claimLevel": "R",
    "status": "measured",
    "evidence": [
        {
            "path": "artifacts/performance/hot-read-result.json",
            "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
        }
    ]
}
```

Level S `status` must be `structural-only`; M/R/C must be `measured`. The checker binds `changeRevision` to the PR's only perf commit and recomputes each changed evidence file's SHA-256 from the candidate head. This binding manifest proves identity/path/blob binding only; the relevant evidence checker still decides whether the measurement satisfies #1155 machine, runtime, artifact, statistical, and route/capacity authority. A self-reported `measured` field is not a substitute.

### GitHub execution topology

The `pull_request` job checks out candidate head and `pull_request.base.sha` separately. It loads the checker from the trusted base checkout and audits the candidate repository through `--root`, preventing a PR from first changing its own gate to a no-op. The candidate diff runs from merge base to head rather than counting later base commits as reverse PR changes. Deletions, renames, and file-type changes all belong to the changed-path set.

The trusted base/before checkout must use complete reachable Git history (`fetch-depth: 0`). Blame-ignore, format-history, and merge-base audits read registered revisions and their parents; an unreachable object caused by a shallow trusted checkout is a CI invocation defect, not a reason to skip history checks or treat the candidate checker as a fallback. The checkout remains pinned to the PR base or push `before` SHA with `persist-credentials: false`.

The trusted checker job executes its existing shared regression suite from that same checkout, not newly introduced candidate test paths that are absent from an older base/before revision. The history-repair regression suite runs against the exact candidate in a separate read-only-permission job and workspace, without depending on trusted-gate success. Candidate tests cannot modify the trusted checker workspace or substitute their result for trusted policy approval. A missing trusted test still fails; there is no candidate fallback or optional test-file skip.

The trusted registry also lists the policy file set for gates, workflows, templates, release config, and the commitlint adapter. If a candidate PR changes any of them, the base checker compares Git objects and rejects the PR; required tokens cannot be left in comments and the future gate replaced. The default branch currently requires every change to go through a pull request under the repository ruleset; read enforcement, target, and bypass actors from GitHub at execution time rather than inferring them from historical documents or local permissions. A policy bootstrap still requires explicit owner authorization and the current ruleset's upgrade path; ordinary contributors have no exception.

After a PR merges into `master`, the `push` job first checks out the previous checker from `github.event.before` to audit the candidate's `before..after` commit range; candidate bootstrap is allowed only on first installation with no prior checker. `workflow_dispatch` uses the candidate checker for the repository audit. Because the push job runs after GitHub receives the objects, it remains a post-merge audit; prevention comes from the ruleset and required pull-request status checks. When GitHub Actions is available, local success cannot replace those remote checks. If Actions is explicitly disabled or unavailable and no remote check can run, a maintainer may merge only after the applicable equivalent local CI for the explicitly selected and Git-bound execution stage is green and the PR records commands, results, and Actions status. Source-stage evidence is not compiled/native/runtime/release qualification; unselected or deferred qualification remains OPEN. A failed applicable check is not waived by a WIP label, and a selection-policy bootstrap needs explicit owner review of its real semantic change. Source-integration admission consists of the mandatory source gates and applicable declared source-only regressions; complete compiled/native/runtime/release qualification remains OPEN and is not a prerequisite claim for delivery of reviewed policy source. Default/full/push/release qualification keeps its original requirements. Missing or unrun remote checks must not be described as passed.

For the explicitly selected source-integration stage, frontend dispatch compares the complete configuration input union declared by the actual Git-bound base and current policies, including the fixed SOURCE data inputs. Missing, untracked or nonregular required configuration and an omitted changed-source input are refusals. If any configuration identity changes, the complete applicable changed frontend source scope uses the existing `strict-full` mode with every strict rule and no exemptions. With identical configuration, JavaScript style comparison inspects the actual base and candidate with the same locked tools, restoring tracked base dependencies needed for source resolution; other applicable frontend source kinds remain strict. Existing diagnostics require the checker's finite source proofs: unique unchanged complete units, or unchanged complete statements with their physical lines and required lexical/ASI context. Module-level layout proofs are limited to unique complete import or variable declarations and both adjacent statements with their physical trivia; import diagnostics additionally bind the complete import roster and actual configuration/dependency identities, and unused-binding diagnostics require the original scope and binding/read evidence. Rule, message, severity and source spans match one-to-one; ambiguous, new, changed, unsupported or unproved diagnostics remain failures. Both raw results and invocation/environment failures are recorded. This SOURCE comparison does not rewrite a persistent baseline, waive an applicable failed check or change default/full qualification.

The bounded C++ SOURCE port consumes an actual `compile_commands.json` from an existing native checker candidate directory and its matching host-native CMake cache. Compiler identity, original argv, current CMake source inputs, changed source and local dependencies are bound; the real compiler supplies the complete dependency closure and runs syntax-only with the same supported C++23 flags. A changed header needs a real translation-unit include edge; suffix recognition or an isolated header syntax probe does not provide that context. Only the explicit compiler/flag allowlist is executable; missing tools, context, dependencies, unsupported flags and syntax errors are refusals. The original native style/intent checker remains mandatory with `--require-tools`, including its existing diagnostics. This host-native port does not admit an Emscripten/Wasm context, replace a native checker owner or issue compiled/runtime/release qualification. Configure the existing native CMake project first, then run `node --test tools/configuration/cpp-source.test.mjs` for the five ordinary compiler/context/refusal controls; CMake, Ninja and GCC must actually be installed, and unavailable tooling is a failed prerequisite rather than a skipped test.

## Release note authority

`.github/release.yml` generates release notes from the unique `release-note:*` label on each merged PR; the repository no longer maintains a parallel root `CHANGELOG.md`. Categories are `Added`, `Changed`, `Fixed`, `Security`, `Deprecated`, `Removed`, and `Internal/Tooling`, with `none` excluding changes that need no entry. Before enabling the gate, create every `release-note:*` label from the registry in GitHub; the configuration file does not create labels.

The PR body's Audience, Category, and Summary must match its label/type. The GitHub generator renders the merged PR title as the entry text, so except for `Category: none`, `Summary` must exactly equal the summary after `type(scope):` in the PR title; `none` must use `Summary: none`. Body Summary is not a second independently drifting changelog copy:

- user-facing: `Added`, `Changed`, `Fixed`, `Security`, `Deprecated`, `Removed`;
- internal: `Internal/Tooling`;
- none: `none` / `release-note:none`.

Pure formatting, internal renames, and CI reordering must not use a user-facing category. Security entries describe defensive results only and do not disclose vulnerability details. Generated and bot PRs are not automatically exempt from release classification.

## Machine identifier exceptions

The following external-tool identities are preserved explicitly and are not mapped to source identifiers:

| Kind | Convention |
| --- | --- |
| `git-branch` | lowercase/kebab-case |
| `github-label` | lowercase/kebab-case, with a colon-separated namespace |
| `test-id` | lowercase/kebab-case |
| `cli-key` | lowercase/kebab-case |

These exceptions protect Git/CLI surfaces only; once the same concept enters a C#/TS/C++ internal symbol, it follows the [cross-language naming map](coding-conventions.md#naming-map).

## Local checks

Local WIP commits do not need a release message every time, but check the staged message or candidate squash title before review:

```bash
node tools/governance/check-change-contract.mjs --message-file .git/COMMIT_EDITMSG
node tools/governance/check-change-contract.mjs --title "fix(backend): reject stale session state"
node tools/governance/check-change-contract.mjs --range origin/master..HEAD
node tools/governance/check-change-contract.mjs --repository
node --test tests/tools/change-contract.test.mjs
```

The GitHub `Change Contract` job reviews the merge-base/head diff, PR title/body, labels, PR author, evidence manifests, and blame-ignore history. Local success cannot replace an available configured protected-branch status check. Use the local-equivalent CI exception defined above only when Actions is explicitly disabled or unavailable, and retain PR evidence; the post-merge push job remains a post-merge audit.
