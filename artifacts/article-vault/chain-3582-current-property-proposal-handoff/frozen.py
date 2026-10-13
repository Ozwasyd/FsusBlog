from pathlib import Path
import subprocess,json,datetime,hashlib,xml.etree.ElementTree as ET,sys
root=Path('/workspace/FsusBlog');out=root/'.tmp/chain-3582-expanded/current-property-proposal';frozen=out/'frozen';frozen.mkdir(exist_ok=True)
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
paths=subprocess.check_output(['git','diff','--name-only','8cbc620d8ddf5cc11cc23cd8d15c01b9454f4c25',sha],text=True).splitlines(); hashes=lambda:{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
d={'source':sha,'baseline':'8cbc620d8ddf5cc11cc23cd8d15c01b9454f4c25','fetchedMaster':'537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea','startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceFiles':hashes(),'sourceHold':True,'executionOrNativeOrProviderQualified':False,'scope':'exact13 ordinary cases:12 new proposal composition plus1 changed DI control; original discovery parser and verified positive FQNs; no broad fallback','commands':[]}
cmds=[('restore',['dotnet','restore','tests/backend/FsusBlog.Server.Tests.csproj','--locked-mode']),('build',['dotnet','build','tests/backend/FsusBlog.Server.Tests.csproj','--no-restore','--configuration','Release','--verbosity','quiet']),('selection-and-test',['node',str(out/'preflight-and-run.mjs'),'frozen']),('style',['node','tools/dotnet/check-csharp-style.mjs',*[a for p in paths if p.endswith('.cs') for a in ['--file',p]]]),('docs',['node','tools/docs/generate-document-lifecycle.mjs','--check']),('authoritative-docs',['node','tools/docs/check-authoritative-development-docs.mjs'])]
for name,argv in cmds:
 with (frozen/(name+'.log')).open('w') as f:r=subprocess.run(argv,stdout=f,stderr=subprocess.STDOUT)
 d['commands'].append({'argv':argv,'exitCode':r.returncode,'log':name+'.log'});print(name,r.returncode,flush=True)
 if r.returncode:break
trx=frozen/'working-proposal.trx'
if trx.exists():
 tree=ET.parse(trx);d['counts']=tree.find('.//{*}Counters').attrib
 assert d['counts']['total']=='13' and d['counts']['executed']=='13'
d['sdk']=subprocess.check_output(['dotnet','--version'],text=True).strip();d['endSource']=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();d['endStatus']=subprocess.check_output(['git','status','--porcelain'],text=True);d['sourceUnchanged']=d['sourceFiles']==hashes();d['endedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();d['assemblyHashes']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',root/'tests/backend/bin/Release/net10.0/FsusBlog.Server.dll',root/'tests/backend/bin/Release/net10.0/FsusBlog.Shared.dll']};(frozen/'result.json').write_text(json.dumps(d,indent=2)+'\n')
assert len(d['commands'])==len(cmds) and all(x['exitCode']==0 for x in d['commands'])
assert d['endSource']==sha and not d['endStatus'] and d['sourceUnchanged']
