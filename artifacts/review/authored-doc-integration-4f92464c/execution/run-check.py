import datetime,json,os,subprocess,sys,time
from pathlib import Path
root=Path('/workspace/.task-toolchains/3556/authored-doc-integration')
out=Path('/workspace/3556-evidence/authored-doc-integration')
name=sys.argv[1]; command=sys.argv[2:]
env=dict(os.environ); env['PATH']='/workspace/.task-toolchains/3556/node-v24.16.0-linux-x64/bin:/workspace/.task-toolchains/3556/dotnet302:/workspace/.task-toolchains/3556/markdownlint/node_modules/.bin:'+env['PATH']; env['DOTNET_CLI_HOME']='/workspace/.task-toolchains/3556/dotnet-home'; env['NUGET_PACKAGES']='/workspace/.task-toolchains/3556/nuget-packages'; env['DOTNET_NOLOGO']='true'; env['CI']='true'; env['DOTNET_SKIP_FIRST_TIME_EXPERIENCE']='true'; env['FSUSBLOG_CONTENT_FIELD_DOTNET']='/workspace/.task-toolchains/3556/dotnet302/dotnet'; env['TMPDIR']=str(root/'.tmp/chain-3556-temporary'); Path(env['TMPDIR']).mkdir(parents=True,exist_ok=True)
head=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()
start=datetime.datetime.now(datetime.timezone.utc).isoformat(); tick=time.monotonic()
with (out/(name+'.log')).open('w') as f: result=subprocess.run(command,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
receipt={'name':name,'command':command,'cwd':str(root),'testedCommit':head,'startedAt':start,'finishedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'durationSeconds':time.monotonic()-tick,'exitCode':result.returncode,'log':str(out/(name+'.log'))}
(out/(name+'.execution.json')).write_text(json.dumps(receipt,indent=2)+'\n'); print(json.dumps(receipt)); sys.exit(result.returncode)
