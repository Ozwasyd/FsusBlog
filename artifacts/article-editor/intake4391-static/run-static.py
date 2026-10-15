import datetime
import json
import os
import pathlib
import subprocess

evidence = pathlib.Path('/workspace/intake4391-evidence')
env = dict(os.environ, FSUSBLOG_USE_LOCAL_FSUSUI='1', FSUSBLOG_LOCAL_FSUSUI_ROOT='/workspace/FsusUI-intake4391-ui973')
commands = {
    'application': ['node', 'src/frontend/scripts/run-local-fsusui-typecheck.mjs', '--application'],
    'full-style': ['node', 'tools/frontend/check-frontend-style.mjs', '--mode', 'full'],
    'strict-owned': ['node', 'tools/frontend/check-frontend-style.mjs', '--mode', 'strict-full', '--file', 'src/frontend/src/composables/article/useCodeBlockCopy.ts', '--file', 'src/frontend/src/assets/markdown.css'],
    'boundary': ['node', 'tests/frontend/checks/static/check-fsusui-boundary.mjs'],
    'binary-boundary': ['node', 'tests/frontend/checks/static/check-binary-import-boundaries.mjs'],
    'code-intent': ['node', 'tools/governance/check-code-intent.mjs'],
    'lifecycle': ['node', 'tools/docs/generate-document-lifecycle.mjs', '--check'],
    'authoritative': ['node', 'tools/docs/check-authoritative-development-docs.mjs'],
}
import sys
selection = sys.argv[1:]
records = []
for stage, root in [('base', '/workspace/FsusBlog-intake4391-base'), ('candidate', '/workspace/FsusBlog-intake4391')]:
    if os.environ.get('INTAKE4391_STAGE') and os.environ['INTAKE4391_STAGE'] != stage:
        continue
    for label in selection:
        command = commands[label]
        started = datetime.datetime.now(datetime.timezone.utc).isoformat()
        with (evidence / f'{stage}-{label}.log').open('wb') as output:
            result = subprocess.run(command, cwd=root, env=env, stdout=output, stderr=subprocess.STDOUT)
        (evidence / f'{stage}-{label}.exit').write_text(str(result.returncode) + '\n')
        records.append(dict(stage=stage, cwd=root, argv=command, environment={k:env[k] for k in ['FSUSBLOG_USE_LOCAL_FSUSUI','FSUSBLOG_LOCAL_FSUSUI_ROOT']}, started=started, completed=datetime.datetime.now(datetime.timezone.utc).isoformat(), exitCode=result.returncode, log=f'{stage}-{label}.log'))
        print(stage, label, result.returncode, flush=True)
    (evidence / ('runs-' + os.environ.get('INTAKE4391_STAGE', 'both') + '-' + '-'.join(selection) + '.json')).write_text(json.dumps(records, indent=4) + '\n')
