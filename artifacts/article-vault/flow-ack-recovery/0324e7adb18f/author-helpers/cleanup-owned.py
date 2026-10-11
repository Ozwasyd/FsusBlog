from pathlib import Path
import json,subprocess,datetime
repo=Path('/workspace/chain1975-runtime-attempt-borrow');out=Path('/workspace/chain-1975-evidence/flow-ack-recovery-20261011');negative=Path('/workspace/chain1975-flow-ack-negative');cache=Path('/workspace/chain1975-intent-source-alias-verification/src/frontend/node_modules');ui=Path('/workspace/chain1975-runtime-borrow-fsusui/vue/packages/node_modules')
previous=[repo/'src/frontend/node_modules',Path('/workspace/chain1975-runtime-borrow-type-baseline/src/frontend/node_modules'),negative/'src/frontend/node_modules'];assert all(not p.is_symlink() and not p.exists() for p in previous)
links=sorted(p for p in ui.rglob('*') if p.is_symlink());assert len(links)==24;rows=[]
for p in links:
 target=p.readlink();assert str(target).startswith(str(cache)+'/') or str(target).startswith(str(repo/'src/frontend/node_modules')+'/');rows.append({'path':str(p),'target':str(target)})
for p in links:p.unlink()
for p in sorted((x for x in ui.rglob('*') if x.is_dir()),key=lambda x:len(x.parts),reverse=True):p.rmdir()
ui.rmdir()
subprocess.run(['git','worktree','remove','--force',str(negative)],cwd=repo,check=True)
tmp=out/'prerequisite-tmp';assert not list(tmp.iterdir());tmp.rmdir()
r={'source':'0324e7adb18f8aecfa870e86dec1153046a9f782','timeUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'previousPartialAttempt':'removed three own application/cache links, then target-prefix assertion refused original helper UI links pointing into the own application; no UI links deleted in that attempt','alreadyAbsentAtRetry':[str(p) for p in previous],'removedOnRetry':rows,'totalOwnLinksNowAbsent':27,'ownNegativeWorktreeRemoved':not negative.exists(),'ownPrerequisiteTempRemoved':not tmp.exists(),'sharedLockedCachePreserved':cache.is_dir(),'ownFsusUiSourcePreserved':True,'allRecordedWorkersExited':True,'qualification':False};(out/'cleanup.json').write_text(json.dumps(r,indent=2)+'\n');print({k:v for k,v in r.items() if k!='removedOnRetry'})
