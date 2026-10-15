# Locale Button source WIP

This is ordinary partial source progress for open issue #1895, related to #1891. It is not a control-legality seal, test result, runtime receipt, UI acceptance, qualification, or cutover completion.

## Source boundary

- Requested Blog base: `d5773ef97f55176a1eab67e677790f3e13352a7b`.
- Dedicated PR base branch: `codex/r22-locale-button-base-d5773ef9`, fixed at that commit. Current `master` has diverged; this increment does not include that unrelated history.
- Candidate branch: `codex/r22-locale-button-primitives`.
- Only production path: `src/frontend/src/components/ui/LocaleSelector.vue`.
- Original production blob: `86ec82ec6ffe7f5bfcdddfff7dde7c05686255ba`; SHA-256 `e40b8dcc953e9e8aaba962eb191cb325b0baf55f268f745261003853e95a23da`.
- Candidate production blob: `06fb5311401fd38acf335cab434d0517ddf62f50`; SHA-256 `44f7faa2dd006f24379c8603968fff09117789eddc38a720cd3831f5875372d0`.
- Real UI961 alias: `/workspace/FsusUI`, clean at `c77281165226ffd84223c4c8d43805c5deb2b1b3`. Its source package identity is `element-plus@1.5.1`; the Blog public package import is `@ozwasyd/element-plus`. Source identity, rather than the version string, binds this local comparison.

The original repository local-application typecheck producer resolves this alias using `FSUSBLOG_USE_LOCAL_FSUSUI=1` and `FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI`. It retains the full application include set, original strict options, local public entry point and dependency closure. No reduced project, mock, skip, config rewrite, or replacement resolver is introduced.

Source references consulted: Blog design governance and surface profiles, both repository design-conformance Skills, UI design governance/classification, consumer integration, visual workflow and public Button contract. This is prescribed consumer composition in public navigation; formal rendered/independent acceptance is not claimed. The Blog Skill SHA-256 is `0122f00f1b14f98a92daf5164e59487cba2fad3d45b5547c7b0e96f5cb08ce73`; UI Skill is `c88357a6ba0340000bae5839daeb67a3cd2722e8242cf7e0148006c3610a44fe`; UI public Button contract is `fde2fdbe5d25cd3811189020264e8e1c5714ce593d5fdb92a888aa7fb7303f76`. These ordinary read identities do not grant acceptance or authority.

## Implemented source increment

The existing public `@/fsusui/button` adapter now supplies the trigger, both error-retry occurrences, and the no-href branch of the existing dynamic menu item. Each uses public `native-type` for its original native button type. The truthy href branch still renders the native anchor with the same href, disabled treatment, role, locale data, direction, event bindings and content; its native-type binding is undefined and adds no attribute.

Trigger focus resolves through public `ButtonInstance.ref`. The existing item-ref setter retains native anchor elements and resolves component instances through that same public ref. No private `$el`, DOM query, component traversal or new controller is introduced.

The local `LocaleButtonInstance` interface represents only the documented optional HTML button ref. It has no runtime behavior. The first candidate imported the public ButtonInstance type directly; vue-tsc accepted it, but the original ESLint TypeScript program could not resolve that SFC-derived type and emitted seven new unsafe/error-type diagnostics. Those were introduced here, not baseline failures. The structural annotation removes the unresolved type dependency without changing the public ref access, weakening a rule or changing a handler. An obsolete rerun was terminated when this annotation was aligned with the original interface style rule; those interrupted runs are not passes.

All original business, select/retry/open-change payloads, controlled/uncontrolled open state, keyboard algorithms, outside-pointer owner, locale presentation helpers, pending/error/disabled labels, item ordering, lifecycle hooks and CSS remain. Only the permitted public ref adaptation changes focus access. The original retry has no aria-disabled attribute; an explicit undefined fallthrough binding retains that absence rather than adopting the Button default. Existing trigger/item ARIA bindings remain.

This intentionally retains the existing menu kernel. Issue #1891 explicitly rejects a Button-only change as full menu cutover; this increment makes no such claim. Locale source/API/store/navigation and Dropdown migration remain outside ownership.

## Original static comparison

