from pathlib import Path
import json,shutil,gzip,hashlib,subprocess,datetime,os
r=Path('/workspace/chain1975-runtime-attempt-borrow');p=Path('/workspace/chain-1975-evidence/completion-only-loan-20261010');sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=r,text=True).strip();assert sha=='b8723dc2baedef4c6adccbdd7cc88cae38494176'
assert (p/'source-remote-proof.log').read_text().split()[0]==sha
assert json.loads((p/'mandatory-preflight.json').read_text())['exitCode']==0
old=Path('artifacts/article-vault/runtime-review-repair/9461d18fb5fd')
issue=(r/old/'issue-status.md').read_text().replace('runtime36/positive2/prerequisite37 at9461d18fb5fd010ad69c14ca76fc1ddee4ac4a18','runtime41/positive2/prerequisite37 at'+sha).replace('current runtime36','current runtime41').replace('current scoped runtime repair','current finite completion-only runtime repair')
issue=issue.replace('The current public editor File-association gap is explicit in consumer-api.md.','The public editor File bridge and canonical zero-dispatch pending admission remain with their assigned owners; this runtime repair does not implement either.')
issue=issue.replace('independent reviewer using locked Node24.16 and original gates','new independent reviewer in thread01a1219d using locked Node24.16 and original gates against'+sha)
(p/'issue-status.md').write_text(issue)
readme=(p/'handoff-template.md').read_text();readme+='\nTested source: `'+sha+'`. Published branch: `codex/chain-1975-runtime-attempt-borrow`.\nLatest fetched origin/master: `9d72a1c93b297f719d8695a642cdfb1615cf1d51`.\n\n| Actual final check | Result |\n| --- | --- |\n| Official Node24.16 mandatory preflight | PASS exit0, current clean source |\n| Exact discovery | 41 real cases, exact positive selector2 |\n| Original positive selection | PASS2;39 outside selector |\n| Original focused file | PASS41, failed0/skip0;41 matching starts/finishes; workers gone |\n| Original ordinary prerequisite controls | PASS37, failed/skipped/cancelled/todo0 |\n| Original11 complete calls and hooks | Byte-identical to04195, TypeScript6.0.3 AST |\n| Two original composable source-style checks | PASS0 violations |\n| Full application types | FAIL exit2, baseline244/current244, added0/removed0 |\n| New commit range8351..b872 | PASS |\n| Whole published history04195..b872 | FAIL1, old9def missing Refs footer, no rewrite |\n\nRaw commands, exits, source/run identities, reports and topology are included.\n`tested-a6fad0a/` preserves the earlier tested40 source and its exact receipts;\n`intermediate-preflight*` is not current clean-candidate acceptance.\nPrior rejected9461 lifetime semantics, its35P/1F failed run and subsequent2/36/37\nresults remain in [the immutable historical artifact](../../runtime-review-repair/9461d18fb5fd/README.md).\nAll 16 accepted issues remain OPEN; see [issue-status.md](issue-status.md).\n'
(p/'README.md').write_text(readme)
# Task-scoped teardown, only links recorded as created by this session.
links=json.loads((p/'created-ui-links.json').read_text());removed=[]
for row in links:
 q=Path(row['link']);assert q.is_symlink() and str(q.readlink())==row['target'];q.unlink();removed.append(str(q))
root=Path('/workspace/chain1975-runtime-borrow-fsusui/vue/packages/node_modules')
for q in sorted([x for x in root.rglob('*') if x.is_dir()],key=lambda x:len(x.parts),reverse=True):q.rmdir()
root.rmdir()
for prefix in [r,Path('/workspace/chain1975-runtime-borrow-type-baseline')]:
 q=prefix/'src/frontend/node_modules';assert q.is_symlink() and q.resolve()==Path('/workspace/chain1975-intent-source-alias-verification/src/frontend/node_modules');q.unlink();removed.append(str(q))
temp=p/'prerequisite-temp';assert temp.parent==p
if temp.exists():shutil.rmtree(temp)
(p/'teardown.json').write_text(json.dumps({'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'removedOwnLinks':removed,'createdUiLinksRemoved':len(links),'ownTempRemoved':not temp.exists(),'lockedCacheRetained':True,'qualification':False},indent=2)+'\n')
shutil.copyfile(r/'.tmp/gate-logs/preflight.json',p/'original-preflight-product.json')
# Keep all ordinary evidence and scripts, with raw logs losslessly compressed.
out=r/'artifacts/article-vault/completion-only-loan'/sha[:12];assert not out.exists();out.mkdir(parents=True)
for q in p.rglob('*'):
 if not q.is_file() or q.name=='handoff-template.md':continue
 rel=q.relative_to(p);target=out/rel;target.parent.mkdir(parents=True,exist_ok=True)
 if q.suffix=='.log':target=target.with_suffix('.log.gz');target.write_bytes(gzip.compress(q.read_bytes(),mtime=0))
 else:shutil.copyfile(q,target)
rows=[{'path':str(q.relative_to(out)),'sha256':hashlib.sha256(q.read_bytes()).hexdigest(),'bytes':q.stat().st_size} for q in sorted(out.rglob('*')) if q.is_file()]
(out/'manifest.json').write_text(json.dumps({'testedSource':sha,'qualification':False,'files':rows},indent=2)+'\n')
print(out,'manifest files',len(rows))
