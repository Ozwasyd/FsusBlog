import copy,datetime,hashlib,json,pathlib,shutil,subprocess,xml.etree.ElementTree as ET
root=pathlib.Path.cwd();source='ab2c589d02fabfa6ed15967f0e58800d2555398a';supplier='c73ab1f4bc6947f9decc3cb488842ccef3412f69'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==source
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
work=root/'.tmp/memory/nonce-composition-20261009';out=root/'artifacts/memory/control-delivery/ab2c589d0';out.mkdir(exist_ok=False)
preflight=json.loads((work/'preflight.json').read_text())
assert preflight['sourceSha']==source and preflight['passedCases']==14 and preflight['listSelectionVerifiedBeforeExecution']
assert preflight['list-tests.log.exit']==0 and preflight['selected.log.exit']==0
results=ET.parse(work/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results)==14 and all(r.attrib['outcome']=='Passed' for r in results)
files=['run-selected.py','preflight.json','list-tests.log','selected.log','selected.trx','issue3456.json','format.log','style.log','change-contract.log','document-lifecycle.log','code-intent.log','component-bindings.json','bindings.json','dotnet-info.txt','uname.txt','PULL_REQUEST_TITLE.txt','PULL_REQUEST_BODY.md','pr-template-structure.json']
for name in files:shutil.copyfile(work/name,out/name)
assert 'files=4 violations=0 new=0' in (out/'style.log').read_text()
assert not json.loads((out/'code-intent.log').read_text())['errors']
assert not json.loads((out/'pr-template-structure.json').read_text())['errors']
for item in json.loads((out/'component-bindings.json').read_text()):
 original=subprocess.check_output(['git','show',supplier+':'+item['path']]);current=(root/item['path']).read_bytes();assert original==current
 assert hashlib.sha256(current).hexdigest()==item['sha256']
serving='src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs'
serving_before=subprocess.check_output(['git','show','724505e7754a260b3bba63a6503677abb56cec90:'+serving]);serving_current=(root/serving).read_bytes();assert serving_before==serving_current
assert b'return CspNonceHtmlResponseWriter.WriteBodyAsync(response, template, nonce, ctx.RequestAborted);' in serving_current
prior=json.loads((root/'artifacts/memory/control-delivery/4231fd433/checkpoint.json').read_text())
issues=copy.deepcopy(prior['issues'])
for row in issues:
 row['wholeIssueAcceptance']='NotAccepted'
 if row['issue']==3456:
  row['currentRun']='Explicit admitted nonce-scratch response overload: 10 new ordinary cases plus four original response controls pass at '+source
  row['remainingGate']='ServeHtmlWithNonce supplies no admitted scratch lease or pool/budget binding. Production scratch admission, original immutable template/read ownership, representation/native differential serving and accepted P01/P05/Auto prerequisites remain missing. No native or whole-issue qualification is inferred.'
 elif row['issue'] in (3450,3452,3459):row['currentRun']='Prior exact-source evidence retained; not rerun in this nonce increment. '+row['currentRun']
 else:row['currentRun']='NotRun; whole-issue acceptance remains blocked'
