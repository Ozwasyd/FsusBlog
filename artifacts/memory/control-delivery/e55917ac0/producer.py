import copy, datetime, hashlib, json, pathlib, shutil, subprocess, xml.etree.ElementTree as ET
root=pathlib.Path.cwd()
source_sha='e55917ac097e33589766e8b20ab42fabbc51a5b5'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==source_sha
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
out=root/'artifacts/memory/control-delivery/e55917ac0'
out.mkdir(parents=True,exist_ok=False)
runs=[('aeds-initial','reserved-aeds-composition-20261009','1b917080d4a0aad4ec52c837bf4625b1857608d6',20),('platform','platform-composition-20261009','69de9395d9855f7ccbac9105742a988311eab12d',34),('aeds-cancel','reserved-aeds-cancel-20261009',source_sha,21)]
run_records=[]
for label,folder,sha,count in runs:
    work=root/'.tmp/memory'/folder
    preflight=json.loads((work/'preflight.json').read_text())
    assert preflight['sourceSha']==sha and preflight['passedCases']==count and preflight['listSelectionVerifiedBeforeExecution']
    assert preflight['list-tests.log.exit']==0 and preflight['selected.log.exit']==0
    results=ET.parse(work/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
    assert len(results)==count and all(r.attrib['outcome']=='Passed' for r in results)
    target=out/label;target.mkdir()
    for name in ['run-selected.py','preflight.json','list-tests.log','selected.log','selected.trx']:
        shutil.copyfile(work/name,target/name)
    run_records.append({'label':label,'sourceSha':sha,'passed':count,'failed':0,'skipped':0,'selectionPreflight':label+'/preflight.json','trx':label+'/selected.trx'})
copy_files={
'platform-composition-20261009/official-style.log':'style-first-using-failure.log',
'reserved-aeds-cancel-20261009/official-style.log':'style-cancel-working-tree-whitespace-failure.log',
'reserved-aeds-cancel-20261009/official-style-final.log':'style-final.log',
'platform-composition-20261009/code-intent.log':'platform-code-intent.log',
'reserved-aeds-cancel-20261009/code-intent.log':'aeds-code-intent.log',
'reserved-aeds-cancel-20261009/change-contract.log':'change-contract.log',
'reserved-aeds-cancel-20261009/document-lifecycle.log':'document-lifecycle.log',
'platform-composition-20261009/component-bindings.json':'component-bindings.json',
'reserved-aeds-cancel-20261009/dotnet-info.txt':'dotnet-info.txt',
'reserved-aeds-cancel-20261009/uname.txt':'uname.txt',
'platform-composition-20261009/issue3450.json':'issue3450.json',
'platform-composition-20261009/issue3456.json':'issue3456.json'}
for source,name in copy_files.items():shutil.copyfile(root/'.tmp/memory'/source,out/name)
assert 'files=10 violations=0 new=0' in (out/'style-final.log').read_text()
assert not json.loads((out/'platform-code-intent.log').read_text())['errors']
assert not json.loads((out/'aeds-code-intent.log').read_text())['errors']
runtime={}
for path in ['src/backend/bin/Debug/net10.0/FsusBlog.Server.dll','tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll','tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.dll','tests/backend/bin/Debug/net10.0/FsusBlog.Core.dll','tests/backend/obj/project.assets.json','src/backend/obj/project.assets.json','tests/backend/packages.lock.json','src/backend/packages.lock.json']:
    p=root/path
    assert p.is_file(),path
    runtime[path]={'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
assert runtime['src/backend/bin/Debug/net10.0/FsusBlog.Server.dll']['sha256']==runtime['tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll']['sha256']
(out/'current-assembly-bindings.json').write_text(json.dumps({'sourceSha':source_sha,'observedAfter':'aeds-cancel selected test terminal success','files':runtime},indent=2)+'\n')
prior=json.loads((root/'artifacts/memory/control-delivery/80558c678/checkpoint.json').read_text())
issues=copy.deepcopy(prior['issues'])
for row in issues:
    row['wholeIssueAcceptance']='NotAccepted'
    row['currentRun']='NotRun; acceptance remains blocked'
    if row['issue']==3450:
        row['currentRun']='Partial source composition: 34/34 ordinary selected tests at 69de9395d9855f7ccbac9105742a988311eab12d'
        row['remainingGate']='Raw platform caller is implemented in PortableMemoryPressureSource.CapturePlatformObservations. Complete domain/ancestor/epoch and sampling provenance, actual v1/zram/Windows/macOS native rows, admitted metadata/probe costs, frozen P01/P02 bounds and canonical background/Auto/readiness remain unverified.'
    if row['issue']==3459:
        row['currentRun']='Partial known-payload composition: 21/21 ordinary selected tests at '+source_sha
        row['remainingGate']='Known-payload reserved writer and actual TransientBufferLease callback composition are implemented. PublicBinaryArtifact has no transferable body lease and FromFrame still requires byte[]. Unknown-length sizing, source/destination/workspace admission, compression budgets, shared-block publication and frozen performance gates remain incomplete.'
    if row['issue']==3456:
        row['remainingGate']+=' Concrete P06.4 nonce-scratch source slice identified; no adapter or product caller integration implemented in this run.'
platform_bindings=[]
for path in ['src/backend/Infrastructure/Memory/Pressure/PortableMemoryPressureSource.cs','tests/backend/Unit/PlatformMemoryPressureCompositionTests.cs']:
    original=subprocess.check_output(['git','show','69de9395d9855f7ccbac9105742a988311eab12d:'+path]);current=(root/path).read_bytes();assert original==current
    platform_bindings.append({'path':path,'testedSource':'69de9395d9855f7ccbac9105742a988311eab12d','unchangedAt':source_sha,'sha256':hashlib.sha256(current).hexdigest()})
ready='''# P06.4 bounded nonce scratch: source-ready proposal, unimplemented

Current owner: src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs.
CspNonceUtf8Template.GetRenderedLength(int nonceUtf8Length) performs checked sizing.
CspNonceUtf8Template.Write(IBufferWriter<byte>, ReadOnlySpan<byte>, CancellationToken) validates base64url nonce and writes original immutable template segments directly.
CspNonceHtmlResponseWriter.WriteBodyAsync(HttpResponse, CspNonceUtf8Template, string, CancellationToken) currently encodes nonce into stackalloc byte[64], calls that actual Write method, then awaits the original BodyWriter.FlushAsync and checks IsCanceled/IsCompleted.
Actual consumer: PublicHotReadFastPath.Serving.cs ServeHtmlWithNonce, ending in this response writer.

A releasable component may own only:
- src/backend/Infrastructure/PublicAot/ReservedCspNonceScratchWriter.cs
- tests/backend/Unit/ReservedCspNonceScratchWriterTests.cs

Proposed component contract: Write(CspNonceUtf8Template template, string nonce, IBufferWriter<byte> destination, Span<byte> callerAdmittedNonceScratch, CancellationToken token). Preflight actual Encoding.UTF8.GetByteCount(nonce) against the finite supplied span; encode via the original Encoding.UTF8 span overload; invoke the existing template.Write(destination, encodedNonceSpan, token). Never encode or copy the shared HTML template, replace its digest/representation authority, allocate/grow backing, or create a lease/publisher. Invalid nonce, cancellation and per-segment behavior remain in the original template writer. Return no borrowed memory that can escape.

Root retains existing CspNonceUtf8Template.cs, CspNonceHtmlResponseWriter, PublicHotReadFastPath.Serving.cs, factory/publication, leases, ledger, registry and integration. A future admitted-scratch overload in the original response writer must run the component inside TransientBufferLease.ConsumeAsync and await the SAME real BodyWriter.FlushAsync/ThrowIfCanceled path before releasing the operation hold. Preserve cancellation between segment boundaries, pre-commit cancellation, actual pipe backpressure and aborted-reader assertions. Do not replace streaming with whole rendered-HTML buffering.

Required ordinary component oracles: canonical writer byte comparison for CJK/emoji and different nonce lengths; immutable TemplateDigest/IntegrityBytes unchanged; invalid UTF-8/base64url and undersized scratch reject without body writes; existing segment-cancellation and real Pipe backpressure/abort assertions at root integration. Fixture output buffers are not production defaults or native qualification.

Missing production inputs: actual caller-admitted scratch pool and finite production/probe/metadata bounds; accepted P01/P05/Auto stage evidence; original source/read ownership through serving. This proposal qualifies no native row, has not been released to a worker, and is not completion of P06.4 or #3456.
'''
(out/'nonce-scratch-ready-slice.md').write_text(ready)
record={'schema':'fsusblog.memory.source-composition-checkpoint.v1','runId':'mem-3444-platform-aeds-20261009-e55917ac0','generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':source_sha,'sourceTree':subprocess.check_output(['git','rev-parse',source_sha+'^{tree}'],text=True).strip(),'branch':'codex/mem-3444-compliant-integration','verifiedOriginMaster':'c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f','masterIncorporated':False,'masterDelta':'19 ArticleGraph/FsusUI motion files; no overlap with this increment','runs':run_records,'platformSourceBindings':platform_bindings,'workerEvidenceTipReportedByParent':'02e2ee94073534328a7092cfc9bbe8b4ccc08c33 (writer source remains 556a7d70cdf2912bd9345e13bc039f60bf106b45); supplied audited locked setup is distinct from the historical audit-off run. Current root tests used existing locked assets and no restore; they do not claim a fresh audit-on restore.','checks':[{'command':'node tools/dotnet/check-csharp-style.mjs --mode changed '+ ' '.join('--file '+p for p in ['src/backend/Infrastructure/PublicReadArtifacts/ReservedAedsFrameWriter.cs','tests/backend/Unit/ReservedAedsFrameWriterTests.cs','src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadMetrics.cs','tests/backend/Unit/ReservedAedsTransientCompositionTests.cs','src/backend/Infrastructure/Memory/Platform/MacOsSysctlMemoryReader.cs','tests/backend/Unit/MacOsSysctlMemoryReaderTests.cs','src/backend/Infrastructure/Memory/Platform/WindowsCurrentJobMemoryReader.cs','tests/backend/Unit/WindowsCurrentJobMemoryReaderTests.cs','src/backend/Infrastructure/Memory/Pressure/PortableMemoryPressureSource.cs','tests/backend/Unit/PlatformMemoryPressureCompositionTests.cs']),'exit':0,'selectedFiles':10,'evidence':'style-final.log'},{'command':'node tools/governance/check-change-contract.mjs --range 6811bdc6b98ba41efea42733aa44f38de83330c4..e55917ac097e33589766e8b20ab42fabbc51a5b5','exit':0,'evidence':'change-contract.log'},{'command':'node tools/docs/generate-document-lifecycle.mjs --check','exit':0,'evidence':'document-lifecycle.log'}],'issues':issues,'acceptedIssues':0,'criteriaAccepted':0,'preservedFailures':['style-first-using-failure.log: source 69de9395d, own import ordering, corrected','style-cancel-working-tree-whitespace-failure.log: uncommitted cancellation test patch, own property whitespace, corrected','Parent worker strict-warnings prerequisite failures and NU1903 remain separate; normal original builds were not strict gate acceptance.'],'notRun':['Windows/macOS native runtime or SDK qualification','native backing/publication, domain/epoch comparison, final product acceptance','Docker tests','held source/runtime audits and canonical profiler','unchanged historical 402-case suite (still bound to 80558c678)','fresh root restore/audit (no dependencies changed)','merge/deploy/issue closure or cross-chain conflict phase'],'publicationBlocker':'No GitHub content-write slot: integration draft PR/update remains queued. Existing #3845 belongs to the older candidate branch, not this increment.'}
(out/'checkpoint.json').write_text(json.dumps(record,indent=2)+'\n')
md='''# Current memory source composition checkpoint

Source head: `e55917ac097e33589766e8b20ab42fabbc51a5b5`, branch `codex/mem-3444-compliant-integration`.
Latest observed origin/master: `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`; not incorporated. Its 19-file ArticleGraph/motion delta does not overlap this source increment.

Reserved AEDS known-payload output now composes the real canonical encoder with the existing TransientBufferLease operation hold. The consumer is awaited; captured memory expires, canceled outer waits cannot return a live buffer, and cancellation during encoding prevents consumer delivery. No byte-array copy or long-lived artifact publication was added.

The existing PortableMemoryPressureSource now calls the actual macOS sysctl and immediate Windows Job readers using caller-admitted raw output and its existing clock. Native metric meanings, flags, unavailable states and NotVerified survive. Raw rows stay outside comparable domain history; no scheduler, headroom, Job epoch or qualification is fabricated.

| Executed original-project selected run | Exact source | Result |
| --- | --- | --- |
'''
for r in run_records:md+=f"| {r['label']} | `{r['sourceSha']}` | {r['passed']}/{r['passed']}, exit 0, no skips |\n"
md+='''
Each selected command has a nonempty positive FQN allowlist, expected count and actual import/hook verification, followed by exact list parsing BEFORE execution. Raw scripts, lists, logs, TRX and preflight JSON are included. The final AEDS run built the original project fresh; current assembly bindings cover that run only. The platform owner/test blobs remain identical to their 34-case tested source at the final source head. All six worker blobs are unchanged from the supplied source commits.

Official scoped C# style passes 10 files, 0 new violations. Seven declared platform contracts plus scoped comment/marker checks pass; commit range and document lifecycle pass. Own failed import/whitespace checks are retained with their correction. Normal original builds preserve existing warnings; strict native/source/policy gates are not waived. Root runs use existing locked assets with no restore; the parent's new audit-on locked writer receipt is a separate setup observation.

The exact missing AEDS publication contract is transferable body ownership on PublicBinaryArtifact and its original snapshot/reader retirement integration; FromFrame still accepts byte[]. Unknown-length sizing and compression workspace/destination/concurrency budgets remain open. The nonce source-ready component proposal is in nonce-scratch-ready-slice.md; no implementation or release occurred.

No whole issue or criterion is accepted. Windows/macOS native rows, frozen production/performance policy, qualified process-domain binding, canonical Auto/readiness and final platform/product gates remain NotVerified. Docker and held audits were not run. New integration PR/content publication awaits the coordinating queue; #3845 is an older branch.

| Issue | Current increment | Outstanding acceptance gate |
| --- | --- | --- |
'''
for row in issues:md+=f"| #{row['issue']} | {row['currentRun']} | {row['remainingGate']} |\n"
(out/'checkpoint.md').write_text(md)
shutil.copyfile(__file__,out/'producer.py')
manifest={'schema':'fsusblog.memory.raw-artifact-manifest.v1','sourceHead':source_sha,'files':[]}
for p in sorted(out.rglob('*')):
    if p.is_file():manifest['files'].append({'path':p.relative_to(out).as_posix(),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'artifactRoot':str(out),'files':len(manifest['files']),'runs':run_records,'issues':len(issues),'acceptedIssues':0}))
