# Locale Button source WIP

This is ordinary partial source progress for open issue #1895, related to #1891. It is not a control-legality seal, test result, runtime receipt, UI acceptance, qualification, or cutover completion.

## Source boundary

- Requested Blog base: `d5773ef97f55176a1eab67e677790f3e13352a7b`.
- Dedicated PR base branch: `codex/r22-locale-button-base-d5773ef9`, fixed at that commit. Current `master` has diverged; this increment does not include that unrelated history.
- Candidate branch: `codex/r22-locale-button-primitives`.
- Only production path: `src/frontend/src/components/ui/LocaleSelector.vue`.
- Original production blob: `86ec82ec6ffe7f5bfcdddfff7dde7c05686255ba`; SHA-256 `e40b8dcc953e9e8aaba962eb191cb325b0baf55f268f745261003853e95a23da`.
- Initial draft commit: `cdfba06773a465085577e680bd8edb0021c5a9d4`; production blob `06fb5311401fd38acf335cab434d0517ddf62f50`.
- Accepted slot/margin repair commit: `e790387795b050ea1f20c8ac9b96efe1c0219b55`; production blob `5e9498ca0e12bc3a0eab2df86f93a9854abd0b19`.
- Content-height repaired production blob: `e7a69205123a67e7b8414a0b78b56f6f73762339`; SHA-256 `93d16fc68cc9023a80e2393cfdc30ddb526097bf488a66ebcc90731bec12a90b`.
- Real UI961 alias: `/workspace/FsusUI`, clean at `c77281165226ffd84223c4c8d43805c5deb2b1b3`. Its source package identity is `element-plus@1.5.1`; the Blog public package import is `@ozwasyd/element-plus`. Source identity, rather than the version string, binds this local comparison.

The original repository local-application typecheck producer resolves this alias using `FSUSBLOG_USE_LOCAL_FSUSUI=1` and `FSUSBLOG_LOCAL_FSUSUI_ROOT=/workspace/FsusUI`. It retains the full application include set, original strict options, local public entry point and dependency closure. No reduced project, mock, skip, config rewrite, or replacement resolver is introduced.

Source references consulted: Blog design governance and surface profiles, both repository design-conformance Skills, UI design governance/classification, consumer integration, visual workflow and public Button contract. This is prescribed consumer composition in public navigation; formal rendered/independent acceptance is not claimed. The Blog Skill SHA-256 is `0122f00f1b14f98a92daf5164e59487cba2fad3d45b5547c7b0e96f5cb08ce73`; UI Skill is `c88357a6ba0340000bae5839daeb67a3cd2722e8242cf7e0148006c3610a44fe`; UI public Button contract is `fde2fdbe5d25cd3811189020264e8e1c5714ce593d5fdb92a888aa7fb7303f76`. These ordinary read identities do not grant acceptance or authority.

## Implemented source increment

The existing public `@/fsusui/button` adapter now supplies the trigger, both error-retry occurrences, and the no-href branch of the existing dynamic menu item. Each uses public `native-type` for its original native button type. The truthy href branch still renders the native anchor with the same href, disabled treatment, role, locale data, direction, event bindings and content; its native-type binding is undefined and adds no attribute.

Trigger focus resolves through public `ButtonInstance.ref`. The existing item-ref setter retains native anchor elements and resolves component instances through that same public ref. No private `$el`, DOM query, component traversal or new controller is introduced.

The local `LocaleButtonInstance` interface represents only the documented optional HTML button ref. It has no runtime behavior. The first candidate imported the public ButtonInstance type directly; vue-tsc accepted it, but the original ESLint TypeScript program could not resolve that SFC-derived type and emitted seven new unsafe/error-type diagnostics. Those were introduced here, not baseline failures. The structural annotation removes the unresolved type dependency without changing the public ref access, weakening a rule or changing a handler. An obsolete rerun was terminated when this annotation was aligned with the original interface style rule; those interrupted runs are not passes.

All original business, select/retry/open-change payloads, controlled/uncontrolled open state, keyboard algorithms, outside-pointer owner, locale presentation helpers, pending/error/disabled labels, item ordering and lifecycle hooks remain. Only the permitted public ref adaptation changes focus access. The original retry has no aria-disabled attribute; an explicit undefined fallthrough binding retains that absence rather than adopting the Button default. Existing trigger/item ARIA bindings remain.

This intentionally retains the existing menu kernel. Issue #1891 explicitly rejects a Button-only change as full menu cutover; this increment makes no such claim. Locale source/API/store/navigation and Dropdown migration remain outside ownership.

## Bounded layout review repair

Independent review reported two source-layout P2s in the initial draft: the Button content span groups the previous direct children, so root alignment/gap no longer separates copy/status or trigger/pending; and adjacent Button menu rows inherit a left margin while already occupying the full menu width.

The repair adds product-owned markup inside the public default slot. Trigger and both retry occurrences have an explicit content row with the original center alignment and gap. Only the no-href item branch receives an inner full-width flex row with the original top alignment, space-between and gap. That Button root uses a single flexible grid track so its slot content can occupy the complete row width without selecting or styling the library's content span. The href branch retains its original direct copy/status children and native anchor identity.

