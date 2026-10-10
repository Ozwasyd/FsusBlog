from pathlib import Path
import json,hashlib,shutil,subprocess,datetime,gzip
r=Path('/workspace/chain1975-runtime-attempt-borrow');p=Path('/workspace/chain-1975-evidence/post-ack-local-reset-20261010');sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=r,text=True).strip();assert sha=='01636576e8f92151b2a1a1e429bae6dd2b860f05';assert (p/'source-remote-proof.log').read_text().split()[0]==sha
assert subprocess.check_output(['git','status','--porcelain'],cwd=r,text=True)==''
assert set(subprocess.check_output(['git','diff','8097ef44da01235c9305e2ecc1418f46c6c62925..HEAD','--name-only'],cwd=r,text=True).splitlines())=={'src/frontend/src/composables/useImageUploadRuntime.ts','tests/frontend/unit/composables/useImageUploadRuntime.test.ts','docs/architecture/overview.md'}
status=(r/'artifacts/article-vault/completion-only-loan/b8723dc2baed/issue-status.md').read_text().replace('runtime41','runtime45').replace('b8723dc2baedef4c6adccbdd7cc88cae38494176',sha).replace('current finite completion-only runtime repair','current finite loan and post-ACK local recovery repair')
(p/'issue-status.md').write_text(status)
# Inspect and remove only task-created links. Preserve the real locked cache.
links=json.loads((p/'created-ui-links.json').read_text());removed=[]
for row in links:
 q=Path(row['link']);assert q.is_symlink() and str(q.readlink())==row['target'];q.unlink();removed.append(str(q))
root=Path('/workspace/chain1975-runtime-borrow-fsusui/vue/packages/node_modules')
for q in sorted([x for x in root.rglob('*') if x.is_dir()],key=lambda x:len(x.parts),reverse=True):q.rmdir()
root.rmdir()
for prefix in [r,Path('/workspace/chain1975-runtime-borrow-type-baseline')]:
 q=prefix/'src/frontend/node_modules';assert q.is_symlink() and q.resolve()==Path('/workspace/chain1975-intent-source-alias-verification/src/frontend/node_modules');q.unlink();removed.append(str(q))
temp=p/'prerequisite-temp'
if temp.exists():shutil.rmtree(temp)
(p/'teardown.json').write_text(json.dumps({'utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'removedOwnLinks':removed,'createdUiLinksRemoved':len(links),'ownTempRemoved':not temp.exists(),'lockedCacheRetained':True,'qualification':False},indent=2)+'\n')
shutil.copyfile(r/'.tmp/gate-logs/preflight.json',p/'original-preflight-product.json')
out=r/'artifacts/article-vault/post-ack-local-reset'/sha[:12];assert not out.exists();out.mkdir(parents=True)
for q in p.rglob('*'):
 if not q.is_file():continue
 rel=q.relative_to(p);target=out/rel;target.parent.mkdir(parents=True,exist_ok=True)
 if q.suffix=='.log' or rel.parts[0] in ['preimages','postimages']:
  target=Path(str(target)+'.gz');target.write_bytes(gzip.compress(q.read_bytes(),mtime=0))
 else:shutil.copyfile(q,target)
rows=[{'path':str(q.relative_to(out)),'sha256':hashlib.sha256(q.read_bytes()).hexdigest(),'bytes':q.stat().st_size} for q in sorted(out.rglob('*')) if q.is_file()]
(out/'manifest.json').write_text(json.dumps({'testedSource':sha,'testedTree':'548d0b629ad613b7b023378fcf3c5765dd5835a6','qualification':False,'files':rows},indent=2)+'\n')
print(out,'manifest files',len(rows))