Tool versions in the selected shell: Node `v24.19.0`, npm `11.9.0`, TypeScript `6.0.3`, vue-tsc `3.2.7`, ESLint `10.8.0`, Stylelint `17.14.1`.

The full lint initially exited 1 because its configured ESLint and Stylelint executables were absent. Tool installation used the original `tools/frontend/style-toolchain/package-lock.json`, with lifecycle scripts disabled: `npm ci --ignore-scripts --no-audit --no-fund --cache /tmp/r22-npm-cache`. An initial install attempt failed on the unwritable default npm cache; the explicit task-local cache succeeded. No tracked package, lock, source configuration or policy changed.

The original file was restored byte-for-byte for the paired baseline runs and remained unchanged until both completed. An earlier full compiler run also reported 29 errors, but the controlled paired runs below are the comparison evidence.

```bash
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI npm --prefix src/frontend run typecheck:local-fsusui -- --application
FSUSBLOG_USE_LOCAL_FSUSUI=1 FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI npm --prefix src/frontend run lint:full
```

The original, first candidate and final repaired candidate complete application typechecks exited 2 with the same 29 TypeScript diagnostic lines: 4 Blog errors (upload route/frame source mismatch and unused Analytics ref) and 25 UI errors (unused refs and enum syntax under the original erasableSyntaxOnly option). The final complete diagnostic-line comparison using `cmp` exited 0; baseline and final diagnostic files have SHA-256 `14f7f7ca020604862376852119e38f4418417f30965bc1846a4ae4593d7eadf3`. None reports the owned LocaleSelector path. These remain failures, not passes or waived errors.

The original and final repaired full lint both exited 1 with 83,667 diagnostic lines. Their entire raw logs are byte-identical (`cmp` exit 0), as are all diagnostic lines (SHA-256 `e3f52c2de413f7f3556242ddcc25deac6c4dbb9aecd27a135d40bab41ea3f75a`). This includes the pre-existing stale configuration digest, source-state digest and generatedFrom reports and all original findings across the full source sets. Neither final check reports the owned path. The seven introduced first-candidate errors are absent after the annotation repair; the original 83,667 remain failures.

| Original full command | Baseline | Final source | Comparison |
| --- | --- | --- | --- |
| Complete local-alias application typecheck | Exit 2; 29 errors | Exit 2; 29 errors | All diagnostic lines identical |
| Full canonical frontend lint | Exit 1; 83,667 diagnostic lines | Exit 1; 83,667 diagnostic lines | Entire logs byte-identical |

These commands execute compiler/linter tooling only; they do not execute product modules or tests. No failed result is promoted to PASS. Git whitespace verification passed. No additional checker, test, discovery or qualification lane was run.

Raw local diagnostics are retained under `/tmp/r22-locale-button/`: `baseline-typecheck.log`, `verified-typecheck.log`, `baseline-lint.log` and `verified-lint.log`, with complete extracted diagnostic files alongside. Earlier candidate and interrupted-run logs are also retained. These task logs have no canonical authority.

## Preserved HOLDs and limitations

No tests, test discovery, product-module execution, browser, native, DB, frozen artifact, qualification or package-publication operation was performed. No registry entry, gate, authority document, fixture, assertion, generated contract, dependency pin or acceptance receipt is changed. Existing #1895 and #1891 failures and HOLDs remain; historical results in those issues are not rerun or promoted here.

Runtime event/focus/ARIA equivalence, keyboard races, controlled open behavior, published-package parity, themes, RTL, narrow/wide layouts, zoom, forced colors, touch and reduced motion remain unverified. The public Button's default-slot content wrapper can affect existing child layout; no private selector or compensating geometry override is added. Static comparison cannot establish rendered conformance or independent UX acceptance.

Stop the affected follow-up if preserving an original business, keyboard, session, continuity, locale, security or authority handler requires more than public Button ref adaptation. No protected-handler change was needed for this bounded source increment.

## Delivery and rollback

Draft PR only. No merge, Ready transition, issue closure, deployment, package publication or full cutover claim. Omit or revert this two-file increment if public root/ref/event forwarding or locale continuity regresses; there is no database or live-data migration to reverse.
