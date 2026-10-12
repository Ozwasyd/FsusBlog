"""Capture fixed producer/consumer source identity; execute no candidate code."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

if len(sys.argv) != 3:
    raise SystemExit('usage: capture-source-offer.py SOURCE_REPO APPLIED_MAIN_CHECKOUT')
source, consumer = (Path(value).resolve() for value in sys.argv[1:])
out = Path(__file__).resolve().parent
before = 'da0e8f0cd11ca2bfbe9d7e8e393c113717e8756e'
producer = '711265f6e0717dffd13aa078f82bc6118d0952d6'
main = '36d835088f310dd31d1e76ca240d5cc606dcbb65'
paths = ['src/frontend/src/services/authoring/articleDocumentContext.ts',
         'src/frontend/src/services/authoring/openArticleDocumentRegistry.ts',
         'tests/frontend/unit/authoring/retainedArticleDocumentHandle.test.ts',
         'tests/frontend/unit/authoring/articleDocumentRetainedAuthority.test.ts',
         'docs/architecture/authoring-workspace-snapshot-boundary.md',
         'artifacts/article-editor/retained-document-authority/preflight.md']

def git(root, *args):
    return subprocess.check_output(['git', *args], cwd=root)

def identity(data):
    return {'gitBlob': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest(),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'mode': '100644'}

assert git(consumer, 'rev-parse', 'HEAD').decode().strip() == main
patch = git(source, 'diff', '--binary', before, producer, '--', *paths)
(out / 'consumer-36d.patch').write_bytes(patch)
production = git(source, 'diff', '--binary', before, producer, '--', *paths[:2])
(out / 'production-36d.patch').write_bytes(production)
subprocess.run(['git', 'apply', '--reverse', '--check', str(out / 'consumer-36d.patch')], cwd=consumer, check=True)
subprocess.run(['git', 'diff', '--check'], cwd=consumer, check=True)
rows = []
for path in paths:
    original = git(source, 'show', f'{main}:{path}')
    donor = git(source, 'show', f'{producer}:{path}')
    postimage = (consumer / path).read_bytes()
    if path != 'docs/architecture/authoring-workspace-snapshot-boundary.md':
        assert postimage == donor, path
    rows.append({'path': path, 'before': identity(original), 'after': identity(postimage),
                 'donorRevision': producer, 'donor': identity(donor),
                 'composition': 'original owning doc increment applied to complete Main document' if path.startswith('docs/') else 'exact producer postimage'})
protected = 0
for item in git(source, 'ls-tree', '-rz', main).split(b'\0'):
    if not item:
        continue
    metadata, path = item.split(b'\t', 1)
    mode, kind, blob = metadata.decode().split()
    path = path.decode()
    if kind != 'blob' or path in paths:
        continue
    local = consumer / path
    data = os.readlink(local).encode() if mode == '120000' else local.read_bytes()
    assert identity(data)['gitBlob'] == blob, path
    protected += 1
result = {'schema': 'fsusblog.retained-authority-seals-source-offer.v1',
          'producerRevision': producer, 'consumerRevision': main, 'sourceBase': before,
          'patchSha256': hashlib.sha256(patch).hexdigest(), 'paths': rows,
          'productionPatchSha256': hashlib.sha256(production).hexdigest(),
          'productionApplyCheckExit': 0, 'productionApplyExit': 0, 'productionDiffCheckExit': 0,
          'protectedConsumerBlobsChecked': protected, 'protectedMismatches': [],
          'actualOrderedApplyCheckExit': 0, 'actualApplyExit': 0, 'appliedSourceDiffCheckExit': 0,
          'generator': {'path': Path(__file__).name, 'sha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest()},
          'qualification': False, 'candidateModulesImported': False}
(out / 'source-offer.json').write_text(json.dumps(result, indent=2) + '\n')
print(f'six-path actual consumer offer; {protected} other blobs preserved')
