"""Capture/apply exact original SDK source. No candidate products imported or run."""
import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

source, consumer = (Path(value).resolve() for value in sys.argv[1:])
root = Path(__file__).resolve().parent
base = 'b336802021483468e7ae0f9b7ca21ade2f45ad9d'
producer = '4781b34ae3dbe7e64d98aeb6b395393c383aae6f'
path = 'src/frontend/src/services/authoring/articleDocumentContext.ts'

def git(where, *args):
    return subprocess.check_output(['git', *args], cwd=where)

def identity(data):
    return {'gitBlob': hashlib.sha1(f'blob {len(data)}\0'.encode() + data).hexdigest(),
            'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data), 'mode': '100644'}

assert git(consumer, 'rev-parse', 'HEAD').decode().strip() == base
assert git(consumer, 'status', '--porcelain') == b''
patch = git(source, 'diff', '--binary', base, producer, '--', path)
output = root / 'production-main-b336.patch'
output.write_bytes(patch)
for args in [['apply', '--check', str(output)], ['apply', str(output)], ['diff', '--check'],
             ['apply', '--reverse', '--check', str(output)]]:
    subprocess.run(['git', *args], cwd=consumer, check=True)
before = git(source, 'show', f'{base}:{path}')
after = git(source, 'show', f'{producer}:{path}')
assert (consumer / path).read_bytes() == after
protected = 0
for entry in git(source, 'ls-tree', '-rz', base).split(b'\0'):
    if not entry:
        continue
    metadata, name = entry.split(b'\t', 1)
    mode, kind, blob = metadata.decode().split()
    name = name.decode()
    if kind != 'blob' or name == path:
        continue
    target = consumer / name
    data = os.readlink(target).encode() if mode == '120000' else target.read_bytes()
    assert identity(data)['gitBlob'] == blob, name
    protected += 1
record = {'schema': 'fsusblog.attachment-revision-production-source-offer.v1',
          'producer': producer, 'consumerBase': base,
          'path': path, 'before': identity(before), 'after': identity(after),
          'patchSha256': hashlib.sha256(patch).hexdigest(), 'applyCheckExit': 0,
          'applyExit': 0, 'appliedDiffCheckExit': 0, 'reverseCheckExit': 0,
          'protectedConsumerBlobsChecked': protected, 'protectedMismatches': [],
          'UI': '8130a71b4e30441f67fa6183c5cdfa060db87426',
          'generatorSha256': hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
          'candidateModulesImported': False, 'qualification': False}
(root / 'production-source-offer.json').write_text(json.dumps(record, indent=2) + '\n')
print(f'one exact production postimage; {protected} other Main blobs identical')
