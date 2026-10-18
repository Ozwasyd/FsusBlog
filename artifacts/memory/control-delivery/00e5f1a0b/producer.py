import copy
import datetime
import hashlib
import json
import pathlib
import shutil
import subprocess
import xml.etree.ElementTree as ET

root = pathlib.Path.cwd()
source = '00e5f1a0b9c7de2a4c2b04a4e2ea9d0b6ea7846b'
baseline = 'cd79b28c255c35527496431e910fef7b6db66f80'
work = root / '.tmp/memory/snapshot-host-20261009'
out = root / 'artifacts/memory/control-delivery/00e5f1a0b'
prior_path = root / 'artifacts/memory/control-delivery/de0adc1a5/checkpoint.json'

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def digest(path):
    data = path.read_bytes()
    return {'path': str(path.relative_to(root)), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()}

assert git('rev-parse', 'HEAD') == source
assert not git('status', '--porcelain')
assert (work / 'remote-source.txt').read_text().split()[0] == source
pre = json.loads((work / 'preflight.json').read_text())
assert pre['sourceSha'] == source and pre['passedCases'] == 29
assert pre['listSelectionVerifiedBeforeExecution']
assert pre['list-tests.log.exit'] == 0 and pre['selected.log.exit'] == 0
results = ET.parse(work / 'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results) == 29 and all(r.attrib['outcome'] == 'Passed' for r in results)
assert len(pre['positiveFqnAllowlist']) == 23
assert 'files=6 violations=0 new=0' in (work / 'style.log').read_text()
intent = json.loads((work / 'code-intent.json').read_text())
assert intent['sourceSha'] == source and not intent['errors']
assert 'ok commit-range=' + baseline + '..' + source in (work / 'change-contract.log').read_text()
assert '[document-lifecycle] ok documents=372' in (work / 'document-lifecycle.log').read_text()
assert not git('diff', '--check', baseline + '..' + source)
changed = git('diff', '--name-only', baseline, source).splitlines()
assert len(changed) == 7
assert set(changed) == set(intent['files']) | {'docs/architecture/repository-layout.md'}

prior = json.loads(prior_path.read_text())
issues = copy.deepcopy(prior['issues'])
assert len(issues) == 23 and sum(len(r.get('criteria', [])) for r in issues) == 237
for row in issues:
    assert row['wholeIssueAcceptance'] == 'NotAccepted'
    assert all(c['acceptance'] == 'NotAccepted' for c in row.get('criteria', []))
    if row['issue'] == 3456:
        row['currentRun'] = '29/29 ordinary managed explicit-input controls at ' + source + ': 24 new snapshot/consumer cases and five original stickiness/integrity cases. Previous 21/21 remains at de0adc1a5ed4a32f5cdfc01b9c560f9b357cd250; nonce 14/14 remains at ab2c589d02fabfa6ed15967f0e58800d2555398a. Neither prior selection was rerun.'
        row['remainingGate'] = 'Root-retained snapshot/store source now binds supplied real read leases through original publication roles and response completion. Canonical projector still supplies arrays without admitted/qualified lease/content/location inputs or frozen hold/metadata budget policy. Accepted P01/P05/Auto, native/compressed/HTML differential, backing-aware residency/statistics, original full qualified revocation flow, finite performance gates and production disable/drain remain missing. Nonce caller still lacks admitted scratch/pool inputs. No whole-stage acceptance.'
    elif row['issue'] == 3459:
        row['currentRun'] = 'Immutable snapshot copies share supplied original read leases and return intermediate holds under ordinary managed distributed-fragment/removal controls, included in 29/29 at ' + source + '. Prior known-payload 21/21 remains bound to e55917ac097e33589766e8b20ab42fabbc51a5b5, not rerun.'
        row['remainingGate'] = 'Snapshot groups conservatively retain all attached representations until every group hold ends; original production residency projection remains unchanged. Compression/HTML/unknown-length workspace and metadata admission, independent shared-block reclamation, production producer binding and frozen performance gates remain incomplete.'

notes = copy.deepcopy(prior['P06Criteria'])
notes['MEM-P06-AC02']['currentEvidence'] = 'Partial: ordinary managed identity GET/HEAD/304, actual original publication rejection/integrity and stickiness controls passed. Native/compressed/HTML full differential absent; prior nonce not rerun.'
notes['MEM-P06-AC03']['currentEvidence'] = 'Partial: real managed read leases survive source retirement, old publication replacement, real original Pipe backpressure, outer wait cancellation and request cancellation until original consumer completion. No native lease/race/alias/TOCTOU/custody/receipt audit or qualified T10/T11.'
notes['MEM-P06-AC04']['currentEvidence'] = 'Partial: actual supplied opaque managed ROM traverses existing snapshot and original body writer without adapter ToArray. No native qualified copy/capacity trace.'
notes['MEM-P06-AC07']['currentEvidence'] = 'Partial: ordinary managed single physical ledger charge/read lease is shared by immutable snapshot roots and consumers and returned once. Whole-group retention is conservative. Original production residency projection, native/generation accounting and admitted metadata budget remain incomplete.'
notes['MEM-P06-AC08']['currentEvidence'] = 'Partial: five original stickiness/integrity cases plus managed publication rejection, retain-last-good, Drop, repeated publication, sticky expiry and security-bypass controls passed. Full qualified route/revocation differential remains held.'
assert all(n['acceptance'] == 'NotAccepted' for n in notes.values())

held = prior['heldSourceFilesUnchanged'] + [
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs',
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Routing.cs',
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadSanity.cs',
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadResidency.cs',
    'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadStore.Runtime.cs',
    'tests/backend/Unit/PublicHotReadVersionStickinessTests.cs',
    'tests/backend/Unit/PublicHotReadSanityTests.cs',
    'tests/backend/Unit/PublicBinaryHostFrameTests.cs',
]
held = sorted(set(held))
for name in held:
    assert subprocess.check_output(['git', 'show', baseline + ':' + name]) == (root / name).read_bytes()
previous_bindings = json.loads((prior_path.parent / 'bindings.json').read_text())
paths = sorted(set([b['path'] for b in previous_bindings] + changed + held))
bindings = [digest(root / name) for name in paths if (root / name).is_file()]
assert (root / 'src/backend/bin/Debug/net10.0/FsusBlog.Server.dll').read_bytes() == (root / 'tests/backend/bin/Debug/net10.0/FsusBlog.Server.dll').read_bytes()

record = {
    'schema': 'fsusblog.memory.snapshot-host-ordinary-checkpoint.v1',
    'runId': pre['runId'], 'generatedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    'sourceHead': source, 'sourceTree': git('rev-parse', source + '^{tree}'),
    'sourceIncrement': 'c6a49eeb0c109ab20c97c2665b2ff0682ea80588',
    'retirementExceptionCleanupIncrement': source,
    'branch': 'codex/mem-3444-compliant-integration', 'sourceRemoteReadbackConfirmed': True,
    'verifiedOriginMaster': prior['verifiedOriginMaster'], 'masterIncorporated': False,
    'changedFiles': changed, 'heldSourceFilesUnchanged': held,
    'passedCases': 29, 'failedCases': 0, 'skippedCases': 0,
    'positiveMethods': 23, 'newManagedCases': 24, 'originalAffectedCases': 5,
    'ordinaryBuild': {'sdk': '10.0.401', 'restoreOrAuditPerformed': False,
        'warningLines': sum(': warning ' in s for s in (work / 'list-tests.log').read_text().splitlines()),
        'errorLines': sum(': error ' in s for s in (work / 'list-tests.log').read_text().splitlines()),
        'fullSourceStageRun': False},
    'failedEarlierGuard': json.loads((work / 'attempt-preflight-wrapper/failure.json').read_text()),
    'implementation': 'FromHostReadLease uses actual lease metadata and opaque identity ROM without custody transfer. WithHostReadLeases validates explicit inputs and takes exclusive disposal custody after successful binding validation. A finite shared hold group owns actual original read leases across immutable snapshot roots and consumers. Original current/last-good/sticky references remain publication-role authority; publication validation precedes claim and original pointer publication. Original classifier/security/selection/body writer remain active; response completion or exception ends its per-consumer hold. Original replacement/Drop/sticky expiry detach inactive roots and release outside store gate. Distributed copies release unpublished intermediate roots. No new publisher, registry, identity, evidence flag, allocator, native activation or protocol.',
    'actualInputs': {'lease': 'IMemoryHostReadLease.Content / Location / Memory, supplied from original TryAcquireHostView(expectedLocation)',
        'logicalRoles': 'Existing PublicHotReadStore._current / _lastGood / _sticky object references; no fabricated role ID and no new physical role reservation',
        'limit': 'Caller-supplied positive maximumHolds; fixture-only values 1/2/3/8 are not production defaults or frozen policy'},
    'productionAutoActivated': False,
    'essentialProductionGap': {
        'producerApi': 'PublicHotArtifactProjector.cs:31 IPublicHotArtifactProjector.BuildInitialSnapshotAsync(CancellationToken); lines 147-160 BuildSnapshotCoreAsync(existingHtml, ct) constructs array artifacts without an admitted host lease or authoritative memory Content/Location input.',
        'requiredFactOwner': 'Existing projector/materialization owner must supply real admitted qualified host leases/content/location from canonical controller/arena; existing P01/P02 policy authority must supply frozen shared-hold and metadata charge/admission bounds. Root snapshot/store code consumes those explicit inputs; it cannot manufacture production qualification or identity from artifact bytes.',
        'compression': 'PublicHotReadSanity compressed schema validation still allocates decoded output; new owned attachment refuses every precompressed binary variant before that array-only validation, and refuses opaque HTML. FromHostReadLease refuses precompression. No compressed/native/HTML production support claimed.',
        'accounting': 'Group sharing preserves one actual backing read lease and physical charge until all roots/consumers finish. Whole-group retention does not provide fine-grained removed-frame reclamation or update original residency projection; group metadata allocation/admission is not production qualified.',
        'ordinaryFixtureEvidence': 'Tests use existing CreateVerified fixture API with canonical AEDS and real managed backing. That controlled fixture is not a new verification flag, qualification receipt or production evidence authority.',
        'retirementExceptions': 'Source releases selected consumer hold if expired sticky retirement throws and attempts all detached roots. Failure injection/held retirement audits were not run.',
    },
    'previousEvidenceNotRerun': {'hostFrame21': 'de0adc1a5ed4a32f5cdfc01b9c560f9b357cd250', 'nonce14': 'ab2c589d02fabfa6ed15967f0e58800d2555398a'},
    'P06Criteria': notes, 'issues': issues, 'acceptedIssues': 0, 'criteriaAccepted': 0,
    'checks': [
        {'command': 'Exact positive 23-method / 29-case preflight, original dotnet test --no-restore --filter <preflight.json filter> --list-tests, then same filter --no-build --logger trx', 'exit': 0, 'evidence': 'preflight.json, run-selected.py, list-tests.log, selected.log, selected.trx'},
        {'command': 'node tools/dotnet/check-csharp-style.mjs --mode changed ' + ' '.join('--file ' + p for p in intent['files']), 'exit': 0, 'evidence': 'style.log'},
        {'command': 'Scoped validateCommentPolicy and validateMarkerRegistration using original registry for six exact source/test files', 'exit': 0, 'evidence': 'code-intent.json'},
        {'command': 'node tools/docs/generate-document-lifecycle.mjs --check', 'exit': 0, 'evidence': 'document-lifecycle.log'},
        {'command': 'node tools/governance/check-change-contract.mjs --range ' + baseline + '..' + source, 'exit': 0, 'evidence': 'change-contract.log'},
        {'command': 'git diff --check ' + baseline + '..' + source, 'exit': 0},
    ],
    'notRun': ['prior 21 and nonce 14 selections; other unchanged suites',
        'held native/lease race/alias/TOCTOU/custody/receipt and retirement-fault audits',
        'full SOURCE and whole PR/generated source admission; raw SOURCE-stage logs',
        'production Auto/disable/drain, native/compressed/HTML qualification, actual network delivery',
        'frozen P01 profiling/performance gates and full platform/driver/GPU matrix',
        'fresh restore/audit, dependency download, production DB, deploy, merge, issue closure, metadata writes or cross-chain conflict resolution'],
}

out.mkdir(exist_ok=False)
for name in ['producer.py', 'run-selected.py', 'preflight.json', 'list-tests.log', 'selected.log', 'selected.trx',
             'style.log', 'change-contract.log', 'document-lifecycle.log', 'code-intent.json', 'dotnet-info.txt',
             'uname.txt', 'issue3456.json', 'remote-source.txt']:
    shutil.copyfile(work / name, out / name)
shutil.copytree(work / 'attempt-preflight-wrapper', out / 'attempt-preflight-wrapper')
(out / 'bindings.json').write_text(json.dumps(bindings, indent=2) + '\n')
(out / 'checkpoint.json').write_text(json.dumps(record, indent=2) + '\n')
md = f'''# Explicit snapshot host ownership: ordinary source increment

Tested and source-published commit: `{source}`. Branch: `codex/mem-3444-compliant-integration`.
Latest fetched origin/master remains `{record['verifiedOriginMaster']}`; not incorporated. This increment touches exactly the seven owned files recorded in checkpoint.json. Released Memory/Host/Lifetime and supplier files, original projector, route classifier, compressed validator, residency projection and original affected tests are byte-identical to the prior published source. Bindings include actual source, dependency assets, toolchain and compiled assembly hashes; backend and test-output server assemblies match.

29/29 ordinary managed controls passed, exit 0, no skip: 24 new explicit-input cases and five original stickiness/integrity cases. The nonempty positive 23-method selection and real source/API hooks were checked before discovery; exact 29-case discovery was checked before execution. Original project build ran with SDK 10.0.401, existing assets and --no-restore; warnings are retained without suppression. Scope-specific C# style (six files), comment/marker checks, document lifecycle, whitespace and commit-range checks passed. Prior host-frame 21/21 at de0adc1a5 and nonce 14/14 at ab2c589d0 were not rerun and remain bound to those commits. These are ordinary build/test artifacts, not raw SOURCE-stage logs or native qualification.

The root-owned original snapshot/store now consumes supplied IMemoryHostReadLease.Content, Location and Memory through WithHostReadLeases. FromHostReadLease only creates original artifact metadata and never takes custody. Immutable copies share actual already-acquired backing read holds under an explicit finite caller bound; original current/last-good/sticky references remain the authoritative logical publication roles. Original visibility/currentness/age/budget/integrity checks precede ownership claim and pointer publication. Original request classifier and response writer retain a per-consumer hold until their actual task ends. Replacement, last-good retention, Drop, sticky expiry, distributed intermediate cleanup and repeated publication preserve actual backing lifetime. Ordinary real Pipe backpressure, cancellation, byte/header/GET/HEAD/304 checks, bounded rejection before body/endpoint, original security bypass, rejection/integrity and immutable-copy controls are in the exact selection.

No fabricated location/role/content IDs, new verification flag, publisher, registry or protocol is introduced. Physical ownership is the supplied actual read lease; the shared metadata counter is not a fabricated physical role reservation. Controlled tests use the original publication fixture evidence API, not production qualification. No Auto activation is performed. Opaque HTML and all precompressed variants are refused on this owned attachment until their original allocation-heavy validation/workspace is admitted. Group retention is conservative: removed representations stay physically charged until every shared group hold ends. Fine-grained reclamation and the original product residency/statistics projection remain open.

The exact unknown producer facts are at PublicHotArtifactProjector.cs:31 IPublicHotArtifactProjector.BuildInitialSnapshotAsync(CancellationToken) and lines 147-160 BuildSnapshotCoreAsync(existingHtml, ct): they produce arrays with no admitted qualified host lease or authoritative memory Content/Location binding input. Existing projector/materialization/controller/arena owners must supply those facts. P01/P02 policy authority must supply the frozen hold limit and metadata admission/charge policy; fixture values are not defaults. The root's typed consumer/source attachment now exists and remains explicit. Compression, native/backend/Auto qualification, original nonce scratch admission and performance/platform gates remain incomplete.

The first preflight guard exited 1 before any dotnet command because it assumed original tests called the pipeline directly; the unchanged original tests call their existing Serve wrapper. The corrected guard traces that wrapper to the same public pipeline, retaining the identical positive selection. Both guard versions and failure facts are retained. No discovery/test was executed by the failed guard, no negative control was removed, and no test was rerun just for a guard change. The source includes safe selected-hold cleanup if expired-sticky retirement throws; held failure-injection/lease/race/alias/TOCTOU/custody/receipt audits were not performed.

All 22 execution issues and the added tracking row remain open in acceptance accounting: **0 issues and 0 of 237 criteria accepted**. No issue was closed, no metadata written and no PR merged. The table records the complete ownership list; earlier evidence stays bound to its original source and is not a new current acceptance run.

| Issue | Kind | Whole-issue acceptance | Remaining gate |
| --- | --- | --- | --- |
'''
for row in issues:
    gate = row['remainingGate'].replace('|', '\\|').replace('\n', ' ')
    md += f"| #{row['issue']} | {row['kind']} | {row['wholeIssueAcceptance']} | {gate} |\n"
(out / 'checkpoint.md').write_text(md)
manifest = {'schema': 'fsusblog.memory.ordinary-artifact-manifest.v1', 'sourceHead': source,
            'runId': pre['runId'], 'files': []}
for path in sorted(out.rglob('*')):
    if path.is_file():
        data = path.read_bytes()
        manifest['files'].append({'path': str(path.relative_to(out)), 'size': len(data), 'sha256': hashlib.sha256(data).hexdigest()})
(out / 'manifest.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'sourceSha': source, 'artifactPath': str(out.relative_to(root)), 'passedCases': 29,
                  'issueRows': len(issues), 'criteria': 237, 'accepted': 0, 'manifestFiles': len(manifest['files'])}))
