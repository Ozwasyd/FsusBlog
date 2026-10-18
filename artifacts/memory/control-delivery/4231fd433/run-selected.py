import json,os,pathlib,re,subprocess,sys,xml.etree.ElementTree as ET
root=pathlib.Path.cwd();out=root/'.tmp/memory/governor-nullability-20261009'
methods=['SameInputSequenceProducesSameTargetsReasonsAndOrderedDegradation','OscillationResetsRecoveryWindowAndGrowthIsRateBounded','WallClockForwardJumpCannotSkipTheMonotonicRecoveryWindow','MissingPreviousDecisionCannotHideTheCanonicalEnforcedBound','QualifiedRecoveryCanGrowIndependentSlotsAfterTheStableWindow']
allow=[f'FsusBlog.Server.Tests.Unit.MemoryGovernorTests.{m}' for m in methods]
expected=5
assert len(allow)==expected and len(set(allow))==expected and all(allow)
source=(root/'tests/backend/Unit/MemoryGovernorTests.cs').read_text()
assert 'using FsusBlog.Server.Infrastructure.Memory.Control;' in source and 'MemoryGovernor.Evaluate(' in source
for method in methods:
    assert re.search(r'\[Fact\]\s+public void '+method+r'\(',source),method
    body=source.split('public void '+method+'(')[1].split('\n    [')[0]
    assert 'MemoryGovernor.Evaluate(' in body
assert 'Skip =' not in source and 'Synthetic contract facts exercise an inactive decision function' in source
project=(root/'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'Unit/' not in project and 'Unit\\' not in project
filter_value='('+'|'.join('FullyQualifiedName='+m for m in allow)+')&Category!=Integration&Fixture!=LocalRedis'
assert filter_value and filter_value.count('FullyQualifiedName=')==expected
base=['dotnet','test','tests/backend/FsusBlog.Server.Tests.csproj','--no-restore','--filter',filter_value]
record={'sourceSha':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'expectedCases':expected,'positiveFqnAllowlist':allow,'filter':filter_value,'actualImportsAndHooksVerified':True,'dataRoot':os.environ['FSUSBLOG_DATA_ROOT'],'commands':[]}
assert record['sourceSha']=='4231fd4337817c62270336eb6b37964878ab27fc'
def run(command,log):
    record['commands'].append(command)
    with (out/log).open('w') as f: result=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
    record[log+'.exit']=result.returncode;(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
    if result.returncode: print(log+' failed; dependent execution stopped');sys.exit(result.returncode)
run(base+['--list-tests'],'list-tests.log')
listed=[s.strip() for s in (out/'list-tests.log').read_text().splitlines() if s.strip().startswith('FsusBlog.Server.Tests.Unit.')]
assert len(listed)==expected and set(listed)==set(allow),(len(listed),listed)
record['discoveredCases']=listed;record['listSelectionVerifiedBeforeExecution']=True
assert not re.search(r'MemoryGovernor\.cs\([^\n]*CS8602',(out/'list-tests.log').read_text()),'Governor nullable diagnostic persists; stop'
record['freshOriginalBuildGovernorCs8602Count']=0
(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
run(base+['--no-build','--results-directory',str(out),'--logger','trx;LogFileName=selected.trx'],'selected.log')
results=ET.parse(out/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results)==expected and all(r.attrib['outcome']=='Passed' for r in results)
record['passedCases']=expected;(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'sourceSha':record['sourceSha'],'passed':expected,'freshOriginalBuildGovernorCs8602Count':0,'selectionVerifiedBeforeExecution':True}))
