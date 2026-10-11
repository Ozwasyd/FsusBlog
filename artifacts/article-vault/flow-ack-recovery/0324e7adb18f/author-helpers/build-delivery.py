from pathlib import Path
import json,gzip,hashlib,subprocess,shutil
repo=Path('/workspace/chain1975-runtime-attempt-borrow');scratch=Path('/workspace/chain-1975-evidence/flow-ack-recovery-20261011');source='0324e7adb18f8aecfa870e86dec1153046a9f782';before='22813e9b81db72a0d01b1a0752551a1f96ab9c89';base=repo/'artifacts/article-vault/flow-ack-recovery/0324e7adb18f';assert not base.exists();base.mkdir(parents=True)
def put(path,data):
 target=base/path;target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(data)
def gz(path,data):put(path,gzip.compress(data,mtime=0))
for p in sorted(scratch.iterdir()):
 if p.is_file():
  if p.suffix=='.json':put('records/'+p.name,p.read_bytes())
  elif p.suffix=='.log':gz('logs/'+p.name+'.gz',p.read_bytes())
  elif p.suffix in ['.py','.sh','.cjs']:put('author-helpers/'+p.name,p.read_bytes())
  elif p.name in ['original-nine.txt','added-five.txt']:gz('controls/'+p.name+'.gz',p.read_bytes())
  elif p.name=='source-remote-readback.txt':put('records/'+p.name,p.read_bytes())
for p in sorted(scratch.glob('*-run/topology.jsonl')):put(p.parent.name+'/topology.jsonl',p.read_bytes())
for p in ['.tmp/gate-logs/preflight.json','.tmp/release-evidence/test-plan.json']:
 put('preflight-produced/'+Path(p).name,(repo/p).read_bytes())
paths=json.loads((scratch/'source-binding.json').read_text())['sourceOnlyChangedPaths']
for tag,rev in [('pre',before),('post',source)]:
 for p in paths:gz('source-images/'+tag+'/'+p+'.gz',subprocess.check_output(['git','show',rev+':'+p],cwd=repo))
patch=subprocess.check_output(['git','diff','--binary',before,source,'--',*paths],cwd=repo);gz('source-images/four-path.patch.gz',patch);check=subprocess.run(['git','apply','--reverse','--check'],input=patch,cwd=repo,capture_output=True);assert check.returncode==0;put('source-images/patch-proof.json',json.dumps({'source':source,'before':before,'reverseCheckExit':0,'qualification':False},indent=2).encode()+b'\n')
prior=repo/'artifacts/article-vault/upload-init-boundaries/c93c4c37a58d';hist=['records/prefix-negative.json','records/prefix-report.json','records/prefix-boundaries.json','prefix-boundaries/report.json','prefix-boundaries/topology.jsonl'];refs=[]
for p in hist:
 b=(prior/p).read_bytes();target='preserved-history/'+p;put(target,b);refs.append({'originalCommit':'0c1576c37d75e69e2b6425e245fd3f47eee25367','originalPath':str((prior/p).relative_to(repo)),'copiedTo':target,'sha256':hashlib.sha256(b).hexdigest(),'bytes':len(b),'rerunInThisStage':False})
