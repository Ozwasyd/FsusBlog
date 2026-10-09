import copy
import hashlib
import json
import pathlib
import subprocess
import uuid
import xml.etree.ElementTree as ET

root = pathlib.Path.cwd()
work = root / '.tmp/memory/snapshot-registration-20261009'
out = root / 'artifacts/memory/snapshot-registration/3322805d1'
old = root / 'artifacts/memory/control-delivery/c9b9695b2'
source = '3322805d17a84cd923c446ccafaa934f7571a865'
policy = 'c9b9695b23f0c6aae6a80e61eda0cb172d14f35f'
policy_base = 'c1ac6630e86a899f4acf59283ea10a4fcdd69894'
authority = 'config/application/backend-configuration-contract.json'
reference = 'docs/configuration/backend-configuration-reference.generated.md'
producer = 'tools/configuration/check-backend-configuration-contract.mjs'

def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()

def blob(revision, path):
    return subprocess.check_output(['git', 'show', revision + ':' + path])

def binding(revision, path):
    data = blob(revision, path)
    return {'path': path, 'gitBlob': git('rev-parse', revision + ':' + path),
            'sha256': hashlib.sha256(data).hexdigest(), 'size': len(data)}

assert git('rev-parse', 'HEAD') == source
assert not git('status', '--porcelain')
pre = json.loads((work / 'preimages.json').read_text())
assert pre['base'] == '9505f974fb4c18830dc0e92e543e54747ac229fb'
assert sorted(git('diff', '--name-only', pre['base'], source).splitlines()) == sorted([authority, reference])
before_contract = json.loads(blob(pre['base'], authority))
contract = json.loads(blob(source, authority))
handoff = json.loads((old / 'snapshot-ownership-registration.json').read_text())
rows = [r for r in contract['applicationSettings'] if r['key'].startswith('PublicHotRead:SnapshotOwnership:')]
assert len(rows) == 12 and rows == handoff['rows']
retained = copy.deepcopy(contract)
retained['applicationSettings'] = [r for r in retained['applicationSettings'] if r not in rows]
assert retained == before_contract
for row in rows:
    assert row['owner'] == 'public-delivery' and row['runtimeOnly']
    assert row['environmentVariables'] == [] and row['requiredStatus'] == 'conditional'
    assert 'no repository defaults' in row['repositoryValuePolicy']
    assert 'omission refuses admission' in row['requiredWhen'] and 'default' not in row
for path in [authority, reference]:
    assert (root / path).read_bytes() == blob(source, path)
for path in [producer, 'tests/tools/backend-configuration-contract.test.mjs']:
    assert blob(source, path) == blob(pre['base'], path)
before = json.loads((work / 'before-report.json').read_text())
assert len(before['errors']) == 35
reports = [json.loads((work / name).read_text()) for name in
           ['after-report.json', 'fixed-point-report.json', 'final-report.json']]
for report in reports:
    assert sorted(report['errors']) == sorted(before['errors'])
    assert report['counts']['applicationSettings'] == 240
    assert report['counts']['environmentVariables'] == 242
assert (work / 'first-generated.sha256').read_text().strip() == hashlib.sha256(blob(source, reference)).hexdigest()
subprocess.run(['node', '--input-type=module', '-e',
    "import fs from 'node:fs'; import {renderBackendConfigurationReference as render} from './" + producer + "'; "
    "if(render(JSON.parse(fs.readFileSync('" + authority + "','utf8')))!==fs.readFileSync('" + reference + "','utf8')) "
    "throw Error('original renderer mismatch');"], check=True)
subprocess.run(['git', 'diff', '--check', pre['base'] + '..' + source], check=True)

