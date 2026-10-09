import copy, datetime, hashlib, json, pathlib, shutil, subprocess, xml.etree.ElementTree as ET

root = pathlib.Path.cwd()
source = 'c9b9695b23f0c6aae6a80e61eda0cb172d14f35f'
baseline = 'c1ac6630e86a899f4acf59283ea10a4fcdd69894'
work = root / '.tmp/memory/ownership-policy-20261009'
out = root / 'artifacts/memory/control-delivery/c9b9695b2'
prior_folder = root / 'artifacts/memory/control-delivery/00e5f1a0b'

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

assert git('rev-parse', 'HEAD') == source and not git('status', '--porcelain')
assert (work / 'remote-source.txt').read_text().split()[0] == source
pre = json.loads((work / 'preflight.json').read_text())
assert pre['sourceSha'] == source and pre['passedCases'] == 45 and pre['listSelectionVerifiedBeforeExecution']
assert pre['list-tests.log.exit'] == 0 and pre['selected.log.exit'] == 0 and len(pre['positiveFqnAllowlist']) == 19
results = ET.parse(work / 'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results) == 45 and all(r.attrib['outcome'] == 'Passed' for r in results)
assert 'files=5 violations=0 new=0' in (work / 'style.log').read_text()
assert 'files=1 violations=0 new=0' in (work / 'style-fixture-repair.log').read_text()
assert not json.loads((work / 'code-intent.json').read_text())['errors']
assert '[document-lifecycle] ok documents=372' in (work / 'document-lifecycle.log').read_text()
assert '[change-contract] ok commit-range=' in (work / 'change-contract.log').read_text()
delta = json.loads((work / 'configuration-delta.json').read_text())
assert len(delta['baselineErrors']) == 35 and delta['baselineErrors'] == delta['currentErrors'] and not delta['introducedErrors']
handoff = json.loads((work / 'snapshot-ownership-registration.json').read_text())
assert len(handoff['rows']) == 12
assert hashlib.sha256((work / 'snapshot-ownership-registration.patch').read_bytes()).hexdigest() == handoff['patchSha256']
subprocess.run(['git', 'apply', '--check', str(work / 'snapshot-ownership-registration.patch')], check=True)
changed = git('diff', '--name-only', baseline, source).splitlines()
assert len(changed) == 6
assert not git('diff', '--check', baseline + '..' + source)
prior = json.loads((prior_folder / 'checkpoint.json').read_text())
held = sorted(set(prior['heldSourceFilesUnchanged'] + [
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs',
    'tests/backend/Unit/OwnedPublicHotReadSnapshotTests.cs',
    'src/backend/Services/SystemService.cs', 'src/backend/Entities/SystemConfig.cs', 'src/backend/Interfaces/ISystemService.cs',
    'config/application/backend-configuration-contract.json', 'docs/configuration/backend-configuration-reference.generated.md',
]))
for name in held:
    assert subprocess.check_output(['git', 'show', baseline + ':' + name]) == (root / name).read_bytes()
paths = sorted(set(changed + held + [b['path'] for b in json.loads((prior_folder / 'bindings.json').read_text())]))
bindings = []
for name in paths:
    path = root / name
    if path.is_file():
        data = path.read_bytes()
        bindings.append({'path': name, 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
assert (root / 'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll').read_bytes() == (root / 'tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll').read_bytes()
issues = copy.deepcopy(prior['issues'])
assert len(issues) == 23 and sum(len(r.get('criteria', [])) for r in issues) == 237
for row in issues:
    assert row['wholeIssueAcceptance'] == 'NotAccepted'
    assert all(c['acceptance'] == 'NotAccepted' for c in row.get('criteria', []))
    if row['issue'] == 3446:
        row['currentRun'] = '45/45 ordinary explicit-input controls at ' + source + ': 39 new revisioned snapshot-policy cases and six affected legacy group cases. The existing PublicHotRead binder resolves the typed no-default contract; independent frozen limits must match configured values.'
        row['remainingGate'] = 'Executable policy/configuration contract now exists with required finite inputs, canonical ledger domains and original group lifecycle enforcement. Actual P01 frozen values/qualified baseline and source/location producer remain absent. Twelve semantic registration rows/generated reference are an exact handoff to the shared registration owner. Whole platform/config/readiness/Auto qualification and acceptance remain open.'
    elif row['issue'] == 3447:
        row['currentRun'] = 'Partial original group composition at ' + source + ': real canonical ledger byte/headroom plus operation-slot vector is admitted before attached group construction; byte/slot denial leaves no partial reservation; final actual group release returns reservation once; stale accounting and pending reload controls are included in 45/45. No multi-thread/lease/race/receipt audit.'
        row['remainingGate'] = 'Actual frozen metadata upper-bound/headroom and real production resource scopes are still required. This contract keeps conservative reservations rather than inventing physical metadata descriptors or measured CLR layouts. Full producer/transient/pool/native composition, overhead/peak qualification and stage acceptance remain incomplete.'
    elif row['issue'] == 3456:
        row['currentRun'] = 'Partial policy-to-original snapshot/group integration in 45/45 ordinary controls at ' + source + ', including real Pipe completion during Drop and deferred reload. Previous complete 29/29 stays at 00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b; only six affected cases were rerun in the new selection. Prior 21/14 results unchanged.'
        row['remainingGate'] = 'Ordinary typed frozen-policy code is implemented. Canonical projector still produces arrays without actual admitted qualified lease/content/location; independent actual frozen P01 values/baseline and shared registration integration remain required. P01/P05/Auto acceptance, native/compressed/HTML differential, nonce scratch inputs, backing-aware statistics and production disable/drain qualification remain missing.'
    elif row['issue'] == 3459:
        row['currentRun'] = 'Partial bounded final representation/root/consumer roster contract and group quota lifecycle at ' + source + ', verified by ordinary managed controls. No original build/compression/overlay peak profiling or workspace acceptance run.'
        row['remainingGate'] = 'The numerical contract requires an independently frozen conservative model covering rosters/construction overlap; actual bounds have not been supplied or measured. Already-created producer/raw snapshot metadata, cloning/overlay/compression workspace peaks and fine-grained shared-block reclamation remain separate admission/qualification work. No actual peak or performance acceptance claimed.'
notes = copy.deepcopy(prior['P06Criteria'])
notes['MEM-P06-AC03']['currentEvidence'] = 'Partial managed original group retains real read leases and quota through original Pipe backpressure and Drop; policy reload waits for actual final consumer completion. No held native/lease race/alias/TOCTOU/custody/receipt qualification.'
notes['MEM-P06-AC07']['currentEvidence'] = 'Partial: actual ledger conservatively reserves the supplied metadata byte upper-bound/headroom and finite hold slots per group; original backing stays separately charged. No measured CLR layout, native/generation residency projection or actual frozen production model.'
failure = json.loads((work / 'attempt-9c4ecddde/failure.json').read_text())
failure['source'] = json.loads((work / 'attempt-9c4ecddde/preflight.json').read_text())['sourceSha']
record = {
    'schema': 'fsusblog.memory.snapshot-ownership-policy-ordinary-checkpoint.v1',
    'runId': pre['runId'], 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceHead': source, 'sourceTree': git('rev-parse', source + '^{tree}'),
    'branch': 'codex/mem-3444-compliant-integration', 'sourceRemoteReadbackConfirmed': True,
    'sourceIncrement': failure['source'], 'fixtureRepair': source,
    'latestFetchedOriginMaster': '9d72a1c93b297f719d8695a642cdfb1615cf1d51', 'masterIncorporated': False,
    'changedFiles': changed, 'heldAndReleasedFilesUnchanged': held,
    'passedCases': 45, 'failedCases': 0, 'skippedCases': 0, 'positiveMethods': 19,
    'newPolicyCases': 39, 'affectedLegacyCases': 6,
    'ordinaryBuild': {'sdk': '10.0.401', 'restoreOrAuditPerformed': False,
        'warningLines': sum(': warning ' in s for s in (work / 'list-tests.log').read_text().splitlines()),
        'errorLines': sum(': error ' in s for s in (work / 'list-tests.log').read_text().splitlines()), 'fullSourceStageRun': False},
    'failedEarlierAttempt': failure,
    'executableContract': {'configuration': 'PublicHotReadOptions.SnapshotOwnership under the existing Configure<PublicHotReadOptions>(PublicHotRead section); twelve nullable required fields and no numerical defaults or mode/enable flag.',
        'factory': 'PublicHotReadSnapshotOwnershipPolicy.TryCreate(options, actual ledger, metadata byte domain, operation-slot domain, supplied MemoryGovernorBaselineBinding, independent immutable PublicHotReadSnapshotOwnershipLimits, candidate commit, now).',
        'freezeBoundary': 'Missing/unfrozen/unqualified/mismatched input refuses policy creation; every configured value must equal the independent frozen limits. Shape/equality validation does not independently verify a receipt or qualify content.',
        'admission': 'Original store TryApplySnapshotOwnershipPolicy / TryAttachSnapshotHostOwnership consume the immutable policy and supplied real read leases. Canonical TryReserveUnderBounds atomically reserves metadata upper bound + explicit headroom Bytes and MaximumHolds OperationSlots before constructing attached group metadata; uses current enforced caps and accounting revision.',
        'rosters': 'Per-group lease/root/consumer limits, per-live-snapshot representation limit and aggregate hold limit; copies and consumers share the original real backing read leases.',
        'release': 'FinalSharedHold: actual final successful source-lease disposal then metadata/slot reservation return once. A source release failure stays charged and cannot complete policy drain; held failure injection not run.',
        'reload': 'DrainBeforeApply: one pending newer revision; missing new frozen evidence/stale revision rejects without partial replacement. New group admission stops; original publisher controls root retirement and original bounded consumers keep their holds. Pending policy applies after all actual old-group admissions end.',
        'unitsAndZero': 'Explicit bytes and operation slots use original domain types. Counts/revisions/capacity/upper bound must be positive; no omitted/zero unlimited values. Headroom zero is an explicit no-extra-byte reservation, never omission.',
        'ownership': 'Retained root P01/P02/P03/P06; no released module source changes and no SystemService/SystemConfig/SiteIdentity changes.'},
    'registrationHandoff': handoff,
    'configurationCheck': {'prospectivePatchCommandExit': 1, 'actualBaselineCommandExit': 1,
        'baselineErrorCount': 35, 'prospectiveErrorCount': 35, 'introducedErrors': [],
        'sourceOfExistingDrift': 'ArticleDetailViewProjection, Security AdminSession/PublicHotReadRisk projection, PrivateAssets unowned appsettings keys in original base/Production overlays; unchanged and outside this patch.',
        'setupAttempt': 'Initial alternate-file baseline comparison added one canonical-authority-path error. Corrected real isolated c1ac baseline worktree has exactly the same 35 errors as the prospective patch. No error waived.',
        'sharedFiles': 'Own-only registration/reference diff captured, checked and restored after SiteIdentity coordination. Current committed shared files remain byte-identical to baseline; patch is pending owner integration.'},
    'productionAutoActivated': False,
    'remainingFacts': 'Actual P01 frozen numerical model/baseline proof and canonical projector admitted content/location/source inputs remain absent. No actual measured metadata/CLR peak, original producer/raw-snapshot/overlay/compression peak admission, backend/Auto/readiness/production transition or full platform performance qualification is claimed.',
    'priorEvidencePreserved': {'snapshot29': '00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b',
        'hostFrame21': 'de0adc1a5ed4a32f5cdfc01b9c560f9b357cd250', 'nonce14': 'ab2c589d02fabfa6ed15967f0e58800d2555398a'},
    'P06Criteria': notes, 'issues': issues, 'acceptedIssues': 0, 'criteriaAccepted': 0,
    'checks': [{'command': 'Original positive 19-FQN / 45-case preflight, dotnet test --no-restore --filter <exact filter> --list-tests then same selection --no-build --logger trx', 'exit': 0},
        {'command': 'Scoped C# style five files, then one fixture call-site repair', 'exit': 0},
        {'command': 'Scoped original comment/marker checks for five files', 'exit': 0},
        {'command': 'node tools/docs/generate-document-lifecycle.mjs --check', 'exit': 0},
        {'command': 'node tools/governance/check-change-contract.mjs --range ' + baseline + '..' + source, 'exit': 0},
        {'command': 'git diff --check ' + baseline + '..' + source, 'exit': 0},
        {'command': 'git apply --check snapshot-ownership-registration.patch', 'exit': 0},
        {'command': 'Existing full backend configuration checker at isolated baseline and prospective twelve-row registration', 'exit': 1, 'existingErrors': 35, 'introducedErrors': 0}],
    'notRun': ['prior 29 as a whole, unchanged 21/nonce14 or broad suites', 'held native/lease race/alias/TOCTOU/custody/receipt/full SOURCE audits',
        'production frozen-policy receipt verification/measurement, source producer and Auto activation',
        'clone/overlay/compression/producer peak bounds, native/GPU/platform/performance matrix',
        'shared registration integration, SystemService/SystemConfig/SiteIdentity implementation',
        'fresh restore/audit, production DB, deploy, merge, issue closure, GitHub metadata publishing or cross-chain conflict resolution']
}
out.mkdir(exist_ok=False)
for name in ['producer.py', 'run-selected.py', 'preflight.json', 'list-tests.log', 'selected.log', 'selected.trx',
             'style.log', 'style-fixture-repair.log', 'format.log', 'code-intent.json', 'document-lifecycle.log',
             'change-contract.log', 'dotnet-info.txt', 'uname.txt', 'remote-source.txt',
             'configuration-contract.json', 'configuration-contract.log', 'configuration-baseline.log', 'configuration-delta.json',
             'snapshot-ownership-registration.patch', 'snapshot-ownership-registration.json', 'issue3447.json']:
    shutil.copyfile(work / name, out / name)
shutil.copytree(work / 'attempt-9c4ecddde', out / 'attempt-9c4ecddde')
(out / 'attempt-9c4ecddde/failure.json').write_text(json.dumps(failure, indent=2) + '\n')
(out / 'bindings.json').write_text(json.dumps(bindings, indent=2) + '\n')
(out / 'checkpoint.json').write_text(json.dumps(record, indent=2) + '\n')
md = f'''# Snapshot ownership policy: executable managed source increment

Tested/published source `{source}` on `codex/mem-3444-compliant-integration`. Latest fetched master `9d72a1c93b297f719d8695a642cdfb1615cf1d51`, not incorporated.

The existing PublicHotRead configuration now binds a typed nullable SnapshotOwnership object without numerical defaults or mode/enable flags. TryCreate requires actual canonical byte/operation domains, ledger/accounting revision, candidate-bound independent frozen baseline and immutable limits supplied by the policy owner. Missing/unfrozen/unqualified/mismatched values reject; every configured field must equal the independent frozen model. Counts/capacity/upper bound/revisions are finite positive; headroom zero means no extra reserved bytes, omission remains missing. This executable contract does not measure CLR sizes, independently verify an evidence file or qualify raw content.

The original store/group path consumes that policy: metadata upper bound + explicit headroom Bytes and MaximumHolds OperationSlots are atomically admitted by the canonical ledger under current caps/revision before attached group construction. Shared groups enforce lease/root/consumer rosters and per-snapshot representation count. Actual final source/consumer completion returns the conservative reservation once. Original publication/integrity/currentness/serving authority remains unchanged. One pending fresh higher policy revision stops new group admission, preserves old ownership, and applies after actual old-group drain. Original publisher still controls root retirement; logical targets never imply reclaim. No physical metadata descriptor, default budget or Auto activation is invented.

45/45 ordinary controls passed, exit 0, no skip: 39 new policy cases and six affected original group cases. The exact positive 19-FQN selection and actual source/API hooks were checked before discovery; exact 45-case discovery was checked before execution. Existing original project uses SDK 10.0.401 with --no-restore; warnings retained. First discovery/build at {failure['source']} failed because new fixture calls used incorrect original serving/invalidation APIs; no tests executed. The fixture-only repair retained the identical selection; failed preflight/raw build log is preserved. Prior full 29, 21 and nonce14 results stay at original commits; only six impacted group cases appear in this fresh selection. Full SOURCE/native/lease race/alias/TOCTOU/custody/receipt/retirement-fault audits were not run.

Scoped style/comment/marker/document/whitespace/commit checks passed. Full configuration checker remains failed with exactly 35 pre-existing unrelated ArticleDetail/Security/PrivateAssets registration errors, identical in a genuine isolated baseline checkout and the prospective registration; zero new errors were introduced. Initial alternate-file comparison had an additional canonical-path error and was replaced by the genuine baseline check, without weakening the checker.

Shared registration coordination: SystemService.cs, SystemConfig.cs, ISystemService.cs and their validation paths are released unchanged for the separate SiteIdentity owner. This commit does not write config/application/backend-configuration-contract.json or its generated reference. The exact twelve-row registration/reference patch is snapshot-ownership-registration.patch (SHA256 {handoff['patchSha256']}); its base is {baseline}, its original authority remains public-delivery, and read-only apply check passes. The own-only diff was verified and restored; registration/reference integration remains pending with that shared owner. No GitHub metadata write was performed.

Actual P01 frozen numerical values/model proof, canonical projector real content/location/source inputs, and shared registration integration are still required before production admission. Existing producer/raw snapshot metadata and clone/overlay/compression workspace peaks need their original owners' admission and qualification; final-roster checks are not proof of those earlier peaks. The supplied fixture amounts are declared contract data, not measured CLR bounds or production defaults. Whole-stage/default-Auto/native/platform/performance acceptance is not claimed.

All 22 execution issues plus tracking row and 237 criteria remain NotAccepted. Complete issue-by-issue status:

| Issue | Kind | Acceptance | Remaining gate |
| --- | --- | --- | --- |
'''
for row in issues:
    md += f"| #{row['issue']} | {row['kind']} | {row['wholeIssueAcceptance']} | " + row['remainingGate'].replace('|', '\\|').replace('\n', ' ') + ' |\n'
(out / 'checkpoint.md').write_text(md)
manifest = {'schema': 'fsusblog.memory.ordinary-artifact-manifest.v1', 'sourceHead': source, 'runId': pre['runId'], 'files': []}
for path in sorted(out.rglob('*')):
    if path.is_file():
        data = path.read_bytes()
        manifest['files'].append({'path': str(path.relative_to(out)), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sourceSha': source, 'artifactPath': str(out.relative_to(root)), 'passed': 45,
                  'issueRows': 23, 'criteria': 237, 'accepted': 0, 'manifestFiles': len(manifest['files'])}))