put('records/preserved-history-binding.json',json.dumps({'receipts':refs,'qualification':False},indent=2).encode()+b'\n')
readme=f'''# Original Flow complete-ACK consumer recovery — author delivery

Frozen source `{source}`, tree `168b91f10b5713fdc11d723b4b058b4630e07eb8`.
Previous published head `{before}`; verified origin/master at start
`9d72a1c93b297f719d8695a642cdfb1615cf1d51`. Branch
`codex/chain-1975-runtime-attempt-borrow`; existing draft PR #4151 targets master.
This is author ordinary-module evidence, `qualification=false`. New independent
review remains pending with the same original reviewer. No whole-chain acceptance.

Only four existing paths changed: original runtime, original Flow, existing
runtime unit tests, and current architecture overview. The parent approved only
`onSessionReady?: (borrow: ImageUploadSessionBorrow, completionUrl: string) => void | Promise<void>`.
Runtime supplies the immutable original strictly validated actual complete ACK URL;
callers cannot supply it. Old one-parameter consumers and fulfilled void/batch
success remain compatible. Flow awaits the original `onFileUploaded` in that original
callback and existing finite `withSession` scope. The existing runtime catch retains
the actual ACK/snapshot/first error, operation generation/upload ID and original
binding identities before final loan release; the Flow retains its original
File/context. No new loan, global receipt, ledger, verified business flag, new token
persistence, physical cleanup, DI or transport activation was added.

Consumer failure, cancel/intent cancellation/disposal/abandon, late resolution,
deadline, reentrancy and document owner replacement retain the original obligation
and refuse overwrite/reupload/recomplete. ACK-following abort/init/complete IO
remains absent in the controlled failure paths. Noncooperative physically pending
consumers retain a pending execution and finite access revocation; no timer is a
business release or physical termination ACK. A fulfilled void callback is not
canonical business acceptance. The real canonical recovery receiver/current
business receipt is absent. PR #4170 IsSuccess/Recorded is not browser receiver
release or physical delete. Writer #4153, cleanup business #4170 and Shared #4155
were untouched by this four-path delta.

## Actual executions

| Run | Result and exact limits |
| --- | --- |
| `prefix-correct-setup` at previous product source | Original nine unchanged cases actually 9 FAIL / 0 PASS; 124 runtime cases outside selector; exit 1; real 9 start/finish pairs. |
| `prefix-five-proven` at previous product source | New five cases 4 FAIL / 1 PASS; 133 runtime cases outside selector; exit 1; existing observer error path was already passing. Only tests differ from that product commit. |
| `focused-proven` at frozen source | 154 PASS: runtime138/API16; 0 FAIL/0 SKIP; 154 exact discovery identities, 154 matched real setup start/finish pairs; workers exited. |
| `nine-after` at frozen source | Same original nine 9 PASS / 0 FAIL; 129 outside selector; exit 0; also present in complete proven run. |
| `positive-proven` at frozen source | Both original positives PASS, 136 outside selector; actual 2 hook pairs; workers exited. |
| `prerequisites` at frozen source | Original 37 Node controls PASS, exit 0, zero fail/skip. |
| `preflight`, `style`, `current-range` at frozen source | PASS / exit 0. |
| Full application types vs original baseline04195 | Both exit 2; 244/244 full normalized multiline diagnostics, 0 added/removed. Full types remain FAIL. |
| Whole history from baseline04195 | FAIL / exit 1: old `9defbe367fc3ce869eef7a41aa29d9be3d1d5c37` lacks Refs footer. New-range PASS does not waive it. |

`records/current-runs.json` binds these results to source and run identity.
Every command/cwd/start/stop/exit/head is in its corresponding JSON record; raw
logs are lossless gzip in `logs/`. `records/discovery-roster.json` is the original
Vitest list output. `records/test-retention-proof.json` proves the original140
runtime/API cases remain byte-identical after removing only inserted blocks,
including the original139; the original nine archived block is byte-identical,
SHA256 `692dffe3770e3998dfbc6a5bd52bc84a22f86d775a318dca09414afaa645d83e`.

Immutable old28-before (28 FAIL at734f8925) and old17-before (8 PASS/9 FAIL at60e46f)
are copied verbatim with original source bindings under `preserved-history/`.
They were not rerun in this stage. All45 remain unchanged and PASS in current154.
Prior independent PASS at c93c4c37 with 139 ordinary tests is historical only;
it does not approve this new fix. No independent result has been fabricated.

Failure/setup history is preserved: `prefix-nine` had a wrong relative setup path
and was not admissible probe execution. The corrected setup actually reproduced
nine failures. Exploratory149 passed; exploratory-extra had153PASS/1FAIL because a
new test expected an empty replacement source although the real fixture starts
with paragraph. Only that new assertion was corrected to compare the actual
preexisting replacement source. Initial frozen focused/positive/nine-after passed
but lacked topology env; focused-proven/positive-proven reruns supplied actual
hooks. No missing topology was invented. Cleanup attempts and final resource
absence are recorded accurately in `records/cleanup.json`.

## Reproduction inputs and commands

Use official Node24.16.0, locked Vitest4.1.11/TypeScript6.0.3/Vue3.5.33/HappyDOM20.9,
and genuine local FsusUI source0e5c56050e8dd3e9ca3735078489d35a0bb6e3d2.
`records/toolchain-provenance.json` proves application/FsusUI Vue subpackages
resolve to the same physical graph. `records/locked-inputs.json` binds identical
package/lock bytes in current, locked cache checkout and original baseline.
No package, lock, FsusUI source, runner, setup, alias or governance code changed.
Own node_modules links were disposable setup only and are now removed.

Run `node tools/run-test-matrix.mjs preflight` at repository root first.
From `src/frontend`, run original `node node_modules/vitest/vitest.mjs list
--config vitest.config.ts ../../tests/frontend/unit/composables/useImageUploadRuntime.test.ts
../../tests/frontend/unit/api/upload.test.ts --json=<fresh roster>` and original
`vitest.mjs run` with these same paths and JSON reporter. Set
`FSUSBLOG_USE_LOCAL_FSUSUI=1`, `FSUSBLOG_LOCAL_FSUSUI_ROOT=<genuine SDK>`,
`FSUSBLOG_VITEST_MAX_WORKERS=1`, a fresh `FSUSBLOG_RUN_ID`, and
`FSUSBLOG_VITEST_RUNTIME_TOPOLOGY_EVIDENCE=<fresh topology.jsonl>`.
Exact argument arrays/selectors for all runs are in `records/` and the scoped
helper in `author-helpers/run-current.sh`. Selectors are strict, never fall back
to all tests. Full focused execution has zero skips; outside-selector cases are
reported separately for targeted controls.

Original style command checks runtime/Flow/API; type commands use
`node src/frontend/scripts/run-local-fsusui-typecheck.mjs --application`.
Prerequisite command runs original execution-envelope-policy,
local-production-profile-resources, matrix-fixture-profile and
linux-cgroup-membership-locator Node tests with own TMPDIR. Preflight's actual
current producer outputs are archived; no runtime/product receipt was generated.

Source pre/post blobs and byte hashes are in `records/source-binding.json` and
lossless `source-images/`; exact four-path patch passes reverse-check against
frozen source. Existing source owners and APIs outside these paths are unchanged.
The artifact manifest binds all files by bytes/SHA256; the later artifact commit
contains evidence only. 27 own links, own negative worktree and own node-test temp
were removed, recorded workers exited and shared locked cache is preserved.

Rollback of this source change is a normal revert of `{source}` if independent
review or actual integration exposes a regression; it grants no cleanup/release
or reupload authority. No source on master was modified.

All16 assigned execution/tracking states remain OPEN; see `issue-status.md`.
#1975 terminal cutover/build/receipt/isolated apply/repeat/real backup+restore and
#1976 seal remain unaccepted and paused. No production DB action is authorized;
without real backup evidence destructive contract remains unsupported.
Held server/native/browser/product/receipt/custody/security/cohort/race/migration
and QA gates remain PAUSED/UNRUN. No merge, issue close, package publish,
deployment, cross-chain conflict resolution or final global-barrier review occurs.
'''
put('README.md',readme.encode())
status='''# Entire ownership remains OPEN

Current author ordinary source0324e7adb18f8aecfa870e86dec1153046a9f782:
154PASS(runtime138/API16), original2 positive and37 prerequisite PASS. Original
140/139 and nine unchanged; all45 original protocol/boundary controls PASS.
This implements original Flow consumer failure -> original local ACK recovery,
not canonical business receive/release. Independent current review is pending
with original reviewer01a1219d-1a8a-7640-be37-1002c0f51014. Prior c93 independent
PASS stays tied to its original source. Full types244/244 and old Refs footer fail.

| Issue | Status | Precise remaining gate |
| --- | --- | --- |
| #1975 | Partial, terminal qualification PAUSED | Actual terminal cutover build/receipt and complete isolated destructive apply/repeat/real backup+restore acceptance. Existing backup refusal/isolated proof is not complete cutover. No production action authorized. |
| #1976 | Waiting | Cannot run terminal seal until actual #1975 acceptance. |
| #1779 | Tracking only | Actual #1975/#1976/#1761 evidence aggregation; no independent implementation or closure. |
| #1780 | Partial | Public binary source/probes; Windows/security/performance qualification remains open. |
| #2074 | Partial | AOT authority/semantic source proof; full runtime qualification remains open. |
| #2075 | Waiting | Complete qualified anonymous acceptance matrix remains missing. |
| #2076 | Blocked | Sole owner's canonical403/claim/single-consume decision versus old404/DataProtection; no guessed sibling work. |
| #2077 | Partial | Isolated PostgreSQL/native proof; gateway/platform/crash/cross-process/cross-volume/promotion-ledger faults and prerequisites remain open. |
| #2078 | Waiting | Actual qualified #2074–#2077; ordinary cleanup controls do not replace them. |
| #2079 | Partial | Aggregate/selector authority source; terminal qualification remains open. |
| #2080 | Waiting | Actual terminal security/resurrection acceptance remains missing. |
| #1784 | Tracking only | Aggregate actual child execution evidence and outstanding gates; no closure. |
| #2258 | Partial | Prior provider61/current ordinary runtime138/API16 source controls; actual Writer composition/HTTP owner/rights/reuse/reference/browser/receipt gates remain open. |
| #2263 | Partial | Original responsibility/saved-draft/cleanup/intent proofs plus current local ACK consumer recovery. Canonical receiver/current business receipt and actual host #2256/#2261/#2246 product integration remain missing. |
| #2265 | Waiting | All qualified replacement consumers required before legacy deletion; no legacy deletion authorized/performed here. |
| #1810 | Tracking only | Actual #2256/#2261/#1907/product acceptance remains missing; do not close. |

Closed #1970–#1974 status alone is not runtime acceptance. Current original API
and genuine local SDK tests do not qualify native/browser/runtime product gates.
#4170 IsSuccess/Recorded is not browser receive/release or physical delete.
No Writer/#4153, cleanup-business/#4170 or Shared/#4155 source was changed.

Smallest next actions: parent dispatches frozen source and this evidence to the
same original reviewer; canonical UI/Writer/receiver owners supply their actual
interfaces and current business receipt; separate explicit authorization and
prerequisite evidence resume held terminal acceptance. No external prerequisite
commit has been guessed, consumed or merged. No global phase-barrier crossing.
'''
put('issue-status.md',status.encode())
handoff={'recipientThread':'01a1219d-1a8a-7640-be37-1002c0f51014','coordinatingParentThread':'01a1142b-a0b5-7419-a4df-a8bbe54660dd','source':source,'tree':'168b91f10b5713fdc11d723b4b058b4630e07eb8','branch':'codex/chain-1975-runtime-attempt-borrow','draftPr':'https://github.com/Ozwasyd/FsusBlog/pull/4151','artifactPath':str(base.relative_to(repo)),'approvedInterface':'onSessionReady?: (borrow: ImageUploadSessionBorrow, completionUrl: string) => void | Promise<void>','reviewScope':'original runtime/Flow completion consumer local recovery boundary only; no canonical receiving/release or held qualification','request':'same original reviewer independently reproduces unchanged nine pre-fix failures and current154, original2/37, new5 negatives, strict discovery/hooks, original140/139 byte retention, old28/17 immutable history and all45 current controls; verify original ACK/binding ownership before loan release, no ACK-following abort/reinit/recomplete, finite revocation and physically pending limitation','authorOrdinaryStatus':'PASS bounded checks; full types and old inherited footer FAIL','reviewStatus':'PENDING; original reviewer not substituted','dispatch':'prepared for parent handoff; this environment has no callable cross-thread dispatch tool; no claimed delivery','qualification':False,'wholeChainAccepted':False};put('reviewer-handoff.json',json.dumps(handoff,indent=2).encode()+b'\n')
entries=[]
for p in sorted(base.rglob('*')):
 if p.is_file():b=p.read_bytes();entries.append({'path':str(p.relative_to(base)),'bytes':len(b),'sha256':hashlib.sha256(b).hexdigest()})
manifest={'source':source,'tree':'168b91f10b5713fdc11d723b4b058b4630e07eb8','qualification':False,'files':entries};put('manifest.json',json.dumps(manifest,indent=2).encode()+b'\n');print(json.dumps({'artifact':str(base.relative_to(repo)),'manifestEntries':len(entries),'totalFiles':len(entries)+1}))
