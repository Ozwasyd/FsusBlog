import copy, datetime, hashlib, json, pathlib, shutil, subprocess, xml.etree.ElementTree as ET
root=pathlib.Path.cwd(); source='de0adc1a5ed4a32f5cdfc01b9c560f9b357cd250'; baseline='68063a7a31f688c0f8857e8eeaeca53e767ea393'
work=root/'.tmp/memory/host-frame-20261009'; out=root/'artifacts/memory/control-delivery/de0adc1a5'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==source
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
pre=json.loads((work/'preflight.json').read_text())
assert pre['sourceSha']==source and pre['passedCases']==21 and pre['listSelectionVerifiedBeforeExecution']
assert pre['list-tests.log.exit']==0 and pre['selected.log.exit']==0
results=ET.parse(work/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results)==21 and all(r.attrib['outcome']=='Passed' for r in results)
assert 'files=3 violations=0 new=0' in (work/'style.log').read_text()
assert not json.loads((work/'code-intent.json').read_text())['errors']
out.mkdir(exist_ok=False)
files=['run-selected.py','preflight.json','list-tests.log','selected.log','selected.trx','style.log','change-contract.log','document-lifecycle.log','code-intent.json','dotnet-info.txt','uname.txt','issue3445.json','issue3451.json','issue3454.json','issue3456.json']
for name in files: shutil.copyfile(work/name,out/name)
shutil.copytree(work/'attempt-0ecb2a98c',out/'attempt-0ecb2a98c')
paths=[
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs',
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs',
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.cs',
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Routing.cs',
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadStore.Runtime.cs',
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSanity.cs',
'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadResidency.cs',
'src/backend/Infrastructure/Memory/Contracts/MemoryHostAccess.cs',
'src/backend/Infrastructure/Memory/Contracts/MemoryOperationResult.cs',
'src/backend/Infrastructure/Memory/Lifetime/ManagedMemoryBacking.cs',
'src/backend/Infrastructure/Memory/Host/NativeMemoryArena.cs',
'src/backend/Infrastructure/Memory/Host/NativeMemoryBlock.cs',
'src/backend/Infrastructure/Memory/Accounting/MemoryReservationCoordinator.cs',
'tests/backend/Unit/PublicBinaryHostFrameTests.cs',
'tests/backend/Unit/PublicHotReadFastPathTests.cs',
'tests/backend/FsusBlog.Server.Tests.csproj',
'src/backend/Infrastructure/PublicReadArtifacts/ReservedAedsFrameWriter.cs',
'tests/backend/Unit/ReservedAedsFrameWriterTests.cs',
'src/backend/Infrastructure/PublicAot/ReservedCspNonceScratchWriter.cs',
'tests/backend/Unit/ReservedCspNonceScratchWriterTests.cs',
'docs/architecture/repository-layout.md',
'tests/backend/obj/project.assets.json','src/backend/obj/project.assets.json',
'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll',
'tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll',
'tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.dll',
'tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.pdb','global.json']
paths=[p for p in paths if (root/p).is_file()]
bindings=[]
for name in paths:
 p=root/name; bindings.append({'path':name,'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
assert (root/'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll').read_bytes()==(root/'tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll').read_bytes()
(out/'bindings.json').write_text(json.dumps(bindings,indent=2)+'\n')
changed=subprocess.check_output(['git','diff','--name-only',baseline,source],text=True).splitlines()
assert set(changed)=={'docs/architecture/repository-layout.md','src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs','src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs','tests/backend/Unit/PublicBinaryHostFrameTests.cs'}
serving='src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs'
before=subprocess.check_output(['git','show',baseline+':'+serving],text=True); after=(root/serving).read_text()
assert after==before.replace('    private static Task WriteBinaryFrame(', '    internal static Task WriteBinaryFrame(',1)
unchanged=[p for p in paths if p.startswith('src/backend/Infrastructure/Memory/') or 'Reserved' in p or p.endswith('PublicHotReadFastPathTests.cs')]
for name in unchanged: assert subprocess.check_output(['git','show',baseline+':'+name])==(root/name).read_bytes()
prior=json.loads((root/'artifacts/memory/control-delivery/ab2c589d0/checkpoint.json').read_text())
issues=copy.deepcopy(prior['issues'])
for row in issues:
 assert row['wholeIssueAcceptance']=='NotAccepted'
 for criterion in row.get('criteria',[]): assert criterion['acceptance']=='NotAccepted'
 if row['issue']==3456:
  row['currentRun']='21/21 ordinary selected controls at '+source+': 16 new managed host-frame cases and five original response regressions. Prior nonce 14/14 remains bound to ab2c589d02fabfa6ed15967f0e58800d2555398a and was not rerun.'
  row['remainingGate']='No long-lived snapshot ownership/location-to-source/role binding or qualified production caller. Native compressed/HTML/transport differential, original qualified publication/revocation flow, backing-aware statistics, finite P01 gates and accepted P01/P05/Auto remain incomplete. Nonce serving still lacks admitted scratch/pool/budget binding. No whole-issue acceptance.'
 elif row['issue']==3459:
  row['currentRun']='This increment shares span-based identity validation/ETag between the original array factory and explicit host lease adapter. Prior known-payload 21/21 remains at e55917ac097e33589766e8b20ab42fabbc51a5b5, not rerun.'
  row['remainingGate']='PublicBinaryArtifact remains a non-owning value; long-lived snapshot transfer/retirement is absent. FromWriter still owns its existing array materialization and compression remains unbounded. Unknown-length sizing, simultaneous source/destination/workspace admission, shared-block publication and frozen performance gates remain incomplete.'
 else:
  row['currentRun']='No new acceptance run in this increment; prior evidence is retained at its original commit. '+row['currentRun']
notes={
'AC01':'NotRun: no qualified native host/Auto production selection or new production activation.',
'AC02':'Partial ordinary managed identity-byte/status/header and original integrity parity only; native/compressed/HTML differential absent. Prior nonce result not rerun.',
'AC03':'Partial managed existing read lease retained through real original Pipe backpressure and consumer completion; no native T10/T11 qualification or held lease audit.',
'AC04':'Partial ordinary managed MemoryManager with no exposed backing array reaches original response successfully. No adapter ToArray; native copy/capacity trace is not qualified.',
'AC05':'NotRun: no full L0 forbidden-operation-hook product proof.',
'AC06':'No new nonce work; 14/14 remains bound to ab2c589d02fabfa6ed15967f0e58800d2555398a.',
'AC07':'NotRun: original production residency projection unchanged; native/deduplicated generation accounting incomplete.',
'AC08':'NotRun: complete qualified route/revocation/stickiness differential remains held. Routing/security/publication source unchanged.',
'AC09':'Blocked: comparable finite frozen P01 performance gates are not supplied or accepted; no speedup claimed.',
'AC10':'NotRun: production Auto/disable/drain integration not activated.'}
record={'schema':'fsusblog.memory.host-frame-ordinary-checkpoint.v1','runId':pre['runId'],'generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),
'sourceHead':source,'sourceTree':subprocess.check_output(['git','rev-parse',source+'^{tree}'],text=True).strip(),'sourceIncrement':'0ecb2a98c62b9ed79a34b202da80f96ce6dcef53','fixtureCompileRepair':source,
'branch':'codex/mem-3444-compliant-integration','verifiedOriginMaster':'57886f75213bd22c0dd3a8e2586073bdbdd97778','masterIncorporated':False,
'changedFiles':changed,'heldSourceFilesUnchanged':unchanged,'servingExecutableBodyUnchanged':True,'productionAutoActivated':False,
'ordinaryBuild':{'sdk':'10.0.401','restoreOrAuditPerformed':False,'warningLines':sum(': warning ' in line for line in (work/'list-tests.log').read_text().splitlines()),'errorLines':sum(': error ' in line for line in (work/'list-tests.log').read_text().splitlines()),'fullSourceStageRun':False},
'passedCases':21,'failedCases':0,'skippedCases':0,'positiveMethods':16,'newManagedCases':16,'originalAffectedCases':5,
'earlierStyleInvocationFailure':{'phase':'two scoped Node style invocations without activated SDK PATH','exit':1,'error':"Cannot read properties of undefined (reading 'trim')",'resolution':'Activated the existing official /workspace/.setup/activate.sh profile before the successful scoped style invocation; no source rule changed and no test was rerun'},
'failedEarlierAttempt':{'source':'0ecb2a98c62b9ed79a34b202da80f96ce6dcef53','phase':'original project list/build','exit':1,'error':'CS1503: out _ bound to CancellationToken lambda parameter; corrected parameter name','testExecutionStarted':False,'artifacts':'attempt-0ecb2a98c/'},
'implementation':'ConsumeHostFrameAsync acquires the supplied IMemoryHostViewSource original read lease; frame remains original ReadOnlyMemory in existing PublicBinaryArtifact. Awaiting callback controls disposal. FromFrame now shares span validation and ETag with array callers; their compression algorithm is unchanged. Precompression requests reject UnsupportedCapability before acquisition. WriteBinaryFrame only changes private to internal, with executable body unchanged.',
'contract':'Source is already CPU readable with no disk/driver/mapping/probe side effects and immutable until final consumption; callback must finish every consumer and may not publish/retain borrowed artifact. Source supplies real read-hold accounting/limits; caller supplies admission for additional work. No operation-slot reservation is invented.',
'essentialProductionGap':{'currentArtifact':'PublicHotReadFastPath.cs:100 PublicBinaryArtifact(ReadOnlyMemory<byte> Frame, ...), no owning body/source/location token',
'currentSnapshot':'PublicHotReadFastPath.cs:321 PublicHotReadSnapshot(... FrozenDictionary<int,PublicBinaryArtifact> articleFramesById, ...), no source-location/role ownership input',
'currentPublisher':'PublicHotReadFastPath.cs:906 PublicHotReadStore.Publish(PublicHotReadSnapshot next) remains sole authority; its existing retirement is WeakReference tracking in PublicHotReadStore.Runtime.cs:195/227',
'availableProducers':['MemoryHostAccess.cs:53 IMemoryHostViewSource.TryAcquireHostView(MemoryLocationToken expectedLocation)','ManagedMemoryBacking.cs:144 TryRetainRole(expectedLocation, MemoryRoleKind)','NativeMemoryArena.cs:50 NativeMemorySlice.TryRetainRole(expectedLocation, MemoryRoleKind)'],
'requiredOwner':'Retained original PublicHotReadSnapshot/PublicHotReadStore publication and retirement owner must bind qualified artifact representations to actual source/location/role holds, preserve current/last-good/sticky/overlay semantics, and release only after actual consumers stop. This callback adapter is deliberately not long-lived transfer or publication.'},
'P06Criteria':{'MEM-P06-'+k:{'acceptance':'NotAccepted','currentEvidence':v} for k,v in notes.items()},'issues':issues,'acceptedIssues':0,'criteriaAccepted':0,
'checks':[{'command':'node tools/dotnet/check-csharp-style.mjs --mode changed --file src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs --file src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs --file tests/backend/Unit/PublicBinaryHostFrameTests.cs','exit':0,'evidence':'style.log'},
{'command':'node tools/docs/generate-document-lifecycle.mjs --check','exit':0,'evidence':'document-lifecycle.log'},
{'command':'node tools/governance/check-change-contract.mjs --range '+baseline+'..'+source,'exit':0,'evidence':'change-contract.log'},
{'command':'scoped validateCommentPolicy and validateMarkerRegistration for three exact files','exit':0,'evidence':'code-intent.json'}],
'notRun':['unchanged nonce 14-case suite and other prior suites','native lease/race/alias/TOCTOU/receipt audits','full SOURCE stage and integrated/whole PR source/generated admission','native/compressed/HTML/backing statistics/Auto/production qualification','network delivery, performance or platform matrix','fresh restore/audit or dependency download','Docker, GPU, production DB, deploy, merge, issue closure, metadata writes or cross-chain conflict resolution']}
(out/'checkpoint.json').write_text(json.dumps(record,indent=2)+'\n')
md=f'''# Explicit host-frame ordinary source composition

Tested source: `{source}`; branch `codex/mem-3444-compliant-integration`.
Latest fetched origin/master: `57886f75213bd22c0dd3a8e2586073bdbdd97778`, not incorporated. Changes since the previous observed master are outside these four touched files. Current #3456 and P01/P05/Auto issue bodies/comments were reread; those prerequisites remain OPEN and whole-stage acceptance is not claimed.

The original factory now accepts a supplied IMemoryHostViewSource and expected MemoryLocationToken through ConsumeHostFrameAsync. It acquires the real read lease, creates the existing PublicBinaryArtifact with borrowed ReadOnlyMemory, and awaits the consumer before disposal. FromFrame has a common ReadOnlyMemory/span validation and ETag path; original array construction/compression wrappers remain active. The explicit adapter is identity-only: a precompression request rejects UnsupportedCapability before acquisition, with no ToArray, allocator, driver, hidden pool/budget or parallel publisher. Only original WriteBinaryFrame visibility changed to internal; its executable response body and all route/security/wire/publication authority remain unchanged.

21/21 ordinary controls passed, exit 0, no skip or extra case: 16 new managed cases plus five original response regressions. The positive nonempty 16-method allowlist, actual imports and owning API hooks were checked before discovery; the exact 21 discovered cases were verified before execution. Raw commands/results/TRX and source/tree/toolchain/assets/binary hashes are retained. The original project uses SDK 10.0.401 and existing assets; retained build warnings are not suppressed, and no fresh restore/audit is claimed. These logs are ordinary project discovery/build/test evidence, not raw SOURCE-stage logs or native qualification.

Managed observations cover canonical empty/multilingual frame bytes and original ETag/integrity parity; MemoryManager ROM with no exposed backing array; the original GET/HEAD/304/406 response bytes/status/headers; actual Pipe backpressure and outer wait cancellation while the read lease/physical charge remain live; actual request cancellation; exact consumer exception propagation; original stale-location and read-hold-budget rejections; invalid-frame/ceiling refusal and cleanup; pre-canceled/compression refusal before any acquisition; and repeated borrowing with one final allocation refund. Test initialization/oracle copies are fixture-only. No network-delivery, native copy trace or speedup is claimed.

The first source attempt `0ecb2a98c62b9ed79a34b202da80f96ce6dcef53` failed original discovery/build with CS1503 because out _ bound to the lambda CancellationToken parameter. No tests executed. The parameter-only repair at the tested SHA preserves the failed raw log and preflight under attempt-0ecb2a98c; the same explicit selection was checked again. The failure is not hidden or treated as a passing case.

Scoped C# style: three files, zero violations/new violations. Comment/marker, document lifecycle, whitespace and commit range checks passed. Full SOURCE/PR admission and held native/lease/race/alias/TOCTOU/receipt audits were not run. Unchanged nonce 14/14 remains bound to ab2c589d02fabfa6ed15967f0e58800d2555398a and was not rerun. Existing released supplier/Memory owner files remain unchanged.

The exact remaining production contract is in the original owner: PublicBinaryArtifact (PublicHotReadFastPath.cs:100) contains only non-owning ROM metadata; PublicHotReadSnapshot's constructor (line 321) accepts artifact dictionaries without source/location/role holds. PublicHotReadStore.Publish (line 906) remains the sole publisher; retirement uses WeakReference records in PublicHotReadStore.Runtime.cs:195/227. Available typed producers are IMemoryHostViewSource.TryAcquireHostView(expectedLocation), ManagedMemoryBacking.TryRetainRole(expectedLocation, MemoryRoleKind), and NativeMemorySlice.TryRetainRole(expectedLocation, MemoryRoleKind). The retained snapshot/store owner must attach actual qualified representation/source/location/role ownership and drain it under the established current/last-good/sticky/overlay rules. This increment does not create that production contract, grant native qualification, activate Auto or allow the callback artifact to escape. Compression workspace/admission, finite P01 gates and platform qualification remain unavailable. The original nonce serving overload remains active without real scratch admission inputs.

All criteria and whole issues remain NotAccepted. Component/ordinary evidence is contribution only.

| P06 criterion | Result and current evidence |
| --- | --- |
'''
for key,value in notes.items(): md+=f'| MEM-P06-{key} | NotAccepted. {value} |\n'
md+='\n| Owned issue | Current contribution | Remaining gate |\n| --- | --- | --- |\n'
for row in issues: md+=f"| #{row['issue']} | {row['currentRun']} | {row['remainingGate']} |\n"
(out/'checkpoint.md').write_text(md)
shutil.copyfile(__file__,out/'producer.py')
manifest={'schema':'fsusblog.memory.raw-artifact-manifest.v1','sourceHead':source,'runId':pre['runId'],'files':[]}
for p in sorted(out.rglob('*')):
 if p.is_file(): manifest['files'].append({'path':p.relative_to(out).as_posix(),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'artifactRoot':str(out),'hashedFiles':len(manifest['files']),'passedCases':21,'issues':len(issues),'acceptedIssues':0,'githubContentWritten':False}))
