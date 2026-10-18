import hashlib, json, pathlib, re, subprocess, sys, xml.etree.ElementTree as ET
root = pathlib.Path.cwd()
out = root / '.tmp/memory/reserved-aeds-cancel-20261009'
classes = {
'ReservedAedsFrameWriterTests': ['GetMemoryAndSpan_RejectNegativeSizeHint', 'Advance_RejectsNegativeAndOverRemainingCount', 'GetMemoryAndSpan_RejectHintsBeyondRemainingCapacity', 'GetMemoryAndSpan_RejectEmptyAndExhaustedDestinations', 'Writer_UsesOnlyCallerSliceAndAdvancesWriteBoundary', 'GetFrameLength_RejectsNegativeAndCheckedOverflow', 'GetFrameLength_EnforcesConfiguredAndDefaultArtifactCeiling', 'WriteFrame_RejectsInsufficientStorageAndArtifactCeilingBeforeWriting', 'WriteFrame_MatchesCanonicalEncodeAndPreservesOutsideBytes', 'WriteFrame_EmptyPayloadMatchesCanonicalEncodeAtExactCapacity'],
'ReservedAedsTransientCompositionTests': ['CanonicalBytesBorrowTheOperationLeaseAndRejectAccessAfterCompletion', 'CanceledOuterWaitKeepsTheEncodedFrameChargedUntilConsumerCompletion', 'ConsumerFailureReleasesOnlyItsOperationHold', 'UndersizedLeaseRejectsBeforeWritingOrInvokingConsumer', 'ArtifactCeilingRejectsBeforeWritingOrInvokingConsumer', 'PreCanceledOperationRejectsBeforeWritingOrRetaining', 'AliasedPayloadRejectsBeforeMutatingTheSource', 'RepeatedFailureAndSuccessReuseOnlyClearedChargedBacking', 'ExhaustedHoldBudgetRejectsBeforeEncoding', 'CancellationDuringCanonicalEncodingPreventsConsumerDeliveryAndReleasesTheOperationHold']
}
expected = 21
allow = {f'FsusBlog.Server.Tests.Unit.{c}.{m}' for c, methods in classes.items() for m in methods}
assert len(allow) == 20 and expected == 21
for c, methods in classes.items():
    source = (root / f'tests/backend/Unit/{c}.cs').read_text()
    assert 'using FsusBlog.Server.Infrastructure.PublicReadArtifacts;' in source
    actual = set(re.findall(r'^    public (?:async )?(?:Task|void) (\w+)\(', source, re.M))
    assert actual == set(methods), (c, actual)
    assert '[Trait(' not in source and 'Skip =' not in source
composition = (root / 'tests/backend/Unit/ReservedAedsTransientCompositionTests.cs').read_text()
assert 'TransientMemoryTestLedger.Create' in composition and 'TransientBufferPool(' in composition
assert 'PublicHotReadBinaryArtifactFactory.ConsumeReservedPayloadAsync(' in composition
factory = (root / 'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs').read_text()
assert 'return destination.ConsumeAsync(' in factory and 'ReservedAedsFrameWriter.WriteFrame(' in factory
writer = (root / 'src/backend/Infrastructure/PublicReadArtifacts/ReservedAedsFrameWriter.cs').read_text()
assert 'encoder.WriteFrame(frameType, payload, writer, version, flags);' in writer
project = (root / 'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'Unit/' not in project and 'Unit\\' not in project
filter_value = '(FullyQualifiedName~FsusBlog.Server.Tests.Unit.ReservedAedsFrameWriterTests|FullyQualifiedName~FsusBlog.Server.Tests.Unit.ReservedAedsTransientCompositionTests)&Category!=Integration&Fixture!=LocalRedis'
assert filter_value and 'FullyQualifiedName~' in filter_value
base = ['dotnet', 'test', 'tests/backend/FsusBlog.Server.Tests.csproj', '--no-restore', '--filter', filter_value]
record = {'sourceSha': subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'expectedCases': expected, 'positiveFqnAllowlist': sorted(allow), 'filter': filter_value, 'actualImportsAndHooksVerified': True, 'dataRoot': __import__('os').environ['FSUSBLOG_DATA_ROOT'], 'commands': []}
def run(command, log):
    record['commands'].append(command)
    with (out / log).open('w') as stream:
        result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
    record[log + '.exit'] = result.returncode
    (out / 'preflight.json').write_text(json.dumps(record, indent=2)+'\n')
    if result.returncode:
        print(f'{log}: exit {result.returncode}; stop before dependent execution')
        sys.exit(result.returncode)
run(base + ['--list-tests'], 'list-tests.log')
listed = [line.strip() for line in (out / 'list-tests.log').read_text().splitlines() if line.strip().startswith('FsusBlog.Server.Tests.Unit.')]
selected_methods = [line.split('(')[0].strip() for line in listed]
assert len(listed) == expected, (len(listed), expected)
assert set(selected_methods) == allow, set(selected_methods).symmetric_difference(allow)
assert len(set(listed)) == expected
record['discoveredCases'] = listed
record['listSelectionVerifiedBeforeExecution'] = True
(out / 'preflight.json').write_text(json.dumps(record, indent=2)+'\n')
run(base + ['--no-build', '--results-directory', str(out), '--logger', 'trx;LogFileName=selected.trx'], 'selected.log')
tree = ET.parse(out / 'selected.trx')
ns = {'t':'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
results = tree.findall('.//t:UnitTestResult',ns)
assert len(results) == expected and all(r.attrib['outcome'] == 'Passed' for r in results)
record['passedCases'] = expected
(out / 'preflight.json').write_text(json.dumps(record, indent=2)+'\n')
print(json.dumps({'sourceSha': record['sourceSha'], 'cases': expected, 'passed': len(results), 'listSelectionVerifiedBeforeExecution': True}))
