import json, pathlib, re, subprocess, sys, xml.etree.ElementTree as ET, os
root = pathlib.Path.cwd()
out = root / '.tmp/memory/platform-composition-20261009'
classes = {
'MacOsSysctlMemoryReaderTests': ['ManagedLayoutMatchesPinnedXnuFieldWidthsWithoutNativeQualification','PhysicalMappingKeepsBytesZeroAndCheckedSignedBoundary','SwapMappingPreservesByteOccupancyAndSuccessfulNoSwapZeros','WrongReturnedLengthsAndInvalidSwapFieldsNeverBecomeFacts','NativeErrorsOverrideBufferContentsAndKeepUnavailableDistinctFromDenied','DisabledClearsOldFactsWithoutNativeOrClockCallsAndLeavesTailOwnedByCaller','InvalidStorageOrModeRefusesCaptureAndClearsAdmittedRows','ActualLinuxHostRefusesAutoAndRequiredWithoutMacOsNativeExecution'],
'WindowsCurrentJobMemoryReaderTests': ['Managed64BitLayoutMatchesPinnedDeclarationsWithoutNativeQualification','ExtendedLimitsUseIndependentFlagsAndPeaksRetainTheirDocumentedScopes','NotificationUsageRequiresViolationFlagAndLimitRequiresItsOwnFlag','FlagQualifiedZeroDiffersFromMissingAndIgnoredGarbageCannotOverflow','CheckedNativeConversionsKeepLongBoundaryAndRejectOverflowPerField','QueryFailuresRetainErrorsAndNeverConvertFailedNativeBuffers','PartialOrOversizedNativeResultsAreMalformedAndIndependentQueriesStayIndependent','DisabledAndInvalidArgumentsClearOldValuesBeforeClockOrNativeCalls','UnsupportedHostRefusesAutoAndRequiredBeforeClockOrNativeCalls','ObservationWindowRetainsQueryTimeAndRejectsDiscontinuity'],
'PlatformMemoryPressureCompositionTests': ['ActualLinuxCallerRetainsUnsupportedRawRowsWithoutNativeOrClockCalls','DisabledClearsOldFactsThroughBothReadersAndLeavesCallerTailsAlone','InvalidAdmissionShapeOrPolicyClearsBothOwnedPrefixesBeforeAnyProbe','OmittedModeIsAutoAndRawRowsCannotEnterComparablePortableHistory'],
'PortableMemoryPressureTests': ['UnavailableNeverBecomesZeroOrRate','CounterResetAndReleasedCapacityHaveDifferentMeanings','ActiveDomainRevisionRejectsEvenTwoInternallyConsistentOldSamples','StaleAndDiscontinuousClocksNeverSupplyGrowth','LastGcSnapshotCannotMasqueradeAsInstantaneousUsageRate','ReplayPreservesStepsBurstsOscillationAndExactNegativeGrowth','LivePortableCaptureUsesRealApiProvenanceAndBoundedRetention','DomainInvalidationDuringRealCaptureRefusesOldHistory','UnitsScopesAndDifferentMeasurementMeaningsCannotBeSubstituted']
}
expected = 34
allow = {f'FsusBlog.Server.Tests.Unit.{c}.{m}' for c, methods in classes.items() for m in methods}
assert expected == 34 and len(allow) == 31
for c, methods in classes.items():
    source = (root / f'tests/backend/Unit/{c}.cs').read_text()
    actual = set(re.findall(r'^    public (?:async )?(?:Task|void) (\w+)\(', source, re.M))
    assert actual == set(methods), (c,actual.symmetric_difference(methods))
    assert 'Skip =' not in source and '"Integration"' not in source and '"LocalRedis"' not in source
composition = (root / 'tests/backend/Unit/PlatformMemoryPressureCompositionTests.cs').read_text()
assert 'using FsusBlog.Server.Infrastructure.Memory.Platform;' in composition
assert 'using FsusBlog.Server.Infrastructure.Memory.Pressure;' in composition
assert 'source.CapturePlatformObservations(' in composition
pressure = (root / 'src/backend/Infrastructure/Memory/Pressure/PortableMemoryPressureSource.cs').read_text()
assert 'MacOsSysctlMemoryReader.Capture(_clock, macOsOutput, mode)' in pressure
assert 'WindowsCurrentJobMemoryReader.Capture(_clock, maximumJobCaptureDuration, windowsJobOutput, mode)' in pressure
project = (root / 'tests/backend/FsusBlog.Server.Tests.csproj').read_text()
assert 'Unit/' not in project and 'Unit\\' not in project
assert sys.platform == 'linux'
filter_value = '(FullyQualifiedName~FsusBlog.Server.Tests.Unit.MacOsSysctlMemoryReaderTests|FullyQualifiedName~FsusBlog.Server.Tests.Unit.WindowsCurrentJobMemoryReaderTests|FullyQualifiedName~FsusBlog.Server.Tests.Unit.PlatformMemoryPressureCompositionTests|FullyQualifiedName~FsusBlog.Server.Tests.Unit.PortableMemoryPressureTests)&Category!=Integration&Fixture!=LocalRedis'
assert filter_value and 'FullyQualifiedName~' in filter_value
base = ['dotnet', 'test', 'tests/backend/FsusBlog.Server.Tests.csproj', '--no-restore', '--filter', filter_value]
record = {'sourceSha': subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(), 'expectedCases': expected, 'positiveFqnAllowlist': sorted(allow), 'filter': filter_value, 'actualImportsAndHooksVerified': True, 'dataRoot': os.environ['FSUSBLOG_DATA_ROOT'], 'commands': []}
def run(command, log):
    record['commands'].append(command)
    with (out / log).open('w') as stream:
        result = subprocess.run(command, stdout=stream, stderr=subprocess.STDOUT)
    record[log + '.exit'] = result.returncode
    (out / 'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
    if result.returncode:
        print(f'{log}: exit {result.returncode}; stop before dependent execution')
        sys.exit(result.returncode)
run(base + ['--list-tests'], 'list-tests.log')
listed = [line.strip() for line in (out / 'list-tests.log').read_text().splitlines() if line.strip().startswith('FsusBlog.Server.Tests.Unit.')]
selected_methods = [line.split('(')[0].strip() for line in listed]
assert len(listed) == expected, (len(listed),expected)
assert set(selected_methods) == allow, set(selected_methods).symmetric_difference(allow)
assert len(set(listed)) == expected
record['discoveredCases'] = listed
record['listSelectionVerifiedBeforeExecution'] = True
(out / 'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
run(base + ['--no-build','--results-directory',str(out),'--logger','trx;LogFileName=selected.trx'], 'selected.log')
tree = ET.parse(out / 'selected.trx')
results = tree.findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results) == expected and all(r.attrib['outcome'] == 'Passed' for r in results)
record['passedCases'] = expected
(out / 'preflight.json').write_text(json.dumps(record,indent=2)+'\n')
print(json.dumps({'sourceSha':record['sourceSha'],'cases':expected,'passed':len(results),'listSelectionVerifiedBeforeExecution':True}))
