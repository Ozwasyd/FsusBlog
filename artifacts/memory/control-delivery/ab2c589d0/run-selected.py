import json,os,pathlib,re,subprocess,sys,xml.etree.ElementTree as ET
root=pathlib.Path.cwd();out=root/'.tmp/memory/nonce-composition-20261009'
classes={
'CspNonceTransientResponseTests':['AdmittedScratchStreamsCanonicalMultilingualBytesWithoutChangingTemplate','CanceledOuterWaitCannotRefundScratchWhileRealPipeFlushIsBackpressured','PreCanceledRequestWritesNoBodyAndReleasesOnlyTheOperationHold','SegmentCancellationPreservesOriginalSingleAdvanceAndNoFlush','CompletedReaderIsStillAnAbortedResponseAfterExactlyOneFlush','LogicalScratchBoundRejectsEvenWhenChargedPhysicalBucketWouldFit','RepeatedValidAndInvalidNonceFlowsReuseClearedBackingAndRefundOnce','HoldBudgetRejectionDoesNotEncodeNonceOrWriteTheResponse','RequestCancellationTerminatesTheRealPendingFlushBeforeHoldRelease'],
'CspNonceUtf8TemplateTests':['ResponseWriter_PropagatesCancellationBeforeCommit','ResponseWriter_AwaitsRealPipeBackpressureAndCommitsOnce','ResponseWriter_StopsAtNextSegmentBoundaryWhenRequestIsCanceled','ResponseWriter_PropagatesCompletedReaderAsAbortedResponse']}
expected=14
allow={f'FsusBlog.Server.Tests.Unit.{c}.{m}' for c,methods in classes.items() for m in methods}
assert len(allow)==13 and expected==14 and all(allow)
for c,methods in classes.items():
 source=(root/f'tests/backend/Unit/{c}.cs').read_text()
 assert 'using FsusBlog.Server.Infrastructure.PublicAot;' in source
 for method in methods:
  assert re.search(r'public (?:async )?Task '+method+r'\(',source),method
  body=source.split('public async Task '+method+'(')[1].split('\n    [')[0]
  assert 'CspNonceHtmlResponseWriter.WriteBodyAsync(' in body
 assert 'Skip =' not in source and '"Integration"' not in source and '"LocalRedis"' not in source
source=(root/'tests/backend/Unit/CspNonceTransientResponseTests.cs').read_text()
assert set(re.findall(r'^    public (?:async )?Task (\w+)\(',source,re.M))==set(classes['CspNonceTransientResponseTests'])
assert 'TransientMemoryTestLedger.Create' in source and 'TransientBufferPool(' in source and 'pauseWriterThreshold: 1' in source
assert 'return inner.FlushAsync(cancellationToken);' in source and 'IHttpResponseBodyFeature' in source
production=(root/'src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs').read_text()
assert 'return nonceScratch.ConsumeAsync(' in production and 'ReservedCspNonceScratchWriter.Write(' in production
assert 'return new ValueTask(FlushBodyAsync(response, token));' in production
assert 'response.BodyWriter.FlushAsync(cancellationToken)' in production and 'ThrowIfCanceled(flush.Result, cancellationToken)' in production
supplier=(root/'src/backend/Infrastructure/PublicAot/ReservedCspNonceScratchWriter.cs').read_text()
assert 'template.Write(destination, callerAdmittedNonceScratch[..nonceLength], token);' in supplier
project=(root/'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'Unit/' not in project and 'Unit\\' not in project
filter_value='('+'|'.join('FullyQualifiedName='+m for m in sorted(allow))+')&Category!=Integration&Fixture!=LocalRedis'
assert filter_value and filter_value.count('FullyQualifiedName=')==13
base=['dotnet','test','tests/backend/FsusBlog.Server.Tests.csproj','--no-restore','--filter',filter_value]
record={'sourceSha':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'expectedCases':expected,'positiveFqnAllowlist':sorted(allow),'filter':filter_value,'actualImportsAndHooksVerified':True,'dataRoot':os.environ['FSUSBLOG_DATA_ROOT'],'commands':[]}
assert record['sourceSha']=='ab2c589d02fabfa6ed15967f0e58800d2555398a'
def run(command,log):
 record['commands'].append(command)
 with (out/log).open('w') as f: result=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
 record[log+'.exit']=result.returncode;(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
 if result.returncode: print(log+' failed; dependent execution stopped');sys.exit(result.returncode)
run(base+['--list-tests'],'list-tests.log')
listed=[s.strip() for s in (out/'list-tests.log').read_text().splitlines() if s.strip().startswith('FsusBlog.Server.Tests.Unit.')]
methods=[line.split('(')[0].strip() for line in listed]
assert len(listed)==expected and len(set(listed))==expected and set(methods)==allow,(len(listed),listed)
record['discoveredCases']=listed;record['listSelectionVerifiedBeforeExecution']=True
(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
run(base+['--no-build','--results-directory',str(out),'--logger','trx;LogFileName=selected.trx'],'selected.log')
results=ET.parse(out/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results)==expected and all(r.attrib['outcome']=='Passed' for r in results)
record['passedCases']=expected;(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'sourceSha':record['sourceSha'],'passed':expected,'selectionVerifiedBeforeExecution':True}))
