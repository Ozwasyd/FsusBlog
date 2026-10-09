from pathlib import Path
from datetime import datetime,timezone
import hashlib,json,os,subprocess,sys,xml.etree.ElementTree as ET
root=Path('/workspace/chain1975-cleanup-business-binding'); out=Path('/workspace/chain-1975-evidence')
sha='cceae3d9c41823f069eb143f9043bb03de343f11'
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
meta=json.loads((out/'cleanup-binding-cceae3d9-preflight.json').read_text())
lines=(out/'cleanup-binding-discovery-current.log').read_text().splitlines()
counts={c:sum(line.strip().startswith('FsusBlog.Server.Tests.'+c+'.') for line in lines) for c in meta['discoveredCounts']}
assert counts==meta['discoveredCounts'],(counts,meta['discoveredCounts'])
for fqn in meta['positiveFqns']: assert any(line.strip().startswith(fqn) for line in lines),fqn
assert not os.environ.get('FSUSBLOG_TEST_REDIS_DIAGNOSTICS')
meta.update(discoveryExit=0,discoveredCounts=counts,sourceCommit=sha,qualification=False)
env=os.environ.copy();env.update(FSUS_SCHEMA_MIGRATION_POSTGRES_IMAGE=meta['resourceObservation']['postgresImage'],FSUSBLOG_TEST_NAMESPACE='chain1975-cleanup',FSUSBLOG_DOCKER_CPU_UNITS='1',FSUSBLOG_DOCKER_MEMORY_HIGH_BYTES='268435456',FSUSBLOG_DOCKER_MEMORY_MAX_BYTES='536870912',FSUSBLOG_DOCKER_PIDS_MAX='256')
ns={'t':'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
meta['runs']=[]
for phase,expected,selector in [('positive',2,'|'.join('FullyQualifiedName='+f for f in meta['positiveFqns'])),('focused',28,'|'.join('FullyQualifiedName~FsusBlog.Server.Tests.'+c for c in counts))]:
    runid='chain1975-cleanup-cceae3d9-'+phase;env['FSUSBLOG_TEST_RUN_ID']=runid
    existingRoots={str(p) for prefix in meta['nativeRootPrefix'] for p in Path('/tmp').glob(prefix+'*')}; start=datetime.now(timezone.utc).isoformat(); stem='cleanup-binding-cceae3d9-'+phase
    command=['dotnet','test','tests/backend/FsusBlog.Server.Tests.csproj','--no-build','--no-restore','--filter',selector,'--logger',f'trx;LogFileName={stem}.trx','--results-directory',str(out),'--verbosity','minimal']
    with (out/(stem+'.log')).open('w') as stream: result=subprocess.run(command,cwd=root,env=env,stdout=stream,stderr=subprocess.STDOUT)
    stop=datetime.now(timezone.utc).isoformat()
    row={'runId':runid,'testedSha':sha,'startUtc':start,'stopUtc':stop,'command':command,'exitCode':result.returncode,'log':str(out/(stem+'.log')),'trx':str(out/(stem+'.trx'))}
    if (out/(stem+'.trx')).exists():
        counters=ET.parse(out/(stem+'.trx')).find('.//t:Counters',ns);row['counters']=dict(counters.attrib)
    eventcmd=['docker','events','--since',start,'--until',stop,'--filter','type=container','--filter','label=com.fsusblog.test.run-id='+runid,'--format','{{json .}}']
    e=subprocess.run(eventcmd,text=True,capture_output=True);(out/(stem+'-docker-events.jsonl')).write_text(e.stdout);row['dockerEventsExit']=e.returncode;row['dockerEventsPath']=str(out/(stem+'-docker-events.jsonl'))
    events=[json.loads(line) for line in e.stdout.splitlines() if line.strip()];row['dockerContainerEvents']={identifier:[event.get('Action') for event in events if event['Actor']['ID']==identifier] for identifier in sorted({event['Actor']['ID'] for event in events})}
    p=subprocess.run(['docker','ps','-a','--filter','label=com.fsusblog.test.run-id='+runid,'--format','{{json .}}'],capture_output=True,text=True);(out/(stem+'-remaining-containers.jsonl')).write_text(p.stdout);row['remainingOwnedContainers']=len(p.stdout.splitlines());row['dockerPsExit']=p.returncode; row['newRemainingNativeRoots']=sorted({str(p) for prefix in meta['nativeRootPrefix'] for p in Path('/tmp').glob(prefix+'*')}-existingRoots)
    meta['runs'].append(row);(out/'cleanup-binding-cceae3d9-test-runs.json').write_text(json.dumps(meta,indent=2)+'\n')
    print(json.dumps({'phase':phase,'exitCode':result.returncode,'counters':row.get('counters'),'containerEvents':row['dockerContainerEvents'],'remainingOwnedContainers':row['remainingOwnedContainers']}),flush=True)
    assert result.returncode==0,(phase,result.returncode)
    assert int(row['counters']['total'])==expected and int(row['counters']['passed'])==expected and int(row['counters']['failed'])==0
    assert p.returncode==0 and not p.stdout.strip()
    assert e.returncode==0 and len(row['dockerContainerEvents'])==1 and all({'create','start','kill','die','destroy'}<=set(actions) for actions in row['dockerContainerEvents'].values())

    assert not row['newRemainingNativeRoots'],row['newRemainingNativeRoots']
