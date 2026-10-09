# Exact29 positive Server selection: no execution

Candidate: c4bfd8dca103cb59f41f58a2e9618b2e3650073e

Expected selected xUnit cases:29; actual executed:0; aggregate invoked:false.

Original entry: `node tools/run-test-matrix.mjs run backend-unit --fresh --max-parallel 1`

Methods (newFreezerMethods):
- RepeatedExactAdmission_KeepsCanonicalIdsAndDigests
- CompleteFacts_CreateOwnedQueuedTaskThroughClosedCatalog
- PersistedOwnerCoordinateOrSealDrift_IsRejected
- RevokedPermissionBeforeReturn_RejectsFrozenAdmission
- CancelledAdmission_ReadsNoSourceOrPermission
- OversizedSource_IsRejectedBeforeFrozenAdmission
- MissingRealAuthority_RegistersNoTransportOrJobs
- ExplicitComposition_UsesSoleJobImplementationAndRejectsDuplicates
- MissingRouteAuthorities_MapsNoExportEndpoints

Methods (httpAuthorizationMethods):
- CurrentOriginalProjection_IsReadFreshForEachOperation
- UnboundContext_ReadsNoOriginalPermission
- ChangedOrDeniedProjection_IsRejected

PersistedOwnerCoordinateOrSealDrift_IsRejected:
- "owner"
- "site"
- "coordinate"
- "seal"

FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization:
- "UserLoginRequest"
- "999"
- "documentexportrequest"
- "DocumentExportRequest "

FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses:
- "DocumentExportRequest"
- "DocumentExportTaskRequest"
- "DocumentExportJobResponse"
- "DocumentExportPageResponse"

UnboundContext_ReadsNoOriginalPermission:
- "missing-context"
- "principal"
- "session"

ChangedOrDeniedProjection_IsRejected:
- "stale"
- "owner"
- "seal"
- "article"
- "decision"

Exact FQN filter:
```text
FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.RepeatedExactAdmission_KeepsCanonicalIdsAndDigests|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.CompleteFacts_CreateOwnedQueuedTaskThroughClosedCatalog|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.PersistedOwnerCoordinateOrSealDrift_IsRejected|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.RevokedPermissionBeforeReturn_RejectsFrozenAdmission|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.CancelledAdmission_ReadsNoSourceOrPermission|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.OversizedSource_IsRejectedBeforeFrozenAdmission|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.MissingRealAuthority_RegistersNoTransportOrJobs|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.ExplicitComposition_UsesSoleJobImplementationAndRejectsDuplicates|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.MissingRouteAuthorities_MapsNoExportEndpoints|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.CurrentOriginalProjection_IsReadFreshForEachOperation|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.UnboundContext_ReadsNoOriginalPermission|FullyQualifiedName=FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.ChangedOrDeniedProjection_IsRejected
```

Original offending path/call:
- tests/matrix.yml:2724 (backend-build-governance dependency)
- tools/test/lanes/_suite-support.sh:1232 (Server filter platform plan)
- tools/test/lanes/_suite-support.sh:1244 (unconditional migration execution)
- tools/test/run-migration-tests.mjs:92 (whole assembly execution, no filter)

RunBackendUnitLane forwards the selected filter to Server tests but then unconditionally invokes run-migration-tests.mjs --backend-unit, whose execution plan runs the whole independent migration assembly without a test filter. Those cases/MySQL fixture are not within the29-case positive list or this source-composition scope. Aggregate remains blocked under the corrected execution rule.

Canonical entry/resource owners supply an admitted original Server-only selective entry covering these exact29 cases, or explicit permitted aggregate case identities, expected count and isolated MySQL admission. Do not call dotnet test/vstest/testhost or repackage the lane to evade its gates.

Exported verbatim scope from existing preflight; no tests, lane, Migration or alternate harness rerun.

Actual original call, tools/test/lanes/_suite-support.sh:1244:
```sh
Run "$BUILD_ENV_RUNNER" "${FSUSBLOG_NODE:-node}" "$ROOT_DIR/tools/test/run-migration-tests.mjs" --backend-unit
```

The following migration execution plan uses the complete assembly without a test filter:
```js
        assemblyFile: artifacts.migrationTestDll,
        commands: {
            sdk: ['--version'],
            sdkPaths: ['--list-sdks'],
            inventory: [artifacts.xunitAdapterDll, options.root, path.join(options.root, project), '--configuration', 'Release'],
            discovery: ['vstest', artifacts.migrationTestDll, '--ListTests', `--Diag:${path.join(paths.directory, 'discovery/union.txt')}`],
            execution: ['vstest', artifacts.migrationTestDll, '--logger:trx;LogFileName=migration.trx',
                `--ResultsDirectory:${path.join(paths.directory, 'execution')}`]
        }
    };
}

function sourceOwner(root)
{
```

Complete29-case positive expansion (display arguments are exact):

1. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.RepeatedExactAdmission_KeepsCanonicalIdsAndDigests`
2. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.CompleteFacts_CreateOwnedQueuedTaskThroughClosedCatalog`
3. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.PersistedOwnerCoordinateOrSealDrift_IsRejected("owner")`
4. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.PersistedOwnerCoordinateOrSealDrift_IsRejected("site")`
5. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.PersistedOwnerCoordinateOrSealDrift_IsRejected("coordinate")`
6. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.PersistedOwnerCoordinateOrSealDrift_IsRejected("seal")`
7. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.RevokedPermissionBeforeReturn_RejectsFrozenAdmission`
8. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.CancelledAdmission_ReadsNoSourceOrPermission`
9. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.OversizedSource_IsRejectedBeforeFrozenAdmission`
10. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.MissingRealAuthority_RegistersNoTransportOrJobs`
11. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.ExplicitComposition_UsesSoleJobImplementationAndRejectsDuplicates`
12. `FsusBlog.Server.Tests.Unit.DocumentExportRequestFreezerTests.MissingRouteAuthorities_MapsNoExportEndpoints`
13. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization("UserLoginRequest")`
14. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization("999")`
15. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization("documentexportrequest")`
16. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_RejectsOtherFamiliesNumericAliasesAndNormalization("DocumentExportRequest ")`
17. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses("DocumentExportRequest")`
18. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses("DocumentExportTaskRequest")`
19. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses("DocumentExportJobResponse")`
20. `FsusBlog.Server.Tests.Unit.DocumentExportEndpointBindingTests.FrameResolver_ConsumesOnlyTheExactSharedRegistrationOrRefuses("DocumentExportPageResponse")`
21. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.CurrentOriginalProjection_IsReadFreshForEachOperation`
22. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.UnboundContext_ReadsNoOriginalPermission("missing-context")`
23. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.UnboundContext_ReadsNoOriginalPermission("principal")`
24. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.UnboundContext_ReadsNoOriginalPermission("session")`
25. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.ChangedOrDeniedProjection_IsRejected("stale")`
26. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.ChangedOrDeniedProjection_IsRejected("owner")`
27. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.ChangedOrDeniedProjection_IsRejected("seal")`
28. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.ChangedOrDeniedProjection_IsRejected("article")`
29. `FsusBlog.Server.Tests.Unit.DocumentExportHttpJobAuthorizationTests.ChangedOrDeniedProjection_IsRejected("decision")`
