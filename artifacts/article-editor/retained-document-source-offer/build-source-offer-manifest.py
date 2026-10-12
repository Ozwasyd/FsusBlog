import subprocess,json,hashlib,os,sys
from pathlib import Path
if len(sys.argv) != 4:
 raise SystemExit('usage: build-source-offer-manifest.py SOURCE_REPOSITORY CLEAN_MAIN_CHECKOUT COMPOSED_REPLICA')
src,check,composed=(Path(arg).resolve() for arg in sys.argv[1:]);out=Path(__file__).resolve().parent
main='53104fdd7949a02fac7f0ac63bed5b8ca77fa54e';base='a27a5c1922d681d9796a05acdd7f424362f26869';final='17c2e83ea1747baa1ca2f8de366ad7e249b2c23f'
stages=[('01-canonical-group-registry.patch',main,base,['src/frontend/src/services/authoring/authoringWorkspaceRatioOwner.ts','src/frontend/src/services/authoring/authoringTabGroupRegistry.ts','src/frontend/src/services/authoring/openArticleDocumentRegistry.ts','tests/frontend/unit/authoring/authoringTabGroupRegistry.test.ts','tests/frontend/unit/authoring/openArticleDocumentRegistry.test.ts']),('02-retained-document-producer.patch',base,final,['src/frontend/src/services/authoring/openArticleDocumentRegistry.ts','src/frontend/src/services/authoring/articleDocumentContext.ts','tests/frontend/unit/authoring/articleDocumentRetainedAuthority.test.ts','tests/frontend/unit/authoring/retainedArticleDocumentHandle.test.ts','docs/architecture/authoring-workspace-snapshot-boundary.md','artifacts/article-editor/retained-document-authority/preflight.md'])]
def git(*args):return subprocess.check_output(['git',*args],cwd=src)
def data(rev,path):return git('show',f'{rev}:{path}')
def identity(bytes):return {'gitBlob':hashlib.sha1(f'blob {len(bytes)}\0'.encode()+bytes).hexdigest(),'sha256':hashlib.sha256(bytes).hexdigest(),'bytes':len(bytes),'mode':'100644'}
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=check).decode().strip()==main
subprocess.run(['git','diff','--exit-code',main],cwd=check,check=True,stdout=subprocess.DEVNULL)
assert not subprocess.check_output(['git','ls-files','--others','--exclude-standard'],cwd=check).strip(), 'checkout must have no untracked source'
rows=[];allowed=set()
for order,(patch,b,a,paths) in enumerate(stages,1):
 before={p:identity((check/p).read_bytes()) if (check/p).exists() else None for p in paths}
 command=['git','-C',str(check),'apply','--check',str(out/patch)];subprocess.run(command,check=True)
 subprocess.run(['git','-C',str(check),'apply',str(out/patch)],check=True)
 entries=[]
 for p in paths:
  post=(check/p).read_bytes();donor=data(a,p)
  if p.startswith('docs/'):
   old=data(main,p);assert old.split(b'\n',2)[2] in post
  else:assert post==donor,(order,p)
  entries.append({'path':p,'before':before[p],'after':identity(post),'donorRevision':a,'donorBlob':identity(donor)['gitBlob'],'composition':'producer prefix plus exact complete Main remainder' if p.startswith('docs/') else 'exact authentic donor postimage'})
  allowed.add(p)
 rows.append({'order':order,'patch':patch,'patchSha256':identity((out/patch).read_bytes())['sha256'],'applyCheckCommand':command,'applyCheckExit':0,'applyExit':0,'paths':entries})
# Independent earlier replica must have the exact same offer result.
for p in allowed:assert (check/p).read_bytes()==(composed/p).read_bytes(),p
items=git('ls-tree','-r','-z',main).split(b'\0');mismatch=[];checked=0
for item in items:
 if not item:continue
 meta,p=item.split(b'\t',1);mode,kind,digest=meta.decode().split();p=p.decode()
 if p in allowed or kind!='blob':continue
 path=check/p
 if not path.exists():mismatch.append({'path':p,'reason':'missing'});continue
 observed=os.readlink(path).encode() if mode=='120000' else path.read_bytes()
 if identity(observed)['gitBlob']!=digest:mismatch.append({'path':p,'reason':'blob mismatch'})
 checked+=1
assert not mismatch,mismatch
protected=['src/frontend/src/api/authoringWorkspaceSnapshot.ts','src/frontend/src/services/articleRecoveryJournal.ts','src/frontend/src/composables/useAdminArticleWrite.ts','src/frontend/src/services/authoring/articleRenderCache.ts','src/frontend/src/services/authoring/index.ts']
r={'schema':'fsusblog.retained-document-source-offer.v1','consumerRevision':main,'commonAncestor':'039fd1288c816eecc6d657be0d61c5bc10a76402','canonicalBase':base,'producerRevision':final,'qualification':False,'generator':{'path':Path(__file__).name,'sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'command':['python3',str(Path(__file__).resolve()),str(src),str(check),str(composed)]},'stages':rows,'protectedConsumerTrackedBlobsChecked':checked,'protectedMismatches':mismatch,'protectedImportantPostimages':{p:identity((check/p).read_bytes()) for p in protected},'independentReplicaByteEqual':True,'noBranchMerge':True,'noMainBranchWrite':True,'noSnapshotPostimage':True,'holds':'all runtime/test/list/discovery/native/browser/mount/security/receipt/race/DB/storage qualification UNRUN'}
(out/'source-offer.json').write_text(json.dumps(r,indent=2)+'\n');print('offer paths',len(allowed),'protected consumer blobs',checked,'mismatches',len(mismatch))
