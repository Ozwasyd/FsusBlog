import copy,datetime,hashlib,json,pathlib,re,shutil,subprocess,xml.etree.ElementTree as ET
root=pathlib.Path.cwd();source='4231fd4337817c62270336eb6b37964878ab27fc';before='724505e7754a260b3bba63a6503677abb56cec90'
assert subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()==source
assert not subprocess.check_output(['git','status','--porcelain'],text=True).strip()
work=root/'.tmp/memory/governor-nullability-20261009';out=root/'artifacts/memory/control-delivery/4231fd433';out.mkdir(exist_ok=False)
preflight=json.loads((work/'preflight.json').read_text())
assert preflight['sourceSha']==source and preflight['passedCases']==5 and preflight['listSelectionVerifiedBeforeExecution']
assert preflight['list-tests.log.exit']==0 and preflight['selected.log.exit']==0 and preflight['freshOriginalBuildGovernorCs8602Count']==0
results=ET.parse(work/'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results)==5 and all(r.attrib['outcome']=='Passed' for r in results)
path='src/backend/Infrastructure/Memory/Control/MemoryGovernor.cs'
before_bytes=subprocess.check_output(['git','show',before+':'+path]);old_test_bytes=subprocess.check_output(['git','show','e55917ac097e33589766e8b20ab42fabbc51a5b5:'+path]);assert before_bytes==old_test_bytes
old_log=(root/'artifacts/memory/control-delivery/e55917ac0/aeds-cancel/list-tests.log').read_text()
old_diagnostics=[line for line in old_log.splitlines() if 'MemoryGovernor.cs' in line and 'warning CS8602:' in line];assert len(old_diagnostics)==2
(out/'before-cs8602.txt').write_text('\n'.join(old_diagnostics)+'\n')
for name in ['run-selected.py','preflight.json','list-tests.log','selected.log','selected.trx','issue3452.json','style.log','change-contract.log','document-lifecycle.log','code-intent.log','PULL_REQUEST_TITLE.txt','PULL_REQUEST_BODY.md','pr-template-structure.json','pr-changed-paths.txt']:
    shutil.copyfile(work/name,out/name)
assert 'files=1 violations=0 new=0' in (out/'style.log').read_text()
assert not json.loads((out/'code-intent.log').read_text())['errors']
assert not json.loads((out/'pr-template-structure.json').read_text())['errors']
current_log=(out/'list-tests.log').read_text()
assert not re.search(r'MemoryGovernor\.cs\([^\n]*CS8602',current_log)
bindings={}
for file in [path,'tests/backend/Unit/MemoryGovernorTests.cs','src/backend/bin/Debug/net10.0/FsusBlog.Server.dll','tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll','tests/backend/bin/Debug/net10.0/FsusBlog.Server.Tests.dll','tests/backend/obj/project.assets.json','src/backend/obj/project.assets.json']:
    p=root/file;bindings[file]={'size':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()}
assert bindings['src/backend/bin/Debug/net10.0/FsusBlog.Server.dll']['sha256']==bindings['tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll']['sha256']
(out/'bindings.json').write_text(json.dumps({'sourceSha':source,'beforeSource':before,'beforeGovernorSha256':hashlib.sha256(before_bytes).hexdigest(),'beforeDiagnosticsSameBlobAsTestedSource':'e55917ac097e33589766e8b20ab42fabbc51a5b5','beforeDiagnostics':2,'afterFreshOriginalBuildGovernorCs8602':0,'files':bindings},indent=2)+'\n')
prior=json.loads((root/'artifacts/memory/control-delivery/e55917ac0/checkpoint.json').read_text())
issues=copy.deepcopy(prior['issues'])
for row in issues:
    row['wholeIssueAcceptance']='NotAccepted'
    if row['issue']==3452:
        row['currentRun']='Minimal nullable-flow correction; five original governor replay controls passed at '+source
        row['remainingGate']='Qualified scoped P08 inputs and frozen comparable P01 calibration, original scheduler/reclaimer integration and measured outcomes remain missing. This repair changes no production policy or controller activation.'
    elif row['issue'] in (3450,3459):
        row['currentRun']='Prior source-bound result retained; not rerun in this nullable increment: '+row['currentRun']
    else:row['currentRun']='NotRun; whole-issue acceptance remains blocked'
record={'schema':'fsusblog.memory.nullable-flow-checkpoint.v1','runId':'mem-3444-governor-nullability-20261009-4231fd433','generatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHead':source,'beforeHead':before,'branch':'codex/mem-3444-compliant-integration','sourceChange':{'path':path,'insertions':1,'deletions':2,'publicContractChanged':False,'policyChanged':False,'nullableSuppressionAdded':False},'testPreflight':'preflight.json','passedCases':5,'failedCases':0,'skippedCases':0,'originalBuildGovernorCs8602Count':0,'checks':[{'command':'node tools/dotnet/check-csharp-style.mjs --mode changed --file '+path,'exit':0,'evidence':'style.log'},{'command':'node tools/governance/check-change-contract.mjs --range '+before+'..'+source,'exit':0,'evidence':'change-contract.log'},{'command':'node tools/docs/generate-document-lifecycle.mjs --check','exit':0,'evidence':'document-lifecycle.log'}],'prProposal':{'title':'PULL_REQUEST_TITLE.txt','body':'PULL_REQUEST_BODY.md','target':'master','draft':True,'githubContentWritten':False,'structureOnlyCheck':'pr-template-structure.json','fullPrAdmissionRun':False,'outstandingMetadata':'Canonical one-manifest external-naming union for all integrated source surfaces and complete generated/source admission; existing supplied manifests retained, not rewritten.'},'issues':issues,'acceptedIssues':0,'criteriaAccepted':0,'notRun':['unchanged full suites and prior 21/34 component runs','native/platform/drain/authority held probes','strict warn-as-error whole-project gate','fresh root dependency restore/audit','whole-PR source/generated/metadata admission','production configuration/Auto activation and native qualification','nonce scratch worker files or original response-writer integration (actual source publication pending)','GitHub content writes, merge, deployment, closure or cross-chain conflict phase']}
(out/'checkpoint.json').write_text(json.dumps(record,indent=2)+'\n')
md='''# Governor nullable flow and integrated PR proposal

Source: `4231fd4337817c62270336eb6b37964878ab27fc`, parent `724505e7754a260b3bba63a6503677abb56cec90`, branch `codex/mem-3444-compliant-integration`.

The parent governor blob equals the one compiled at `e55917ac097e33589766e8b20ab42fabbc51a5b5`; its raw original-project log records CS8602 at lines 265 and 267. The repair removes the intermediate `wasConstrained` Boolean and puts the same non-null/state predicate directly in the Normal recovery condition. It adds no suppression, policy, API, owner or qualification fact.

The original test project rebuilt at the exact source and records zero MemoryGovernor.cs CS8602 diagnostics. Five explicit existing methods passed, zero skipped/extra cases, exit 0: deterministic first/previous decisions, oscillating recovery, monotonic recovery despite a wall-clock jump, missing previous decision with enforced limits, and independent-slot recovery. Positive FQN and import/call preflight plus exact discovery preceded execution. Original build warnings for unrelated sources are retained. This is not a strict whole-project gate pass or native acceptance.

Official scoped style passes one file with zero new violations; scoped comments/markers, commit range and document lifecycle pass. Current binaries and source hashes are in bindings.json; raw commands, discovery/build log and TRX are retained.

The complete proposed public draft title/body are PULL_REQUEST_TITLE.txt and PULL_REQUEST_BODY.md. All 14 template chapters parse successfully. This is a structure-only check, not whole-PR admission. The body discloses the integrated branch's broader source/shared-governance diff and outstanding canonical external-naming union, generated/source admission, production/native/policy gates. No GitHub content was written. Existing #3845 is the older branch's draft.

The separately assigned nonce worker's two files were not implemented or edited. Root response/serving/lease integration waits for the parent's exact published source identity.

No whole issue or criterion is accepted. Previous AEDS and platform results retain their original source bindings and were not rerun.

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
print(json.dumps({'artifactRoot':str(out),'files':len(manifest['files']),'passedCases':5,'governorCs8602':0,'issues':len(issues),'acceptedIssues':0,'prTemplateSections':14,'githubContentWritten':False}))
