# Finite exported registration source handoff

Source branch `codex/chain-3521-registration-producer-2060` is published and remote-verified at `9dd445bb38418e3f918fe18684e95d69492b040a`, based on the explicitly supplied `93eca2bb36c32fe2b89103ed3875a0e48ddad96d`. The source increment changes exactly three files. It leaves the supplied publisher blob `c5057b34cc3cf794fe135316df75e2435e3cbc4c` unchanged. Scheduler candidate `e6efbce8ec875f92053af4ece5c82cc3044d7ed8` remains frozen.

## Source behavior

The existing generator recognizes one finite producer source/export pair. It reads the actual publisher source with the existing locked Espree parser, without importing or executing the publisher. Only direct exported constants, strings, finite local source/consumer constants, templates, arrays, object fields and syntactic Object.freeze wrappers are read. Arbitrary expressions, spreads, accessors, computed or duplicate fields and unknown source/export pairs refuse. The result must satisfy the current JSON schema and existing runtime registry validator, then match the existing canonical source identity, roots and binding rules. Duplicate consumer/authority registration refuses. No scanner classification, admission policy, receipt schema or publication runtime was modified.

The original corrected producer was actually invoked as:

```sh
node tools/test/generate-evidence-location-governance.mjs
```

It exited zero on source commit `f42c8eb6f627bfc5a7de881286efd97f091e561a`, generating both JSON outputs. The committed registry adds exactly one actual exported publisher row; all 117 previous entries are identical. The generated ledger is archived as `unapproved-original-generated-ledger.json` with its complete original diff. This archived output must not be copied into accepted products before independent disposition approval.

## Remaining ledger refusal

The unchanged classification policy generates two replacement findings for the metadata source shifted from line 60 to line 62: current IDs `e4792e2e6789cef9` and `c4470af966c8f87a`. Their not-evidence closure remains unapproved. The original ledger product was preserved at the supplied source input; no unknown finding was accepted merely to make a check pass. The actual original command:

```sh
node tools/test/generate-evidence-location-governance.mjs --check
```

exits one on final `9dd445bb`, refusing only the stale migration ledger. Registration capability is implemented and its generated row is usable for bounded source review; whole governance admission remains blocked on exact independent approval of those two dispositions. After approval, the canonical writer must rerun the same original producer against the then-current candidate and verify its outputs; this archive is not a substitute generation receipt.

## Current verification and limits

Six exact literal-name allowlisted ordinary controls pass on final `9dd445bb`, with zero failures or skips. They cover actual source parsing, no module execution, export identity, declaration shape, schema/required-field refusal, source/root binding drift and unsupported expressions. The allowlist and expected count were recorded before execution. Original read-only import inspection reports no errors and fifteen dependencies; test callbacks were not run by inspection. Original ESLint checks the two changed source files and passes. The original increment commit-range checker passes. All command records bind command, source SHA, UTC interval, PID, exit code and raw-log hash. Initial missing-AJV, unresolved parser-loader import and lint failures are preserved rather than replaced by green receipts.

No full standard SOURCE suite, held receipt/cohort/artifact substitution audit, race/TOCTOU test, live publisher execution or runtime qualification was run or recreated. Qualification remains false. The existing-session availability probe succeeded at 2026-10-08T15:46:38.314140Z with a clean saved source commit; the first resumed action was the actual six-control current-candidate run.

Master was fetched and observed as `85aa75af8949401ef9997c5042d22b1071414e0a`. Its existing generator differs materially from the specified input, including catalog registration and exact finding anchors; the difference is archived for the coordinator. This task does not silently perform master or cross-chain conflict integration. The coordinator owns GitHub content APIs and PR publication. No issue closure, merge, master push or deployment occurred. Roots #3521/#3520 and the full assignment remain incomplete; `assignment-status.json` retains complete expanded ownership accounting.
