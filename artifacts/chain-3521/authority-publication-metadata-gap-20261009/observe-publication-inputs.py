import hashlib
import json
from pathlib import Path
import subprocess

output = Path(__file__).parent
manifest_path = 'artifacts/change-contract/release-final-execution-target-authority-generated-binding.json'
index_path = 'config/testing/release-final-execution-authority-index.json'
owner_path = 'tests/browser-contract/public-shell-finite-input-owner.mjs'

def git(*args):
    return subprocess.check_output(['git', '--no-replace-objects', *args])

def blob(revision, path):
    return git('show', revision + ':' + path)

for name, revision, base in [
    ('saved-draft', '8b5aa9085cdb07d80db67326b7fc2d571964fac8', '73338cb1d727a2b36259b0dffffcfc1fbbbe80fb'),
    ('flow', '4ecf1f1abd6332054048672613512bdbe23c8069', '7499b5bd82d3ce888672abc2e054bb08736da08d'),
]:
    manifest = json.loads(blob(revision, manifest_path))
    changed = git('diff', '--name-only', base, revision).decode().splitlines()
    index = json.loads(blob(revision, index_path))
    fixture = manifest['outputs'][0]['path']
    remaining = [entry for entry in index['runtimeDynamicImports'] if entry['owner'] != owner_path]
    observation = {
        'kind': 'read-only Git blob and source-contract observation',
        'candidateCommit': revision,
        'comparisonBase': base,
        'changedFiles': changed,
        'manifestPath': manifest_path,
        'manifestChanged': manifest_path in changed,
        'declaredSources': [{'path': path, 'changed': path in changed,
                            'sha256': hashlib.sha256(blob(revision, path)).hexdigest()}
                           for path in manifest['sources']],
        'outputPath': fixture,
        'outputChanged': fixture in changed,
        'manifestOutputSha256': manifest['outputs'][0]['sha256'],
        'actualCommittedOutputSha256': hashlib.sha256(blob(revision, fixture)).hexdigest(),
        'indexChanged': index_path in changed,
        'indexSha256': hashlib.sha256(blob(revision, index_path)).hexdigest(),
        'publicShellPublisherRemainingImportCount': len(remaining),
        'publicShellPublisherRequiredRemainingImportCount': 47,
        'publicShellOwnerRegistrationCount': len(index['runtimeDynamicImports']) - len(remaining),
        'matrixChanged': 'tests/matrix.yml' in changed,
        'matrixSha256': hashlib.sha256(blob(revision, 'tests/matrix.yml')).hexdigest(),
        'originalCheckerExecuted': False,
        'publisherExecuted': False,
        'acceptanceGranted': False,
    }
    (output / (name + '-observation.json')).write_text(json.dumps(observation, indent=2) + '\n')
    print(json.dumps(observation))
