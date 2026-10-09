import json, subprocess, sys
from pathlib import Path
e = Path('/workspace/chain-3663-evidence/original-controls-recovery-20261009')
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
build = json.loads((e / 'original-test-project-build-frozen-bindings.json').read_text())
assert build['exitCode'] == 0 and build['testedSha'] == sha and build['cleanBefore'] and build['cleanAfter']
selector = (e / 'original-positive-filter.txt').read_text().strip()
assert selector and len(selector.split('|')) == 264 and all(s.startswith('FullyQualifiedName=') for s in selector.split('|'))
cmd = [sys.executable, str(e / 'capture.py'), 'original-exact-discovery', 'tools/build-with-data-env.sh', 'dotnet', 'test', 'tests/backend/FsusBlog.Server.Tests.csproj', '--no-build', '--no-restore', '--list-tests', '--filter', selector]
with (e / 'discovery-capture-output.log').open('w') as output:
    result = subprocess.run(cmd, stdout=output, stderr=subprocess.STDOUT)
print(json.dumps({'source':sha,'exitCode':result.returncode,'selectorMethods':264,'expectedCases':813,'entry':'originalProjectNoBuildNoRestoreListOnly'}))
sys.exit(result.returncode)
