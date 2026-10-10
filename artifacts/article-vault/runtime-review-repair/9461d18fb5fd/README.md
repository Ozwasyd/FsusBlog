# Runtime access repair — ordinary source verification

Tested and remotely verified source: `9461d18fb5fd010ad69c14ca76fc1ddee4ac4a18`.
Branch: `codex/chain-1975-runtime-attempt-borrow`. The session fetched and verified
origin/master `9d72a1c93b297f719d8695a642cdfb1615cf1d51`; the isolated worktree
started at `6f6312e42fa41acb294f871689eaa42f7e92d442`. No master or Writer overlay.

Each `withSession` invocation now owns an immediately revocable access scope and
signal. Raw upload failure releases its loan. Released loans cannot be reminted
while the original attempt runs. The completion window starts after the original
successful acknowledgement. The existing flow can consume each file before
starting the next, preserving original File/created/pending-handle identities
through its canonical owner, with a per-call callback that does not affect a
later ordinary upload entry. See [consumer-api.md](consumer-api.md) for exact
signatures and the unresolved public editor File-association boundary.

| Actual current check | Result |
| --- | --- |
| Official Node24.16.0, `node tools/run-test-matrix.mjs preflight` | PASS, exit0; stopped2026-10-10T06:20:57.977500Z, no stuck process |
| Original focused-file discovery | PASS36; original26 names retained,10 new controls; nonempty exact selector |
| Original compression/hash positive plus private-facts positive | PASS2;34 outside the explicit selector |
| Focused `useImageUploadRuntime.test.ts` | PASS36,0 failed/skip;36 starts/finishes; workers gone |
| Original ordinary prerequisite Node controls | PASS37,0 failed/skipped/cancelled/todo |
| Original11 complete test calls and all original hooks | Byte-identical to04195 under actual TypeScript6.0.3 AST |
| Original two-file source style/typed ESLint, official Node PATH and own FsUSUI0e5 | PASS,0 violations |
| Full application types, own0e5 baseline/current serial verification | FAIL, both exit2 and244 diagnostics; added0/removed0 |
| This session's four source commits, original change-contract checker | PASS |
| Whole published history from04195, same checker | FAIL1: old9defbe3 missing a separate Refs footer; published history preserved |

Commands, exact heads/run IDs/timestamps/exits, original reports and topology
are in the corresponding JSON/log files and `delivery-current-runs.json`.
`failure-history.json` preserves the failed35P/1F batch run and actual setup/style/
publication failures. The new batch control retains both31-second chunk waits,
awaited consumer gating, identical file names, genuine upstream dispatch and
exact handle identity; it also checks a later ordinary call. Failures were not
silently converted into acceptance or removed.

These are ordinary HappyDOM unit controls with the original locale/global/AEDS/
compression/hash/API mocks intact, using the real FsusUI source editor and real
authoring/registry owners. Source aliases use actual FsUSUI0e5 and its existing
built assets; no new native/browser product qualification was run. They do not
prove live HTTP, PoW/crypto/compression, rights/reference contributions, browser
UX, migration, backup/restore, receipt/custody/cohort/race/security or terminal
cutover. Independent reviewer discovery/positives/focused/prerequisites/runtime
probes remain UNRUN after its earlier Node24.19-vs24.16 preflight refusal.

Writer was read at the parent-supplied78d branch, with the expecteda14 blob;
its canonical owner files match this source. Local Writer remains blob
`e18a5c976d7bcee4a116bfe9505a725d5b251f9d`. No Writer edit, PR/content/issue write,
merge, closing action, package publish, deployment or production database action.
All terminal chain gates remain open; [issue-status.md](issue-status.md) records
the entire accepted ownership. Revert this source integration on a current
regression before downstream adoption; that is not database rollback or an
acknowledgement of uncertain upload cleanup.
