import sys,subprocess,datetime,time,json,hashlib,os,gzip
from pathlib import Path
root=Path(__file__).parent
key=sys.argv[1];cmd=sys.argv[2:];sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();start=datetime.datetime.now(datetime.timezone.utc).isoformat();t=time.monotonic()
with (root/(key+'.log')).open('wb') as f:
 p=subprocess.Popen(cmd,stdout=f,stderr=subprocess.STDOUT);code=p.wait(timeout=600)
b=(root/(key+'.log')).read_bytes();(root/(key+'.log.gz')).write_bytes(gzip.compress(b,mtime=0))
record={'key':key,'sourceCommit':sha,'cwd':os.getcwd(),'command':cmd,'startedUtc':start,'completedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsedSeconds':round(time.monotonic()-t,3),'exitCode':code,'pid':p.pid,'logSha256':hashlib.sha256(b).hexdigest(),'logBytes':len(b),'rawLogArchive':key+'.log.gz','qualification':False}
(root/(key+'.json')).write_text(json.dumps(record,indent=2)+'\n');print(json.dumps(record));print(b.decode(errors='replace')[-3500:]);raise SystemExit(code)