record={'schema':'fsusblog.memory.nonce-composition-checkpoint.v1','runId':'mem-3444-nonce-composition-20261009-ab2c589d0','generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':source,'sourceTree':subprocess.check_output(['git','rev-parse',source+'^{tree}'],text=True).strip(),'branch':'codex/mem-3444-compliant-integration','verifiedOriginMaster':'c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f','masterIncorporated':False,'supplier':{'sourceCommit':supplier,'branch':'codex/3456-bounded-nonce-scratch-20261009-ordinary','parent':'724505e7754a260b3bba63a6503677abb56cec90','consumedCommit':'901c1b50db2fa023d7f866c903de739cecdc794e','filesUnchanged':True,'parentReportedOrdinaryCases':27,'supplierCasesRerunByRoot':False,'parentReportedSetup':'locked audited restore and scoped style/contract passed; existing NU1903 retained. Root current execution uses existing locked assets, no fresh restore/audit claimed.'},'implementation':'Original CspNonceHtmlResponseWriter explicit TransientBufferLease overload composes the real supplier writer inside ConsumeAsync and awaits the same private original FlushBodyAsync/AwaitFlushAsync/ThrowIfCanceled path. Immutable template segments write directly to BodyWriter. No whole-HTML buffer, allocator, default pool, capacity or publisher is introduced.','productionServing':{'path':serving,'unchangedFromSupplierParent':True,'sha256':hashlib.sha256(serving_current).hexdigest(),'admittedScratchVariableExists':False,'autoEnabled':False,'remainingInput':'An actual admitted scratch lease/pool/budget binding at ServeHtmlWithNonce, plus original immutable template/read ownership and accepted stage/representation qualification.'},'passedCases':14,'failedCases':0,'skippedCases':0,'positiveMethods':13,'rootNewCases':10,'originalAffectedCases':4,'selectionPreflight':'preflight.json','checks':[{'command':'node tools/dotnet/check-csharp-style.mjs --mode changed --file src/backend/Infrastructure/PublicAot/CspNonceUtf8Template.cs --file tests/backend/Unit/CspNonceTransientResponseTests.cs --file src/backend/Infrastructure/PublicAot/ReservedCspNonceScratchWriter.cs --file tests/backend/Unit/ReservedCspNonceScratchWriterTests.cs','exit':0,'evidence':'style.log'},{'command':'node tools/governance/check-change-contract.mjs --range 5d924b622e0127fc97e67a0f14caaf4cf5fbb51b..'+source,'exit':0,'evidence':'change-contract.log'},{'command':'node tools/docs/generate-document-lifecycle.mjs --check','exit':0,'evidence':'document-lifecycle.log'}],'prTemplate':{'body':'PULL_REQUEST_BODY.md','title':'PULL_REQUEST_TITLE.txt','structureCheck':'pr-template-structure.json','fullPrAdmissionRun':False,'githubContentWritten':False,'outstandingMetadata':'Canonical complete external-naming union and full generated/source admission remain outstanding.'},'issues':issues,'acceptedIssues':0,'criteriaAccepted':0,'notRun':['supplier unchanged 27-case suite','unchanged prior 5/21/34/402 suites','held native/drain/authority probes','real HTTP/server/public route and representation qualification','native backend/read lease and complete P06 support matrix','production pool/budget/default Auto integration','strict whole-project and full PR source/generated admission','fresh root restore/audit','Docker, deployment, merge, issue closure or cross-chain conflict resolution']}
(out/'checkpoint.json').write_text(json.dumps(record,indent=2)+'\n')
md='''# Explicit admitted nonce scratch response composition

Source head: `ab2c589d02fabfa6ed15967f0e58800d2555398a`, branch `codex/mem-3444-compliant-integration`. Latest observed origin/master remains `c04f6bfcac4849638a9ee59e4a3aa34ceb5bb07f`, not incorporated.

Consumed the actual published supplier source `c73ab1f4bc6947f9decc3cb488842ccef3412f69`, based on `724505e7754a260b3bba63a6503677abb56cec90`. Original response/serving/lease preimages matched before composition; both supplier files remain byte-identical. Supplier 27-case/setup evidence is the parent's supplied observation, not a root rerun or native qualification.

The original CspNonceHtmlResponseWriter now accepts an explicit TransientBufferLease overload. Its ConsumeAsync callback calls ReservedCspNonceScratchWriter.Write against the actual logical span and original template, then awaits the same original flush/canceled/completed-reader path shared with the legacy overload. Original template segments stream directly into response.BodyWriter; no whole rendered HTML buffer, new allocator, default pool, capacity or publisher is introduced. The original pool owns clearing, retained charge and final release. No end-to-end or network-delivery claim is made from these Pipe fixtures.

Original project discovery/build and execution passed 14/14, exit 0, no skipped or extra cases: 10 new ordinary cases and four original response controls. A 13-method nonempty positive allowlist, actual import/lease/template/BodyWriter hooks and expected count were independently checked; exact discovery parsing preceded execution. Original raw build warnings remain. Current source/test/binary/assets hashes are in bindings.json.

Observed assertions cover canonical multilingual/emoji bytes with differing nonce lengths, unchanged template digest/integrity, real Pipe backpressure, external wait cancellation while scratch stays charged through flush completion, request and segment cancellation, completed-reader abort, logical bounds despite a larger physical bucket, hold-budget refusal, and repeated success/failure clearing with exactly one refund. Fixture byte and time bounds are not production defaults.

Official scoped style passed four exact files, zero new violations. Scoped comment/marker checks, commit range and document lifecycle passed. Full updated public draft PR title/body and a structure-only 14-section check are retained; no GitHub content was written and no whole-PR admission was claimed.

The production gap is exact: PublicHotReadFastPath.Serving.cs ServeHtmlWithNonce still calls the legacy overload and has no admitted scratch lease or pool/budget binding. That file is unchanged from the supplier prerequisite. Original immutable template/read ownership, accepted P01/P05/Auto and full representation/native serving qualification remain missing. This is verified explicit ordinary source composition, not activated production serving or completion of P06.4/#3456. Native/held authority probes and unchanged suites were not run.

No whole issue or criterion is accepted.

| Issue | Current increment | Outstanding acceptance gate |
| --- | --- | --- |
'''
for row in issues:md+=f"| #{row['issue']} | {row['currentRun']} | {row['remainingGate']} |\n"
(out/'checkpoint.md').write_text(md)
shutil.copyfile(__file__,out/'producer.py')
manifest={'schema':'fsusblog.memory.raw-artifact-manifest.v1','sourceHead':source,'files':[]}
for p in sorted(out.rglob('*')):
 if p.is_file():manifest['files'].append({'path':p.relative_to(out).as_posix(),'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(out/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'artifactRoot':str(out),'hashedFiles':len(manifest['files']),'passedCases':14,'issues':len(issues),'acceptedIssues':0,'supplierFilesUnchanged':True,'productionServingChanged':False,'githubContentWritten':False}))
