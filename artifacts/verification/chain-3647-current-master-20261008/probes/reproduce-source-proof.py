#!/usr/bin/env python3
"""Reproduce the Roslyn source proof from exact public Git objects; no project XML edits."""
import argparse, pathlib, subprocess, json, shutil, sys, re
ap=argparse.ArgumentParser();ap.add_argument('--repo',required=True);ap.add_argument('--base',required=True);ap.add_argument('--head',required=True);ap.add_argument('--out',required=True);args=ap.parse_args()
repo=pathlib.Path(args.repo).resolve();out=pathlib.Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True);here=pathlib.Path(__file__).resolve().parent
sdk_rows=subprocess.check_output(['dotnet','--list-sdks'],text=True).splitlines();matches=[re.fullmatch(r'10\.0\.401 \[(.+)\]',s) for s in sdk_rows];matches=[m for m in matches if m];assert len(matches)==1,'Require official SDK10.0.401';sdk=pathlib.Path(matches[0].group(1))/'10.0.401';dotnet_root=sdk.parent.parent
refs=dotnet_root/'packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0';assert refs.is_dir(),'Require original reference pack10.0.12';dll=out/'BanProjectionContractProbe.dll';roslyn=sdk/'Roslyn/bincore'
argv=['dotnet',str(roslyn/'csc.dll'),'-nologo','-target:exe','-langversion:14','-out:'+str(dll),*['-r:'+str(f) for f in sorted(refs.glob('*.dll'))],'-r:'+str(roslyn/'Microsoft.CodeAnalysis.dll'),'-r:'+str(roslyn/'Microsoft.CodeAnalysis.CSharp.dll'),str(here/'BanProjectionContractProbe.cs')];subprocess.run(argv,check=True)
for name in ['Microsoft.CodeAnalysis.dll','Microsoft.CodeAnalysis.CSharp.dll']:shutil.copyfile(roslyn/name,out/name)
config=out/'probe.runtimeconfig.json';config.write_text(json.dumps({'runtimeOptions':{'tfm':'net10.0','framework':{'name':'Microsoft.NETCore.App','version':'10.0.0'}}}))
inputs=[]
for name,rev in [('original','b19b3dc715691b871f0e3cab598ec5da8f27633c'),('base',args.base),('head',args.head)]:
 path=out/(name+'.cs');path.write_bytes(subprocess.check_output(['git','show',rev+':src/backend/Infrastructure/Security/BanStateProjection.cs'],cwd=repo));inputs.append(str(path))
r=subprocess.run(['dotnet','exec','--runtimeconfig',str(config),str(dll),*inputs,str(here/'original-roster.json')],capture_output=True,text=True);(out/'proof.json').write_text(r.stdout);(out/'stderr.log').write_text(r.stderr);print(r.stdout);sys.exit(r.returncode)
