from pathlib import Path
import os,subprocess,json,hashlib,shutil,datetime
here=Path(__file__).resolve().parent
repo=Path('/workspace/FsusBlog-3647-current-master');output=Path('/tmp/fsusblog-3647-current-master-runtime-probe');output.mkdir(exist_ok=True)
dotnet=Path('/tmp/fsusblog-3647-dotnet');sdk=dotnet/'sdk/10.0.401';product=repo/'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll';testbin=repo/'tests/backend/bin/Debug/net10.0';probe=output/'CurrentProductProjectionProbe.dll'
refs=sorted((dotnet/'packs/Microsoft.NETCore.App.Ref/10.0.12/ref/net10.0').glob('*.dll'))+sorted((dotnet/'packs/Microsoft.AspNetCore.App.Ref/10.0.12/ref/net10.0').glob('*.dll'))
assert refs and product.read_bytes()==(testbin/product.name).read_bytes()
command=['dotnet',str(sdk/'Roslyn/bincore/csc.dll'),'-nologo','-target:exe','-langversion:14','-out:'+str(probe),*['-r:'+str(p) for p in refs],'-r:'+str(product),str(here/'CurrentProductProjectionProbe.cs')]
start=datetime.datetime.now(datetime.timezone.utc).isoformat();result=subprocess.run(command,capture_output=True,text=True)
record={'command':command,'exitCode':result.returncode,'stdout':result.stdout,'stderr':result.stderr,'sourceSha256':hashlib.sha256((here/'CurrentProductProjectionProbe.cs').read_bytes()).hexdigest(),'productAssemblySha256':hashlib.sha256(product.read_bytes()).hexdigest(),'candidate':'b653640c86d214283f6865bcfc4a47571764686d','startUtc':start,'endUtc':datetime.datetime.now(datetime.timezone.utc).isoformat()}
(here/'current-product-probe-compile.json').write_text(json.dumps(record,indent=2)+'\n');assert result.returncode==0,record
for name in ['FsusBlog.Server.dll','FsusBlog.Core.dll','FsusBlog.Shared.dll']:
 shutil.copyfile(testbin/name,output/name)
run=subprocess.run(['dotnet','exec','--runtimeconfig',str(testbin/'FsusBlog.Server.Tests.runtimeconfig.json'),str(probe),'b653640c86d214283f6865bcfc4a47571764686d'],capture_output=True,text=True)
(here.parent/'current/current-product-probe-result.json').write_text(run.stdout)
print(run.stdout);print(run.stderr);raise SystemExit(run.returncode)
