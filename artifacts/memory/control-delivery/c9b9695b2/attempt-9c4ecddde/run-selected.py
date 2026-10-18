import datetime, hashlib, json, os, pathlib, re, subprocess, sys, uuid, xml.etree.ElementTree as ET

root = pathlib.Path.cwd()
out = root / '.tmp/memory/ownership-policy-20261009'
baseline = 'c1ac6630e86a899f4acf59283ea10a4fcdd69894'
classes = {
    'PublicHotReadSnapshotOwnershipPolicyTests': [
        'ExistingConfigurationSectionBindsRequiredInputsWithoutNumericalDefaults',
        'MissingRequiredFieldCannotCreatePolicyOrReserveResources',
        'InvalidFiniteValuesRejectBeforeChangingTheOriginalPolicy',
        'MissingUnfrozenOrMismatchedBaselineDoesNotGrantAdmission',
        'ActualDomainUnitsAndAccountingRevisionAreRequired',
        'ConfigurationCannotSubstituteDifferentValuesForTheFrozenOwnerInput',
        'FrozenValuesAreCopiedAndTheRealVectorIncludesExplicitHeadroom',
        'ExplicitZeroHeadroomMeansNoExtraReservationRatherThanOmission',
        'ByteOrSlotExhaustionRejectsBeforeTransferringTheCallerLease',
        'RepresentationRosterRefusesAdmissionBeforeGroupAllocation',
        'SnapshotAndConsumerRostersRejectWhileAggregateSlotsRemain',
        'SharedCloneKeepsBudgetAndFailedRepresentationGrowthLeavesOriginalAlive',
        'StaleAccountingAndInvalidReloadLeaveTheOriginalRevisionIntact',
        'ReloadWaitsForOriginalPipeCompletionAfterPublicationDrop',
        'RepeatedAdmittedGroupsReturnEachReservationOnce',
    ],
    'OwnedPublicHotReadSnapshotTests': [
        'SuppliedRealLeasesSurviveBackingRetirementAndServeOriginalIdentity',
        'ContentReplacementKeepsTheOldReadThroughOriginalPipeCompletion',
        'SharedHoldBudgetRejectsBeforeBodyOrEndpointWithoutReleasingPublication',
        'DistributedCopiesShareRealReadsAndReleaseEveryIntermediateHold',
    ],
}
expected = 45
allow = {f'FsusBlog.Server.Tests.Unit.{c}.{m}' for c, methods in classes.items() for m in methods}
assert len(allow) == 19 and all(allow) and expected == 45
for cls, methods in classes.items():
    source = (root / f'tests/backend/Unit/{cls}.cs').read_text()
    assert 'using FsusBlog.Server.Infrastructure.PublicReadArtifacts;' in source
    for method in methods:
        match = re.search(r'public (?:async Task|void) ' + method + r'\(', source)
        assert match, method
        body = source[match.start():].split('\n    [')[0]
        assert 'Fixture(' in body, method
        assert '[Fact(Skip' not in source and '[Theory(Skip' not in source
new_tests = (root / 'tests/backend/Unit/PublicHotReadSnapshotOwnershipPolicyTests.cs').read_text()
assert new_tests.count('[Fact]') == 11 and new_tests.count('[Theory]') == 4 and new_tests.count('[InlineData(') == 28
assert not any(term in new_tests for term in ['NativeMemoryArena', 'GpuMemory', 'TOCTOU', 'LocalRedis', 'Trait("Category", "Integration")'])
for hook in ['.Configure<PublicHotReadOptions>(configuration.GetSection("PublicHotRead"))',
             'PublicHotReadSnapshotOwnershipPolicy.TryCreate(', 'TryApplySnapshotOwnershipPolicy(',
             'TryAttachSnapshotHostOwnership(', 'ManagedMemoryBacking.TryCreate(',
             'TryAcquireHostView(owner.Location)', 'FromHostReadLease(',
             'PublicHotReadFastPath.TryServeAsync(', 'pipe.Reader.ReadAsync()', 'old.Owner.Close()',
             'DropToEmptyUntilPublish', 'snapshot.WithoutAllArticles()', 'Ledger.ReviseLimits(',
             'DisposeUnpublishedHostOwnership()']:
    assert hook in new_tests, hook
