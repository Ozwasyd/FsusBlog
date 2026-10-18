import datetime, hashlib, json, os, pathlib, re, subprocess, sys, uuid, xml.etree.ElementTree as ET
root=pathlib.Path.cwd(); out=root/'.tmp/memory/host-frame-20261009'
classes={
'PublicBinaryHostFrameTests':[
'HostMemoryMatchesArrayFactoryBytesMetadataAndOriginalIntegrity',
'OriginalResponsePreservesIdentityBytesStatusAndHeaders',
'OuterWaitCancellationKeepsTheReadLeaseThroughOriginalPipeCompletion',
'OriginalPendingWriteCancellationPropagatesAndEndsOnlyItsReadHold',
'ConsumerFailurePropagatesWithoutReturningTheRootBacking',
'InvalidFrameOrCeilingRejectsAndReturnsTheAcquiredReadHold',
'StaleLocationPreservesTheOriginalTypedRejection',
'ReadHoldLimitRejectsBeforeConsumerWithoutAnotherPhysicalCharge',
'PreCanceledInputDoesNotAcquireOrCallTheConsumer',
'CompressionRequestRejectsWithoutAcquisitionOrCompatibilityCopy',
'RepeatedBorrowingEndsEachReadHoldAndRefundsTheBackingOnce'],
'PublicHotReadFastPathTests':[
'TryServeAsync_DetailHit_PrefersPrecompressedBrotliVariant',
'TryServeAsync_DetailHit_QValueFallbackStillHonorsQuality',
'TryServeAsync_DetailHit_Returns304ForMatchingIfNoneMatch',
'TryServeAsync_DetailHeadHit_WritesHeadersWithoutBody',
'TryServeAsync_ResponseAbortCancellationPropagatesFromBodyWriter']}
expected=21
allow={f'FsusBlog.Server.Tests.Unit.{c}.{m}' for c,methods in classes.items() for m in methods}
assert expected==21 and len(allow)==16 and all(allow)
for c,methods in classes.items():
 source=(root/f'tests/backend/Unit/{c}.cs').read_text()
 assert 'using FsusBlog.Server.Infrastructure.PublicReadArtifacts;' in source
 for method in methods:
  match=re.search(r'public async Task '+method+r'\(',source); assert match,method
  body=source[match.start():].split('\n    [')[0]
  assert ('Consume(' if c=='PublicBinaryHostFrameTests' else 'PublicHotReadFastPath.TryServeAsync(') in body, method
new=(root/'tests/backend/Unit/PublicBinaryHostFrameTests.cs').read_text()
assert set(re.findall(r'^    public async Task (\w+)\(',new,re.M))==set(classes['PublicBinaryHostFrameTests'])
assert new.count('[Fact]')==8 and new.count('[Theory]')==3 and new.count('[InlineData(')==8
assert all(x not in new for x in ['Skip =','NativeMemoryArena','CreateVerified','"Integration"','"LocalRedis"'])
for hook in ['ManagedMemoryBacking.TryCreate(', 'source.TryAcquireHostView(expectedLocation)',
 'PublicHotReadBinaryArtifactFactory.ConsumeHostFrameAsync(', 'PublicHotReadFastPath.WriteBinaryFrame(',
 'PublicHotReadArtifactIntegrity.Seal(', 'pauseWriterThreshold: 1', 'IHttpResponseBodyFeature', 'operation.WaitAsync(outerWait.Token)']:
 assert hook in new,hook
factory=(root/'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs').read_text()
adapter=factory.split('ConsumeHostFrameAsync(')[1].split('internal static ValueTask ConsumeReservedPayloadAsync')[0]
assert 'source.TryAcquireHostView(expectedLocation)' in adapter and 'using IMemoryHostReadLease lease = acquisition.Value!;' in adapter
assert 'FromFrame(lease.Memory,' in adapter and 'await consumer(artifact, cancellationToken).ConfigureAwait(false);' in adapter
assert not any(x in adapter for x in ['ToArray(', 'new byte[', 'TryCreate(', '.Publish(', 'NativeMemory', 'MemoryStream', 'Task.Run('])
serving=(root/'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs').read_text()
assert 'response.BodyWriter.WriteAsync(frame, ctx.RequestAborted)' in serving
project=(root/'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'Unit/' not in project and 'Unit\\' not in project
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert sha=='0ecb2a98c62b9ed79a34b202da80f96ce6dcef53'
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
filter_value='('+'|'.join('FullyQualifiedName='+m for m in sorted(allow))+')&Category!=Integration&Fixture!=LocalRedis'
assert filter_value and filter_value.count('FullyQualifiedName=')==16
record={'sourceSha':sha,'runId':'ordinary-host-frame-'+str(uuid.uuid4()),'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'gitTreeSha256':hashlib.sha256(subprocess.check_output(['git','ls-tree','-rz','HEAD'])).hexdigest(),
'expectedCases':expected,'positiveFqnAllowlist':sorted(allow),'filter':filter_value,'actualImportsAndHooksVerified':True,
'originalProject':'tests/backend/FsusBlog.Server.Tests.csproj','dataRoot':os.environ['FSUSBLOG_DATA_ROOT'],'commands':[]}
def run(command,log):
 record['commands'].append(command)
 with (out/log).open('w') as f: result=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
 record[log+'.exit']=result.returncode; (out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
 if result.returncode:
  print(log+' failed; dependent execution stopped')
  print('\n'.join((out/log).read_text().splitlines()[-35:])); sys.exit(result.returncode)
base=['dotnet','test','tests/backend/FsusBlog.Server.Tests.csproj','--no-restore','--filter',filter_value]
run(base+['--list-tests'],'list-tests.log')
listed=[s.strip() for s in (out/'list-tests.log').read_text().splitlines() if s.strip().startswith('FsusBlog.Server.Tests.Unit.')]
methods=[line.split('(')[0].strip() for line in listed]
assert len(listed)==expected and len(set(listed))==expected and set(methods)==allow,(len(listed),listed)
record['discoveredCases']=listed; record['listSelectionVerifiedBeforeExecution']=True
(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
run(base+['--no-build','--results-directory',str(out),'--logger','trx;LogFileName=selected.trx'],'selected.log')
results=ET.parse(out/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results)==expected and all(r.attrib['outcome']=='Passed' for r in results),[(r.attrib['testName'],r.attrib['outcome']) for r in results]
record['passedCases']=expected; record['completedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat()
(out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'sourceSha':sha,'passed':expected,'runId':record['runId'],'selectionVerifiedBeforeExecution':True}))
