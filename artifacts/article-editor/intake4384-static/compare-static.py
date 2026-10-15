import pathlib, json, re, collections, hashlib

out = pathlib.Path('/workspace/intake4384-evidence')
target = 'src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue'
checks = ['types', 'node-types', 'strict-full', 'full-style', 'fsusui-boundary', 'binary-boundary', 'code-intent', 'lifecycle', 'authoritative', 'strict-owned']
results = {}
def normalize(s):
    s = re.sub(r'\(\d+,\d+\)(?=: error TS)', '(POSITION)', s)
    return re.sub(r'^(\[frontend-style\] [^:\n]+):\d+:\d+(?= )', r'\1:POSITION', s, flags=re.M)
for name in checks:
    a = (out / ('base-' + name + '.txt')).read_bytes()
    b = (out / ('candidate-' + name + '.txt')).read_bytes()
    sa, sb = a.decode(), b.decode()
    na, nb = normalize(sa), normalize(sb)
    ca, cb = collections.Counter(na.splitlines()), collections.Counter(nb.splitlines())
    row = {'baseExit': int((out / ('base-' + name + '.exit')).read_text()), 'candidateExit': int((out / ('candidate-' + name + '.exit')).read_text()), 'baseLines': len(sa.splitlines()), 'candidateLines': len(sb.splitlines()), 'rawByteIdentical': a == b, 'completePositionNormalizedOutputIdentical': na == nb, 'normalization': 'Only TS diagnostic source coordinates and frontend-style finding source coordinates; no filtering, diagnostic deletion or deduplication.', 'addedRowsWithMultiplicity': list((cb-ca).elements()), 'removedRowsWithMultiplicity': list((ca-cb).elements()), 'baseSHA256': hashlib.sha256(a).hexdigest(), 'candidateSHA256': hashlib.sha256(b).hexdigest()}
    if name in ['types', 'node-types']:
        row['baseDiagnostics'] = len(re.findall(r': error TS\d+:', sa))
        row['candidateDiagnostics'] = len(re.findall(r': error TS\d+:', sb))
    if name in ['strict-full', 'full-style', 'strict-owned']:
        row['baseOwnedFindings'] = sum(target in x for x in sa.splitlines())
        row['candidateOwnedFindings'] = sum(target in x for x in sb.splitlines())
        row['outsideOwnedRawLinesIdentical'] = [x for x in sa.splitlines() if target not in x] == [x for x in sb.splitlines() if target not in x]
    results[name] = row
for name in ['app-config', 'effective-config']:
    a=(out/('base-'+name+'.snapshot.json')).read_bytes(); b=(out/('candidate-'+name+'.snapshot.json')).read_bytes()
    results[name]={'byteIdentical':a==b, 'baseSHA256':hashlib.sha256(a).hexdigest(), 'candidateSHA256':hashlib.sha256(b).hexdigest()}
(out/'static-comparison.json').write_text(json.dumps(results,indent=4)+'\n')
print(json.dumps(results,indent=2))
