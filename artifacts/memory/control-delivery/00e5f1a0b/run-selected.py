import datetime, hashlib, json, os, pathlib, re, subprocess, sys, uuid, xml.etree.ElementTree as ET
root=pathlib.Path.cwd(); out=root/'.tmp/memory/snapshot-host-20261009'
classes={
'OwnedPublicHotReadSnapshotTests':[
'SuppliedRealLeasesSurviveBackingRetirementAndServeOriginalIdentity',
'ContentReplacementKeepsTheOldReadThroughOriginalPipeCompletion',
'DropRejectsNewReadsWhileCanceledOuterWaitKeepsOriginalConsumptionAlive',
'RequestCancellationEndsTheOriginalWriteBeforeReturningDroppedOwnership',
'RetainLastGoodKeepsTheSuppliedLeaseUntilOriginalDrop',
'SoftRefreshKeepsThePinnedRealOwnerUntilOriginalWindowExpires',
'SharedHoldBudgetRejectsBeforeBodyOrEndpointWithoutReleasingPublication',
'SensitiveAndCredentialBypassDoesNotSpendTheOnlySharedHold',
'OriginalPublicationRejectionLeavesCurrentAndCallerCleanupIntact',
'DistributedCopiesShareRealReadsAndReleaseEveryIntermediateHold',
'InterruptedFragmentReturnsItsUnpublishedCloneBeforeTheNextRead',
'RepeatedPublishUsesOneSuppliedReadAndReturnsItOnce',
'AnotherStoreCannotConsumeTheAlreadyTransferredSnapshot',
'OrdinaryLeaseInputMustMatchTheExistingOpaqueRepresentation',
'InvalidSharedBoundDoesNotConsumeTheCallerLease',
'UnpublishedSnapshotCleanupIsIdempotentWithoutReturningLiveSiblingData',
'OwnedAttachmentRejectsPrecompressionBeforeArrayOnlySchemaValidation',
'ExpiredOwnedStickyIsReleasedWhenTheNewCurrentUsesOriginalArrays'],
'PublicHotReadVersionStickinessTests':[
'SoftRefresh_SameClientKeepsPinnedGenerationUntilWindowExpires',
'ContentPublish_AdvancesGenerationImmediatelyInsideWindow',
'HardInvalidation_ClearsPinAndDoesNotServeStaleBytes',
'SoftRefresh_KeepsL0HitWhenCurrentGenerationDroppedTheKey'],
'PublicHotReadSanityTests':['Publish_RejectsCandidateWhoseSealedPayloadWasTamperedAfterBuild']}
expected=29
allow={f'FsusBlog.Server.Tests.Unit.{c}.{m}' for c,methods in classes.items() for m in methods}
assert len(allow)==23 and expected==29 and all(allow)
for c,methods in classes.items():
 source=(root/f'tests/backend/Unit/{c}.cs').read_text()
 assert 'using FsusBlog.Server.Infrastructure.PublicReadArtifacts;' in source
 for method in methods:
  match=re.search(r'public (?:async Task|void) '+method+r'\(',source); assert match,method
  body=source[match.start():].split('\n    [')[0]
  assert ('Fixture(' if c=='OwnedPublicHotReadSnapshotTests' else 'await Serve(' if c=='PublicHotReadVersionStickinessTests' else 'store.Publish(') in body,method
