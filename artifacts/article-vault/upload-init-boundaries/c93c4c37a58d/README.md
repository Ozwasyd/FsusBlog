# Upload init identity boundary repair — ordinary author evidence

Tested source: c93c4c37a58dd66fde473aa885552ea4663d4af3.
Tree: cace8e7371cee25c951a299260b88f0b5c7c52b2.
Branch: codex/chain-1975-runtime-attempt-borrow; existing draft PR #4151.
Fetched master: 9d72a1c93b297f719d8695a642cdfb1615cf1d51.
Qualification=false. This evidence commit changes artifacts only, not the tested source.

The original encoder sends a fixed256-byte UTF-8 filename. The runtime now refuses
names that cannot round-trip without truncation, embedded NUL or surrogate replacement
before init IO, using the actual compressed file. Valid256-byte names retain exact
response correlation and cancellation with the actual original ID/token. The existing
canonical32lowerhex upload-ID predicate now excludes Guid.Empty. No response-name,
geometry, cancellation, unknown-commit, original transport or loan oracle was relaxed.

Four existing paths changed relative to60e46f: runtime, its existing unit tests, the
existing API unit tests, and the current architecture overview. Existing122 test bytes
are exactly preserved by inserting new test blocks; all122 actual names are retained.
Eleven canonical owners/runner/package files are byte-identical. The complete PR still
contains inherited implementations and evidence; this is not a four-file whole-PR audit.

## Original reviewer reproduction

Library libfile_95e98dda465c81918dbdb71b681e706d was materialized by the supported
Library flow. ZIP SHA2563fc6b7419b889c4183762106a276e3fe3ffceb8647c3f5f5f31a3f49809bb15b;
protocol review.json SHA256b91037a1916363c8f4869c0adb20b0ce8577e0417f25dd56752460ce0838a3bf.
The immutable original probe was rerun with only its documented path remap against
13 frozen original inputs using Node24.16.0/TypeScript6.0.3: exit0 reproduced258-byte
name truncation to256 and init/cleanup mismatch, plus zero GUID accepted=true.
This is a pure-source observation, not a full runtime/server or authority fixture.
The first archive-read attempt stopped because it selected the earlier preack
review.json; the subsequent check explicitly selected the hash-matching protocol
review.json. No alternate report was accepted as the requested reviewer report.

Reviewer thread01a1219d-1a8a-7640-be37-1002c0f51014 issued MUST_FIX against8a65.
Its original static name comparison failed on quoting AST undefined. Parent confirms
121 exact names plus that one display discrepancy; no test was missing or renamed.
Reviewer focused/positive/28negative remain UNRUN. These author runs do not upgrade
that independent result. Hand this frozen source and evidence to the same reviewer.

## Current original-runner checks

Every command has UTC start/stop, cwd, HEAD, argv, exit code and run identity where
applicable under records; raw logs are byte-exact gzip. Reports and topology contain
actual original setup hooks, matching start/finish tasks and departed worker PIDs.

| Check | Result |
| --- | --- |
| Original preflight | PASS exit0, actual output and test-plan preserved |
| Original discovery | PASS139 unique names:123 runtime+16 API; original122 retained |
| Complete focused files | PASS139, zero failed/skipped |
| Original two positives | PASS2;121 runtime cases outside selector |
| Original prerequisites | PASS37, zero failures/skips |
| Source style | PASS exit0 |
| New commit range | PASS exit0 |
| Full application types | FAIL exit2 current/baseline;244/244, zero added/removed |
| Whole inherited footer range | FAIL exit1 at old9defbe367 lacking Refs footer |
| Original28 pre-fix controls | Expected exit1:28 failures, identical original names;111 outside selector |
| New17 boundary controls before fix | Expected exit1:8 passed/9 failed;122 outside selector |
| New17 boundary controls after fix | All17 passed within the complete139 run |

The original28 run uses frozen734f8925d41c3d089cc039989292c352e0ee741b product source
and byte-identical current tests, without the old unbounded range loop. The new17
before-fix run uses60e46f evidence HEAD with8a65-identical product source and the same
new test bytes as the frozen fix. It does not impersonate a clean pre-fix test commit.
API wire cases call the original init encoder and inspect its actual256-byte field,
including the exact reviewer258-byte trigger and a split UTF-8 codepoint. Runtime
controls check refusal before IO, valid two/four-byte boundaries, repeated cancellation
using original late-init credentials, actual compressed names, zero-ID init and stored
resume. DTO replies, hashes, PoW/native decoder and intercepted fetch are ordinary unit
fixtures. No real backend/native/image-signature/product qualification is claimed.

Exact commands are in records/*json. Reproduction uses the original Node24.16 binary,
unchanged locked frontend cache and FsusUI source0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2
as recorded in toolchain-provenance.json. The canonical prepare-local-fsusui-install
helper verifies the local source profile; all resolved Vue modules share one physical
locked graph. No aliases, lock/config changes or replacement runner were introduced.
27 own links, the disposable negative worktree and own temporary fixture directory were
removed; locked cache retained. The source commit was an ordinary git commit/push;
hooks were not bypassed. Source remote readback is in source-commit-proof.json.

## Remaining gates and phase barrier

The full16 issue statuses are in issue-status.md. #1975 remains partial: terminal
cutover build/receipt plus full isolated apply/repeat and real backup/restore gates are
PAUSED and not accepted. A destructive contract remains unsupported without real
backup evidence; no production action is authorized. #1976 waits for actual #1975.
The other execution and tracking gates remain open. Server, migration, product,
custody/security/native/browser/held QA were not resumed. No issue closing, sibling
merge, cross-chain conflict resolution, package publication, deployment or final merge.
