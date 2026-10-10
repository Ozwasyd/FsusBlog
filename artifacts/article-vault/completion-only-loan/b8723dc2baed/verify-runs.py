from pathlib import Path
import json,os,hashlib,subprocess,collections
p=Path('/workspace/chain-1975-evidence/completion-only-loan-20261010');runs=[]
for label,expected in [('positive',2),('focused',41)]:
 report=json.loads((p/label/'reports/vitest/unit/unsharded.json').read_text());cases=[a for t in report['testResults'] for a in t['assertionResults']];counts=collections.Counter(a['status'] for a in cases);assert counts['passed']==expected and not counts['failed'];assert counts['skipped']==(39 if label=='positive' else 0)
 events=[json.loads(s) for s in (p/label/'topology.jsonl').read_text().splitlines()];starts=[e for e in events if e['event']=='start'];finishes=[e for e in events if e['event']=='finish'];assert len(starts)==len(finishes)==expected;assert collections.Counter(e['task']['id'] for e in starts)==collections.Counter(e['task']['id'] for e in finishes)
 pids=sorted({e['workerProcessId'] for e in events});alive=[]
 for pid in pids:
  try:os.kill(pid,0);alive.append(pid)
  except ProcessLookupError:pass
 assert not alive
 record=json.loads((p/(label+'.json')).read_text());record.update(passed=expected,failed=0,outsideSelector=39 if label=='positive' else 0,starts=len(starts),finishes=len(finishes),workerPids=pids,workersRemaining=alive,cases=[{'name':a['fullName'],'status':a['status']} for a in cases]);runs.append(record)
(p/'current-runs.json').write_text(json.dumps({'testedSource':runs[0]['head'],'qualification':False,'runs':runs},indent=2)+'\n')
before=json.loads((p/'source-before.json').read_text());after=[]
for row in before['inputs']:
 h=hashlib.sha256(Path(row['path']).read_bytes()).hexdigest();assert h==row['sha256'];after.append({'path':row['path'],'unchanged':True,'sha256':h})
assert subprocess.check_output(['git','status','--porcelain'],text=True)==''
(p/'source-immutability.json').write_text(json.dumps({'source':before['source'],'clean':True,'inputs':after,'qualification':False},indent=2)+'\n')
print('positive2 / focused41 actual report+matching topology; all workers gone; source unchanged')
