# ZAP baseline raw result outlet

The existing baseline dispatch in [run-zap-baseline.sh](../../tools/security/run-zap-baseline.sh) awaits a plain Node outlet after each Docker invocation returns. Scanner arguments, targets, mutable stable image selection, WARN policy and upstream skip policy remain unchanged. The outlet contributes raw transport to #2260; integration and acceptance remain with the original security owner.

## Consumer API

[zap-baseline-result-outlet.mjs](../../tools/security/zap-baseline-result-outlet.mjs) exports `publishBaselineResult({ target, scannerExitCode, reportPaths }, outlet)`. Pass the actual target string, raw shell exit code and expected report paths. The async callback receives an ordinary object:

```json
{
    "target": "http://example.invalid/a/b",
    "scannerExitCode": 2,
    "reportPaths": ["reports/example.invalid-a-b.json"],
    "missingReportPaths": ["reports/example.invalid-a-b.html", "reports/example.invalid-a-b.md"]
}
```

Only paths observed as files enter `reportPaths`. Missing paths and non-file paths enter `missingReportPaths`; other filesystem errors reject the promise. Report bytes are never read or parsed. These observations do not establish freshness, custody, unique identity, executed assertions or security acceptance.

The function awaits the callback and returns `{ result, outletError, outletExitCode, exitCode }`. A successful callback sets `outletExitCode` to `0` and leaves `exitCode` equal to the raw scanner code, including WARN `2`. Callback failure sets `outletExitCode` to `1` and retains the thrown value and raw result; effective exit becomes `1` for scanner `0` or `2`, while any earlier scanner failure retains its original code. Consumers must inspect `outletExitCode`, even if the callback throws `null`; a returned object alone does not mean the write succeeded. Collection and argument errors reject rather than masquerading as missing reports.

The shell uses the module's positional CLI with output path, target, raw exit code, and JSON/HTML/Markdown report paths. The default writer appends one UTF-8 JSON line to `zap-baseline-results.jsonl` in the existing reports directory. CLI exit `0` means transport completed; CLI exit `1` means collection or write failed. Neither describes scanner acceptance. The shell keeps its separately captured scanner status, logs outlet failures, continues through remaining targets, and returns the existing aggregate policy: scanner `0` or `2` leaves the aggregate successful; any other scanner exit or any outlet failure makes the aggregate `1`.

Records are appended in target order, without indexing or deduplicating sanitized labels. Distinct targets can share report paths; an earlier line's path may later be overwritten by the existing scanner naming behavior. Reusing a reports directory appends to the same file and can observe existing reports. No line identifies a canonical target, source, run, attempt or artifact. Docker absence and WARN-checker failure remain real prerequisite failures. The existing upstream `FSUSBLOG_SKIP_ZAP` does not generate an outlet record or a not-applicable receipt.

## Permitted verification

The focused [tests](../../tests/tools/zap-baseline-result-outlet.test.mjs) use synthetic files, injected callbacks and a Node-only CLI. They cover raw fields, missing reports, awaited completion, write errors, original scanner failure preservation and colliding labels. Shell control is inspected as source; the scanner script is never executed.

```bash
bash -n tools/security/run-zap-baseline.sh
node --check tools/security/zap-baseline-result-outlet.mjs
node --check tests/tools/zap-baseline-result-outlet.test.mjs
node --test tests/tools/zap-baseline-result-outlet.test.mjs tests/tools/zap-baseline-contract.test.mjs
git diff --check
```

No Docker/ZAP invocation, authenticated scan, live target, external network, database, identity/reset/race/custody audit, receipt substitution or equivalent authority harness is part of these controls. The catalog chain `security.dast` → `npm run check:security:dast` → existing shell remains an integration responsibility; it is not run by this task. The outlet supplies no vendor JSON schema, canonical IDs, alert qualification, scanner error taxonomy, receipt authority, registry or runner.

The task's four-path scope excludes lifecycle registration and generated documentation indexes. The integration owner must register this document through the existing lifecycle producer before treating it as a maintained source of truth. This explanatory document is not a new security or schema authority.