project = (root / 'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'src\\backend\\FsusBlog.Server.csproj' in project and '<TargetFramework>net10.0</TargetFramework>' in project
policy = (root / 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSnapshotOwnershipPolicy.cs').read_text()
for hook in ['MemoryGovernorBaselineBinding?', 'PublicHotReadSnapshotOwnershipLimits?',
             'captured != frozenLimits', 'MemoryResourceUnit.Bytes', 'MemoryResourceUnit.OperationSlots',
             '_ledger.TryReserveUnderBounds(', 'accounting.EnforcedHardCaps',
             'MetadataUpperBoundBytes + MetadataHeadroomBytes', 'held.Dispose();', 'released();']:
    assert hook in policy, hook
assert all(term not in policy for term in ['Guid.NewGuid', 'CreateVerified', 'NativeMemory', 'Task.Run', 'MemoryCapabilityMode.Disabled', 'new MemoryReservationCoordinator'])
store = (root / 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadStore.HostOwnership.cs').read_text()
assert store.index('policy.TryReserve(') < store.index('snapshot.WithHostReadLeases(')
for hook in ['_pendingSnapshotOwnershipPolicy is not null', '_snapshotOwnershipAdmissions > 0',
             '--_snapshotOwnershipAdmissions == 0', 'policy.Baseline.EvidenceDigest == previous.Baseline.EvidenceDigest',
             'ReleaseSnapshotOwnershipAdmission', 'admission.DisposeUntransferred()']:
    assert hook in store, hook
group = (root / 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSnapshot.HostOwnership.cs').read_text()
assert 'ownership.TryRetain(consumer: true)' in group
assert 'admission.Policy.MaximumConsumers' in group and 'admission.Policy.MaximumSnapshots' in group
assert group.index('DisposeAll(release);', group.index('private void Release(')) < group.index('_admission?.Dispose();', group.index('private void Release('))
bootstrap = (root / 'src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs').read_text()
assert 'services.Configure<PublicHotReadOptions>(configuration.GetSection("PublicHotRead"));' in bootstrap
for path in ['src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs',
             'src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs',
             'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs',
             'tests/backend/Unit/OwnedPublicHotReadSnapshotTests.cs']:
    assert subprocess.check_output(['git', 'show', baseline + ':' + path]) == (root / path).read_bytes()
contract = json.loads((root / 'config/application/backend-configuration-contract.json').read_text())
rows = [r for r in contract['applicationSettings'] if r['key'].startswith('PublicHotRead:SnapshotOwnership:')]
assert not rows
handoff = json.loads((out / 'snapshot-ownership-registration.json').read_text())
assert len(handoff['rows']) == 12 and all(r['owner'] == 'public-delivery' and r['runtimeOnly'] and r['requiredStatus'] == 'conditional' for r in handoff['rows'])
assert hashlib.sha256((out / 'snapshot-ownership-registration.patch').read_bytes()).hexdigest() == handoff['patchSha256']
subprocess.run(['git', 'apply', '--check', str(out / 'snapshot-ownership-registration.patch')], check=True)
assert json.loads((out / 'configuration-delta.json').read_text())['introducedErrors'] == []
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
assert not subprocess.check_output(['git', 'status', '--porcelain'], text=True).strip()
changed = subprocess.check_output(['git', 'diff', '--name-only', baseline, sha], text=True).splitlines()
assert len(changed) == 6 and all('Infrastructure/Memory/' not in p for p in changed)
assert os.environ['FSUSBLOG_DATA_ROOT'] == str(out / 'data')
prior = json.loads((root / 'artifacts/memory/control-delivery/de0adc1a5/preflight.json').read_text())
assert not allow.intersection(prior['positiveFqnAllowlist'])
filter_value = '(' + '|'.join('FullyQualifiedName=' + f for f in sorted(allow)) + ')&Category!=Integration&Fixture!=LocalRedis'
record = {'sourceSha': sha, 'runId': 'ordinary-snapshot-policy-' + str(uuid.uuid4()),
          'startedUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'gitTreeSha256': hashlib.sha256(subprocess.check_output(['git', 'ls-tree', '-r', sha])).hexdigest(),
          'expectedCases': expected, 'positiveFqnAllowlist': sorted(allow), 'filter': filter_value,
          'selectionVerifiedBeforeAnyTestCommand': True, 'sdk': '10.0.401', 'dataRoot': str(out / 'data'),
          'prior29NotRerunAsAWhole': True, 'affectedLegacyCases': 6,
          'prior21AndNonce14NotRerun': True, 'commands': []}

def run(command, log):
    record['commands'].append(command)
    with (out / log).open('w') as output:
        result = subprocess.run(command, stdout=output, stderr=subprocess.STDOUT)
    record[log + '.exit'] = result.returncode
    (out / 'preflight.json').write_text(json.dumps(record, indent=2) + '\n')
    if result.returncode:
        text = (out / log).read_text()
        print('\n'.join(line for line in text.splitlines() if ': error ' in line or 'Failed ' in line)[-4000:])
        print('\n'.join(text.splitlines()[-12:])); sys.exit(result.returncode)

base = ['dotnet', 'test', 'tests/backend/FsusBlog.Server.Tests.csproj', '--no-restore', '--filter', filter_value]
run(base + ['--list-tests'], 'list-tests.log')
listed = [s.strip() for s in (out / 'list-tests.log').read_text().splitlines() if s.strip().startswith('FsusBlog.Server.Tests.Unit.')]
assert len(listed) == expected and len(set(listed)) == expected and {s.split('(')[0].strip() for s in listed} == allow, (len(listed), listed)
record['discoveredCases'] = listed; record['listSelectionVerifiedBeforeExecution'] = True
(out / 'preflight.json').write_text(json.dumps(record, indent=2) + '\n')
run(base + ['--no-build', '--results-directory', str(out), '--logger', 'trx;LogFileName=selected.trx'], 'selected.log')
results = ET.parse(out / 'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results) == expected and all(r.attrib['outcome'] == 'Passed' for r in results), [(r.attrib['testName'], r.attrib['outcome']) for r in results]
record['passedCases'] = expected; record['completedUtc'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
(out / 'preflight.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps({'sourceSha': sha, 'passed': expected, 'runId': record['runId'],
                  'selectionVerifiedBeforeExecution': True, 'prior29NotRerunAsAWhole': True,
                  'prior21AndNonce14NotRerun': True}))