The product menu/item selector explicitly sets row margins to zero. Its own-class specificity exceeds the adjacent Button default, so consecutive no-href rows do not accumulate the default 12px left offset on top of width 100%. No private selector, deep rule, CSS token, focus override, additional locale state or controller is introduced. The complete script block, public refs, event expressions, ARIA bindings, locale calculations and canonical projection are unchanged from the initial draft. Shared coarse-focus work remains with its separate UI author.

This is a source repair, not a rendered acceptance claim. Runtime and visual HOLDs remain.

## Initial original static comparison

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

## Layout repair static comparison

The clean initial draft and original-base logs above remain bound to their recorded source identities. The UI961 source, original application/compiler/linter configuration, dependency locks and tool versions are unchanged. The same complete commands are rerun on the layout repair; no file filter, reduced configuration, mock or skip is used.

The complete application typecheck exited 2 with the same 29 errors (Blog 4 / UI 25). All diagnostic lines are identical to both the original base and initial draft (`cmp` exit 0); their SHA-256 remains `14f7f7ca020604862376852119e38f4418417f30965bc1846a4ae4593d7eadf3`.

The original full lint exited 1 with the same 83,667 diagnostic lines. All diagnostic lines are identical to both previous sources (`cmp` exit 0), with SHA-256 `e3f52c2de413f7f3556242ddcc25deac6c4dbb9aecd27a135d40bab41ea3f75a`. The complete raw lint log is byte-identical to the original-base log. Neither check reports the owned component. All original errors, stale baseline reports and HOLDs remain FAIL/HOLD; there is no waiver or source-baseline update.

Current raw logs (`typecheck.log`, `lint.log`) and complete extracted diagnostics are retained under `/tmp/r22-locale-layout/`. Git whitespace verification passed. No tests, discovery, runtime, browser, native, DB or qualification lane was run. The same draft PR #4392 is updated with this bounded follow-up; its base remains pinned at `d5773ef97f55176a1eab67e677790f3e13352a7b`.

## Content-driven row height rereview repair

Independent rereview accepted the previous slot and margin repairs but reported one remaining P2: the no-href menu button still inherited the public Button's fixed 44px height. Two-line native/English copy plus the existing vertical padding can exceed that fixed size even when min-height is present.

The only production change in this follow-up is `height: auto` on the existing product-owned `.locale-selector__item--button` class. The shared product item rule still supplies `min-height: 44px`; padding, grid/slot layout, row margins and the real anchor branch are unchanged. No selector for library internals, shared Button source, focus rule, script, ref, event, ARIA binding, locale/pending calculation or canonical projection is changed. UI975 remains a separate dependency and is not substituted for the recorded UI961 alias.

The original complete application typecheck and full lint use the unchanged real UI961 source and original configurations. Comparison uses the source-bound original-base and accepted slot/margin repair logs above. No reduced project, file filter, mock or skip is introduced.

The complete application typecheck exited 2 with the same 29 errors (Blog 4 / UI 25); all diagnostic lines are byte-identical to both comparison sources (`cmp` exit 0), with SHA-256 `14f7f7ca020604862376852119e38f4418417f30965bc1846a4ae4593d7eadf3`.

Full lint exited 1 with the original 83,667 diagnostic lines, byte-identical to both comparison sources (`cmp` exit 0), with SHA-256 `e3f52c2de413f7f3556242ddcc25deac6c4dbb9aecd27a135d40bab41ea3f75a`. The complete raw lint log is also byte-identical to the original-base log. Neither complete check reports the owned component; all original failures and stale baseline reports remain failures. Git whitespace verification passed.

Current raw logs (`typecheck.log`, `lint.log`) and complete extracted diagnostics are retained in `/tmp/r22-locale-height/`. No tests, discovery, browser, product runtime, native, DB or qualification command was run. Runtime, rendered acceptance, qualification, frozen-artifact work and the separate UI975 dependency remain HOLD. The same draft PR #4392 is updated; its source base remains unchanged.

## Preserved HOLDs and limitations

No tests, test discovery, product-module execution, browser, native, DB, frozen artifact, qualification or package-publication operation was performed. No registry entry, gate, authority document, fixture, assertion, generated contract, dependency pin or acceptance receipt is changed. Existing #1895 and #1891 failures and HOLDs remain; historical results in those issues are not rerun or promoted here.

Runtime event/focus/ARIA equivalence, keyboard races, controlled open behavior, published-package parity, themes, RTL, narrow/wide layouts, zoom, forced colors, touch and reduced motion remain unverified. The reviewed slot-layout, row-margin and content-height regressions have product-owned source repairs; no rendered verification is claimed and no private selector is used. Static comparison cannot establish rendered conformance or independent UX acceptance.

Stop the affected follow-up if preserving an original business, keyboard, session, continuity, locale, security or authority handler requires more than public Button ref adaptation. No protected-handler change was needed for this bounded source increment.

## Delivery and rollback

Draft PR only. No merge, Ready transition, issue closure, deployment, package publication or full cutover claim. Omit or revert this two-file increment if public root/ref/event forwarding or locale continuity regresses; there is no database or live-data migration to reverse.
