from pathlib import Path
from datetime import datetime,timezone
import subprocess,os,json,sys
root=Path('/workspace/chain1975-provider-facts-only');out=Path('/workspace/chain-1975-evidence/provider-facts-only');meta=json.loads((out/'preflight.json').read_text())
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==meta['sourceSha']
assert not subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True).strip()
env=os.environ.copy();env.update(FSUSBLOG_USE_LOCAL_FSUSUI='1',FSUSBLOG_LOCAL_FSUSUI_ROOT='/workspace/chain1975-provider-facts-fsusui',FSUSBLOG_VITEST_MAX_WORKERS='1',FSUSBLOG_STEP_CPU_BUDGET='1',FSUSBLOG_STEP_MEMORY_GIB='0.5')
files=['../../tests/frontend/unit/services/authoring/articleAttachmentUploadProvider.test.ts','../../tests/frontend/unit/services/authoring/articleAttachmentFactsBusiness.test.ts','../../tests/frontend/unit/services/authoring/articleAttachmentBusinessState.test.ts','../../tests/frontend/unit/api/upload.test.ts']
meta['runs']=[]
for phase,selected,expected,pattern in [('positive',[files[0]],2,'(uses actual completion then re-observes original ledger/bytes instead of trusting URL|reads original facts without preview bytes for 20971520-byte committed uploads)$'),('focused',files,54,None)]:
 runid='chain1975-provider-facts-98dc5c4e-'+phase;report=out/phase;env.update(FSUSBLOG_PRODUCTION_FRESH_OUTPUT_ROOT=str(report),FSUSBLOG_VITEST_LANE='unit',FSUSBLOG_VITEST_SHARD_ID=runid,FSUSBLOG_VITEST_RUNTIME_TOPOLOGY_EVIDENCE=str(out/(phase+'-topology.jsonl')))
 command=['node_modules/.bin/vitest','run','--config','vitest.config.ts',*selected]
 if pattern:command+=['--testNamePattern',pattern]
 start=datetime.now(timezone.utc).isoformat()
 with (out/(phase+'.log')).open('w') as stream:r=subprocess.run(command,cwd=root/'src/frontend',env=env,stdout=stream,stderr=subprocess.STDOUT)
 reportpath=report/'reports/vitest/unit'/f'{runid}.json';data=json.loads(reportpath.read_text()) if reportpath.exists() else {}
 row={'runId':runid,'testedSource':meta['sourceSha'],'startUtc':start,'stopUtc':datetime.now(timezone.utc).isoformat(),'command':command,'cwd':str(root/'src/frontend'),'exitCode':r.returncode,'report':str(reportpath),'passed':data.get('numPassedTests'),'failed':data.get('numFailedTests'),'outsideSelectorOrSkipped':data.get('numPendingTests'),'total':data.get('numTotalTests')}
 events=[json.loads(line) for line in (out/(phase+'-topology.jsonl')).read_text().splitlines()] if (out/(phase+'-topology.jsonl')).exists() else []
 row['starts']=sum(e['event']=='start' for e in events);row['finishes']=sum(e['event']=='finish' for e in events);row['workerPids']=sorted({e['workerProcessId'] for e in events});row['workersRemaining']=[pid for pid in row['workerPids'] if Path('/proc',str(pid)).exists()]
 meta['runs'].append(row);(out/'test-runs.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(row),flush=True)
 if r.returncode or row['passed']!=expected or row['failed']!=0 or row['starts']!=expected or row['finishes']!=expected or row['workersRemaining']:sys.exit(1)
 if phase=='focused' and row['outsideSelectorOrSkipped']!=0:sys.exit(1)