original_wrapper=(root/'tests/backend/Unit/PublicHotReadVersionStickinessTests.cs').read_text().split('private static Task Serve(')[1].split('private static PublicHotReadOptions')[0]
assert '=> PublicHotReadFastPath.TryServeAsync(' in original_wrapper
new=(root/'tests/backend/Unit/OwnedPublicHotReadSnapshotTests.cs').read_text()
assert set(re.findall(r'^    public (?:async Task|void) (\w+)\(',new,re.M))==set(classes['OwnedPublicHotReadSnapshotTests'])
assert new.count('[Fact]')==14 and new.count('[Theory]')==4 and new.count('[InlineData(')==10
assert all(x not in new for x in ['Skip =','NativeMemoryArena','"Integration"','"LocalRedis"'])
for hook in ['ManagedMemoryBacking.TryCreate(', 'Owner.TryAcquireHostView(Owner.Location)',
 'PublicHotReadBinaryArtifactFactory.FromHostReadLease(', 'Prepared.WithHostReadLeases(',
 'PublicHotReadFastPath.TryServeAsync(', 'store.Publish(', 'store.PublishSoftRefresh(',
 'store.ApplyDistributedFragments(', 'store.InvalidateDistributedSnapshot(',
 'pauseWriterThreshold: 1', 'IHttpResponseBodyFeature', 'operation.WaitAsync(outerWait.Token)']:
 assert hook in new,hook
snapshot=(root/'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSnapshot.HostOwnership.cs').read_text()
for hook in ['lease.Content.Validate();','lease.Location.Validate();','opaque.Remove(lease.Memory)',
 'snapshot.DetachHostRoot','_hostRootHold']:
 if hook=='snapshot.DetachHostRoot':continue
 assert hook in snapshot,hook
assert not any(x in snapshot for x in ['Guid.NewGuid(', 'ToArray(', 'CreateVerified(', 'new byte[', 'NativeMemory', 'Task.Run('])
store=(root/'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadStore.HostOwnership.cs').read_text()
assert 'lock (_gate)' in store and 'snapshot.TryRetainHostConsumption()' in store and 'DetachInactiveHostRootLocked' in store
main=(root/'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs').read_text()
assert main.index('PublicHotReadArtifactIntegrity.IsSnapshotValid(next)')<main.index('next.ClaimHostPublication(this)')<main.index('Volatile.Write(ref _current, next)')
assert 'DisposeIntermediateHostClone(previous, next, current)' in main
serving=(root/'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs').read_text()
for hook in ['TryGetRequestSnapshotForConsumption(', 'CompleteHostConsumption(consumption, hostHold)',
 'await consumption.ConfigureAwait(false)', 'response.BodyWriter.WriteAsync(frame, ctx.RequestAborted)']:
 assert hook in serving,hook
project=(root/'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'Unit/' not in project and 'Unit\\' not in project
sha=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
assert sha=='00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b'
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
prior=json.loads((root/'artifacts/memory/control-delivery/de0adc1a5/preflight.json').read_text())
assert not allow.intersection(prior['positiveFqnAllowlist'])
filter_value='('+'|'.join('FullyQualifiedName='+m for m in sorted(allow))+')&Category!=Integration&Fixture!=LocalRedis'
assert filter_value and filter_value.count('FullyQualifiedName=')==23
record={'sourceSha':sha,'runId':'ordinary-snapshot-host-'+str(uuid.uuid4()),'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'gitTreeSha256':hashlib.sha256(subprocess.check_output(['git','ls-tree','-rz','HEAD'])).hexdigest(),
'expectedCases':expected,'positiveFqnAllowlist':sorted(allow),'filter':filter_value,'actualImportsAndHooksVerified':True,
'prior21SelectionNotRerun':True,'originalProject':'tests/backend/FsusBlog.Server.Tests.csproj','dataRoot':os.environ['FSUSBLOG_DATA_ROOT'],'commands':[]}
def run(command,log):
 record['commands'].append(command)
 with (out/log).open('w') as f: result=subprocess.run(command,stdout=f,stderr=subprocess.STDOUT)
 record[log+'.exit']=result.returncode; (out/'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
 if result.returncode:
  print(log+' failed; dependent execution stopped')
  text=(out/log).read_text(); print('\n'.join(line for line in text.splitlines() if ': error ' in line or 'Failed ' in line)[-4000:])
  print('\n'.join(text.splitlines()[-12:])); sys.exit(result.returncode)
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
print(json.dumps({'sourceSha':sha,'passed':expected,'runId':record['runId'],'selectionVerifiedBeforeExecution':True,'prior21NotRerun':True}))
