from pathlib import Path
import json,os,collections,subprocess,hashlib
p=Path('/workspace/chain-1975-evidence/preack-abort-binding-20261010'); source='734f8925d41c3d089cc039989292c352e0ee741b'; runs=[]
for label,expected,skipped,exitcode in [('positive',2,57,0),('focused',67,0,0),('prefix',0,60,1)]:
 report=json.loads((p/(label+'-report.json')).read_text()); cases=[a for t in report['testResults'] for a in t['assertionResults']];counts=collections.Counter(a['status'] for a in cases)
 assert counts['passed']==expected and counts['skipped']==skipped and counts['failed']==(7 if label=='prefix' else 0),(label,counts)
 events=[json.loads(s) for s in (p/(label+'-run')/'topology.jsonl').read_text().splitlines()]; starts=[e for e in events if e['event']=='start'];finishes=[e for e in events if e['event']=='finish']; n=7 if label=='prefix' else expected
 assert len(starts)==len(finishes)==n
 assert collections.Counter(e['task']['id'] for e in starts)==collections.Counter(e['task']['id'] for e in finishes)
 pids=sorted({e['workerProcessId'] for e in events}); alive=[]
 for pid in pids:
  try:os.kill(pid,0);alive.append(pid)
  except ProcessLookupError:pass
 assert not alive
 record=json.loads((p/(('prefix-negative' if label=='prefix' else label)+'.json')).read_text()); assert record['exitCode']==exitcode and record['runId']
 assert record['head']==('01636576e8f92151b2a1a1e429bae6dd2b860f05' if label=='prefix' else source)
 record.update(passed=expected,failed=7 if label=='prefix' else 0,outsideSelector=skipped,starts=len(starts),finishes=len(finishes),workerPids=pids,workersRemaining=alive,cases=[{'name':a['fullName'],'status':a['status']} for a in cases]);runs.append(record)
roster=json.loads((p/'discovery-roster.json').read_text()); assert len(roster)==67
actual={a['fullName'] for t in json.loads((p/'focused-report.json').read_text())['testResults'] for a in t['assertionResults']}; assert {r['name'].replace(' > ',' ') for r in roster}==actual
pr=json.loads((p/'prerequisites.json').read_text()); assert pr['head']==source and pr['exitCode']==0
log=(p/'prerequisites.log').read_text();assert 'ℹ tests 37' in log and 'ℹ pass 37' in log and 'ℹ fail 0' in log
(p/'current-runs.json').write_text(json.dumps({'testedSource':source,'qualification':False,'discoveryCount':67,'runtimeCount':59,'apiCount':8,'prerequisites':37,'runs':runs},indent=2)+'\n')
pre=json.loads((p/'preimages.json').read_text()); rows=[]
for row in pre['paths']:
 path=row['path']; blob=subprocess.check_output(['git','rev-parse',source+':'+path],text=True).strip();b=Path(path).read_bytes();assert b==subprocess.check_output(['git','show',source+':'+path]);rows.append({'path':path,'preBlob':row['blob'],'preSha256':row['sha256'],'postBlob':blob,'postSha256':hashlib.sha256(b).hexdigest()})
assert subprocess.check_output(['git','status','--porcelain'],text=True)==''
assert subprocess.check_output(['git','diff','--name-only','2299ac4804bbf66875e7bdadf128fdcae69f93c6',source],text=True).splitlines()==sorted(r['path'] for r in rows)
(p/'source-immutability.json').write_text(json.dumps({'source':source,'tree':subprocess.check_output(['git','rev-parse',source+'^{tree}'],text=True).strip(),'clean':True,'paths':rows,'qualification':False},indent=2)+'\n')
print('2 selected positives, all67 current controls (runtime59/API8),37 prerequisites;7 expected pre-fix failures; genuine setup/hook topology and terminated workers;five source paths immutable')
