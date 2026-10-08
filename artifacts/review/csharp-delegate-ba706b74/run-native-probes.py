import datetime,hashlib,json,pathlib,re,subprocess
root=pathlib.Path.cwd();out=root/'.tmp/csharp-delegate';fixture=pathlib.Path('/tmp/fsusblog-delegate-native-probe-20261008')
plan=[{'label':'native-original-45-current','checker':'.tmp/csharp-delegate/base-checker.mjs','expectedExit':1,'expectedTypeFindings':45}, {'label':'native-candidate-zero-current','checker':'tools/dotnet/check-csharp-style.mjs','expectedExit':0,'expectedTypeFindings':0}, {'label':'native-invalid-names-45-current','checker':'tools/dotnet/check-csharp-style.mjs','expectedExit':1,'expectedTypeFindings':45}]
(out/'positive-native-scope.json').write_text(json.dumps({'expectedInvocations':3,'checks':plan,'purpose':'ordinary lexical native declarations and lowercase negative fixtures only','heldControlsExecuted':False},indent=2)+'\n')
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
for case in plan:
 if case['label']=='native-invalid-names-45-current':
  changed=0
  for file in fixture.glob('src/backend/Infrastructure/Memory/Platform/*.cs'):
   def change(match):
    global changed
    changed+=1;name=match[2];return match[1]+name[0].lower()+name[1:]
   text=re.sub(r'(\bdelegate\s+(?:int|nint|void|ulong|byte)\s+)([A-Za-z_]\w*)',change,file.read_text());file.write_text(text)
  assert changed==45
 cmd=['node',case['checker'],'--root',str(fixture),'--mode','full'];start=datetime.datetime.now(datetime.timezone.utc).isoformat();result=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True)
 log=out/(case['label']+'.log');log.write_text(result.stdout);count=len(re.findall(r' type-name:',result.stdout))
 data={'kind':'actual-ordinary-native-lexical-probe-not-GPU-runtime-acceptance','head':head,'inputGpuCandidate':'ec2187e4cb101257633beb4fda723992d0987b98','argv':cmd,'startedAtUtc':start,'endedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'typeNameFindings':count,'log':log.name,'logSha256':hashlib.sha256(log.read_bytes()).hexdigest(),'productionGpuEdits':False,'heldControlsExecuted':False}
 (out/(case['label']+'.json')).write_text(json.dumps(data,indent=2)+'\n');print(case['label'],result.returncode,count,flush=True)
 assert result.returncode==case['expectedExit'] and count==case['expectedTypeFindings'],result.stdout
