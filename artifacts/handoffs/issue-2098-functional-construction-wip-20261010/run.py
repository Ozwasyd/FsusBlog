import subprocess,sys,time,json,hashlib
from pathlib import Path
out=Path('/workspace/chain-1895-origin-export-successor/evidence');name=sys.argv[1];cwd='/workspace/chain-1895-origin-export-successor/FsusBlog';args=sys.argv[2:];start=time.time();log=out/(name+'.log')
def git(root,*args):return subprocess.check_output(['git',*args],cwd=root,text=True).strip()
def identity(root):return {'commit':git(root,'rev-parse','HEAD'),'tree':git(root,'rev-parse','HEAD^{tree}'),'status':git(root,'status','--porcelain'),'diffDigest':hashlib.sha256(git(root,'diff','HEAD','--binary').encode()).hexdigest()}
before={'blog':identity(cwd),'ui':identity('/workspace/chain-1895-component-prop-source/FsusUI')}
with log.open('w') as f:r=subprocess.run(args,cwd=cwd,stdout=f,stderr=subprocess.STDOUT)
after={'blog':identity(cwd),'ui':identity('/workspace/chain-1895-component-prop-source/FsusUI')}
record={'command':args,'cwd':cwd,'exitCode':r.returncode,'startedAtEpoch':start,'durationSeconds':time.time()-start,'source':before,'sourceAfter':after,'sourceUnchanged':before==after,'qualificationEligible':False,'log':str(log),'logSha256':hashlib.sha256(log.read_bytes()).hexdigest()}
(out/(name+'.result.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));print('\n'.join(log.read_text().splitlines()[-10:]));sys.exit(r.returncode)
