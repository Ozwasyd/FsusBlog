import datetime,hashlib,json,pathlib,subprocess,sys
root=pathlib.Path.cwd();out=root/'.tmp/csharp-delegate'
label,*cmd=sys.argv[1:];head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/(label+'.log')).open('w') as log:r=subprocess.run(cmd,cwd=root,stdout=log,stderr=subprocess.STDOUT)
endhead=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
x={'kind':'actual-command-observation-not-qualification-receipt','headBefore':head,'headAfter':endhead,'argv':cmd,'startedAtUtc':start,'endedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':r.returncode,'log':label+'.log','logSha256':hashlib.sha256((out/(label+'.log')).read_bytes()).hexdigest()}
(out/(label+'.json')).write_text(json.dumps(x,indent=2)+'\n');print(label,r.returncode,head,endhead,flush=True);sys.exit(r.returncode)