changed = git('diff', '--name-only', policy_base, policy).splitlines()
assert len(changed) == 6
policy_files = []
for path in changed:
    assert blob(policy, path) == blob(source, path)
    item = binding(policy, path)
    item['status'] = 'modified' if subprocess.run(['git', 'cat-file', '-e', policy_base + ':' + path],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0 else 'added'
    item['baseGitBlob'] = git('rev-parse', policy_base + ':' + path) if item['status'] == 'modified' else None
    policy_files.append(item)
prior_paths = git('ls-tree', '-r', '--name-only', policy_base, '--', 'src/backend/Infrastructure/Memory').splitlines()
prior_paths += ['src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadStore.Runtime.cs',
                'src/backend/Infrastructure/PublicReadArtifacts/PublicHotReadFastPath.Serving.cs',
                'src/backend/Infrastructure/PublicReadArtifacts/PublicHotArtifactProjector.cs',
                'src/backend/Infrastructure/Bootstrap/RuntimeInfrastructureServiceCollectionExtensions.cs',
                'tests/backend/Unit/OwnedPublicHotReadSnapshotTests.cs',
                'src/backend/FsusBlog.Server.csproj', 'tests/backend/FsusBlog.Server.Tests.csproj']
prior = []
for path in sorted(set(prior_paths)):
    assert blob(policy_base, path) == blob(source, path)
    prior.append(binding(policy_base, path))
for path in ['src/backend/Services/SystemService.cs', 'src/backend/Entities/SystemConfig.cs',
             'src/backend/Interfaces/ISystemService.cs']:
    assert blob(source, path) == blob(pre['base'], path)

selected = json.loads((old / 'preflight.json').read_text())
assert selected['sourceSha'] == policy and len(selected['positiveFqnAllowlist']) == 19
assert len(selected['discoveredCases']) == 45 and selected['passedCases'] == 45
results = ET.parse(old / 'selected.trx').findall('.//{http://microsoft.com/schemas/VisualStudio/TeamTest/2010}UnitTestResult')
assert len(results) == 45 and all(r.attrib['outcome'] == 'Passed' for r in results)
fqns = selected['positiveFqnAllowlist']
assert selected['filter'] == '(' + '|'.join('FullyQualifiedName=' + f for f in sorted(fqns)) + ')&Category!=Integration&Fixture!=LocalRedis'
assert {case.split('(')[0].strip() for case in selected['discoveredCases']} == set(fqns)
portable_commands = [[arg.replace(selected['dataRoot'].removesuffix('/data'), '${OUTPUT_DIR}')
                     for arg in command] for command in selected['commands']]
selection = {'testedSource': policy, 'runId': selected['runId'], 'newPolicyCases': 39,
             'affectedPriorGroupCases': 6, 'positiveFqnAllowlist': fqns,
             'exactDiscoveredCases': selected['discoveredCases'], 'filter': selected['filter'],
             'commands': portable_commands, 'SDK': selected['sdk'],
             'environment': {'FSUSBLOG_DATA_ROOT': '${OUTPUT_DIR}/data'},
             'setup': 'Use the original owning test project, its documented toolchain and resolved locked dependencies; create OUTPUT_DIR/data.',
             'notRerunAtRegistrationCommit': True,
             'preflightSha256': hashlib.sha256((old / 'preflight.json').read_bytes()).hexdigest(),
             'trxSha256': hashlib.sha256((old / 'selected.trx').read_bytes()).hexdigest()}
issues = copy.deepcopy(json.loads((old / 'checkpoint.json').read_text())['issues'])
for issue in issues:
    issue['remainingGate'] = issue['remainingGate'].replace(
        'Twelve semantic registration rows/generated reference are an exact handoff to the shared registration owner.',
        'Twelve complete semantic entries and the original-producer reference are registered at ' + source + '; ordinary source closure only.')
    issue['remainingGate'] = issue['remainingGate'].replace(' and shared registration integration', '')
    issue['remainingGate'] = issue['remainingGate'].replace(', and shared registration integration', '')
    issue['remainingGate'] = issue['remainingGate'].replace(' and shared registration integration remain required', ' remain required')
assert len(issues) == 23 and sum(len(i.get('criteria', [])) for i in issues) == 237
assert all(i['wholeIssueAcceptance'] == 'NotAccepted' for i in issues)
record = {'schema': 'fsusblog.memory.snapshot-registration-checkpoint.v1',
          'runId': 'snapshot-registration-' + str(uuid.uuid4()), 'source': source,
          'preimageSource': pre['base'], 'policySource': policy, 'policyBase': policy_base,
          'latestFetchedOriginMaster': '9d72a1c93b297f719d8695a642cdfb1615cf1d51', 'masterIncorporated': False,
          'sourceRemoteReadbackConfirmed': True, 'preimages': pre['bindings'],
          'registrationChangedFiles': [binding(source, p) for p in [authority, reference]],
          'sourceChecks': {'patchReadOnlyApplyCheckExit': 0, 'applyIncludedAuthorityOnlyExit': 0,
              'entriesEqualPublishedHandoff': True, 'unrelatedContractValuesPreserved': True,
              'generatorUnchanged': True, 'generatedOutputCopiedOrHandEdited': False,
              'originalGeneratorFixedPoint': True, 'originalRendererEqualityExit': 0,
              'documentLifecycleExit': 0, 'whitespaceExit': 0},
          'configurationCheck': {'beforeExit': 1, 'firstGenerationExit': 1, 'fixedPointGenerationExit': 1,
              'finalReadOnlyExit': 1, 'beforeErrors': before['errors'], 'afterErrors': reports[-1]['errors'],
              'introducedErrors': [], 'removedErrors': [], 'counts': reports[-1]['counts']},
          'configurationCheckCommands': [
              ['node', producer, '--report-json', '${OUTPUT_DIR}/before-report.json'],
              ['node', producer, '--write-doc', '--report-json', '${OUTPUT_DIR}/after-report.json'],
              ['node', producer, '--write-doc', '--report-json', '${OUTPUT_DIR}/fixed-point-report.json'],
              ['node', producer, '--report-json', '${OUTPUT_DIR}/final-report.json']],
          'scope': {'defaultsAdded': False, 'environmentVariablesAdded': False, 'autoPromoted': False,
              'sharedSystemServiceSystemConfigInterfacesBootstrapChanged': False, 'rawSOURCELogsPublished': False,
              'PRMetadataChanged': False, 'merged': False},
          'notRun': ['The 45 managed cases were not rerun; their exact source/code bytes and original results are retained.',
              'Full configuration checker tool-test suite (existing 228-setting and zero-error assumptions). No test or checker policy changed.',
              'Held SOURCE/native/lease-race/alias/TOCTOU/custody/receipt audits and production/platform/Auto qualification.'],
          'remainingGates': ['Actual P01 frozen numerical model and qualified evidence.',
              'Canonical production projector admitted content/location/source inputs.',
              'Pre-existing35 configuration errors and unrelated original checker-test assumptions remain open with their owners.',
              'Whole issue/runtime/platform/default Auto qualification remains open.'],
          'issues': issues, 'acceptedIssues': 0, 'criteriaAccepted': 0}
out.mkdir(parents=True, exist_ok=False)
(out / 'producer.py').write_bytes(pathlib.Path(__file__).read_bytes())
for name, value in [('checkpoint.json', record), ('selection.json', selection),
                    ('source-review.json', {'policyBase': policy_base, 'policySource': policy,
                     'completePolicyIncrement': policy_files, 'registrationSource': source,
                     'completeRegistrationIncrement': record['registrationChangedFiles'],
                     'priorDependenciesBase': policy_base, 'priorDependencyFilesUnchanged': prior,
                     'priorDependencyInventoryIsNotRuntimeOrQualificationEvidence': True})]:
    (out / name).write_text(json.dumps(value, indent=2) + '\n')
(out / 'positive-fqns.txt').write_text('\n'.join(fqns) + '\n')
(out / 'discovered-cases.txt').write_text('\n'.join(selected['discoveredCases']) + '\n')
(out / 'filter.txt').write_text(selected['filter'] + '\n')
(out / 'changed-source.txt').write_text('Policy increment: ' + policy_base + '..' + policy + '\n' +
    '\n'.join(changed) + '\n\nRegistration increment: ' + pre['base'] + '..' + source + '\n' + authority + '\n' + reference + '\n')
manifest = [{'path': p.name, 'size': p.stat().st_size, 'sha256': hashlib.sha256(p.read_bytes()).hexdigest()}
            for p in sorted(out.iterdir()) if p.is_file()]
(out / 'manifest.json').write_text(json.dumps({'source': source, 'files': manifest}, indent=2) + '\n')
print(json.dumps({'source': source, 'registeredEntries': len(rows), 'configurationErrors': 35,
                  'introducedErrors': 0, 'policyFiles': len(policy_files), 'priorDependencyFiles': len(prior),
                  'fqns': len(fqns), 'originalPassedCases': len(results), 'runtimeTestsRerun': False}))
