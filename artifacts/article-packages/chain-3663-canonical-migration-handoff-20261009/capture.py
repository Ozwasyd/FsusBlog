import datetime
import json
import os
from pathlib import Path
import shlex
import subprocess
import sys

evidence = Path('/workspace/chain-3663-evidence/canonical-migration-handoff-20261009')
name = sys.argv[1]
command = sys.argv[2:]
env = os.environ.copy()
scoped = {
    'PATH': '/workspace/chain-3663-evidence/parallel-checks/markdown-tooling/node_modules/.bin:/workspace/toolchains/chain-3663/node/node-v24.16.0-linux-x64/bin:/workspace/toolchains/chain-3663/dotnet-pinned:' + env['PATH'],
    'DOTNET_ROOT': '/workspace/toolchains/chain-3663/dotnet-pinned',
    'DOTNET_CLI_HOME': '/workspace/toolchains/chain-3663/cache/dotnet-cli',
    'FSUSBLOG_DATA_ROOT': '/workspace/chain-3663-data/canonical-migration-handoff-20261009',
    'FSUSBLOG_DOTNET_DEPENDENCY_CACHE_ROOT': '/workspace/toolchains/chain-3663/cache',
    'MSBUILDDISABLENODEREUSE': '1',
}
env.update(scoped)
sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
status = subprocess.check_output(['git', 'status', '--porcelain'], text=True)
start = datetime.datetime.now(datetime.timezone.utc).isoformat()
(evidence / (name + '.command')).write_text(' '.join(shlex.quote(k + '=' + v) for k, v in scoped.items()) + ' ' + shlex.join(command) + '\n')
with (evidence / (name + '.log')).open('w') as log:
    run = subprocess.run(command, env=env, stdout=log, stderr=subprocess.STDOUT)
end_sha = subprocess.check_output(['git', 'rev-parse', 'HEAD'], text=True).strip()
end_status = subprocess.check_output(['git', 'status', '--porcelain'], text=True)
(evidence / (name + '.exit')).write_text(str(run.returncode) + '\n')
report = {'command': command, 'testedSha': sha, 'cleanBefore': not status, 'startUtc': start,
          'endUtc': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'exitCode': run.returncode,
          'shaUnchanged': end_sha == sha, 'cleanAfter': not end_status, 'log': str(evidence / (name + '.log'))}
(evidence / (name + '.json')).write_text(json.dumps(report, indent=4) + '\n')
print(json.dumps(report))
sys.exit(run.returncode)
