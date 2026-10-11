#!/usr/bin/env python3
"""Remap paths only in a temporary copy of the sealed original pure source probe.
Does not edit original source/tests/assertions or authorize stopped unit execution.
"""
import argparse,hashlib,json,pathlib,subprocess,tempfile
p=argparse.ArgumentParser();p.add_argument('--node',required=True);p.add_argument('--typescript',required=True);p.add_argument('--output',required=True);a=p.parse_args();package=pathlib.Path(__file__).resolve().parent;node=pathlib.Path(a.node).resolve(strict=True);ts=pathlib.Path(a.typescript).resolve(strict=True);out=pathlib.Path(a.output).resolve();source=package/'frozen-source-inputs';out.mkdir(parents=True,exist_ok=True)
if subprocess.check_output([str(node),'--version'],text=True).strip()!='v24.16.0':raise SystemExit('STOP: original Node24.16.0 required')
if subprocess.check_output([str(node),'-e','console.log(require(process.argv[1]).version)',str(ts)],text=True).strip()!='6.0.3':raise SystemExit('STOP: original TypeScript6.0.3 required')
manifest=json.loads((package/'frozen-source-inputs.json').read_text())
for f in manifest['files']:
 b=(source/f['path']).read_bytes()
 if len(b)!=f['bytes']or hashlib.sha256(b).hexdigest()!=f['sha256']:raise SystemExit('STOP: frozen input bytes differ '+f['path'])
original=package/'protocol-review-original/source-probes.cjs';probe=original.read_text();replacements={"'/workspace/runtime-borrow-install/node_modules/typescript'":json.dumps(str(ts)),"'/workspace/runtime-protocol-review'":json.dumps(str(source)),"'/workspace/runtime-protocol-review-evidence'":json.dumps(str(out))}
for old,new in replacements.items():
 if probe.count(old)!=1:raise SystemExit('STOP: original path-remap boundary differs')
 probe=probe.replace(old,new,1)
record={'source':manifest['source'],'tree':manifest['tree'],'originalProbeSha256':hashlib.sha256(original.read_bytes()).hexdigest(),'originalFilesUnchanged':True,'pathRemapOnly':replacements,'node':str(node),'typescript':str(ts),'noUnitTestsOrTransport':True,'noAcceptanceUpgrade':True}
with tempfile.TemporaryDirectory(prefix='original-source-probe-')as temp:
 script=pathlib.Path(temp)/'source-probes.cjs';script.write_text(probe);run=subprocess.run([str(node),str(script)],capture_output=True,text=True);record['argv']=[str(node),str(script)];record['exitCode']=run.returncode;(out/'portable-probe.log').write_text(run.stdout+run.stderr)
(out/'portable-command.json').write_text(json.dumps(record,indent=2)+'\n');print(json.dumps({'exitCode':record['exitCode'],'output':str(out),'functionsOnly':True}));raise SystemExit(record['exitCode'])
