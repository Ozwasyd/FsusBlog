import subprocess,sys,datetime,json,os
from pathlib import Path
out=Path('/workspace/chain-1975-evidence/preack-abort-binding-20261010')
label=sys.argv[1]; args=sys.argv[2:]
record={'label':label,'command':args,'cwd':os.getcwd(),'startUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'head':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'runId':os.environ.get('FSUSBLOG_RUN_ID'),'qualification':False}
with (out/(label+'.log')).open('w') as log:
 p=subprocess.run(args,stdout=log,stderr=subprocess.STDOUT)
record.update(exitCode=p.returncode,stopUtc=datetime.datetime.now(datetime.timezone.utc).isoformat())
(out/(label+'.json')).write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps(record))
sys.exit(p.returncode)
