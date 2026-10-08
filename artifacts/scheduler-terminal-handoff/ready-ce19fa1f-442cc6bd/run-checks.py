import json,os,pathlib,subprocess,sys
kind=sys.argv[1]; root=os.getcwd(); dest=pathlib.Path('/tmp/scheduler-ready-evidence')/kind;dest.mkdir(exist_ok=True)
env=os.environ.copy();env['PATH']='/tmp/node-v24.16.0-linux-x64/bin:/tmp/scheduler-terminal-markdown-toolchain/node_modules/.bin:'+env['PATH']
node='/tmp/node-v24.16.0-linux-x64/bin/node'
if kind=='producer':
 checks=[('preflight',[node,'/tmp/scheduler-ready-evidence/preflight.mjs','tests/tools/scheduler-producer-terminal.test.mjs']),('ordinary-real-child',[node,'--test','tests/tools/scheduler-producer-terminal.test.mjs']),('eslint',['tools/frontend/style-toolchain/node_modules/.bin/eslint','tests/tools/scheduler-producer-terminal.test.mjs','tools/test-fixtures/producers/spawn-helper.mjs']),('markdown',['markdownlint-cli2','--no-globs','tools/test-matrix/scheduler-producer-terminal.md']),('change-contract',[node,'tools/governance/check-change-contract.mjs','--range','daa14c2f54be6961791aa2eb77166e762355915f..HEAD']),('diff-check',['git','diff','--check','daa14c2f54be6961791aa2eb77166e762355915f..HEAD'])]
else:
 checks=[('preflight',[node,'/tmp/scheduler-ready-evidence/preflight.mjs','tests/tools/scheduler-committed-evidence-readback.test.mjs','tests/tools/release-final-verified-authority-binding.test.mjs']),('ordinary-readback-api',[node,'--test','tests/tools/scheduler-committed-evidence-readback.test.mjs']),('ordinary-actual-consumer',[node,'--test','--test-name-pattern','^ordinary committed final output consumes the actual scheduler API and retains the wrapper digest without qualification$','tests/tools/release-final-verified-authority-binding.test.mjs']),('eslint',['tools/frontend/style-toolchain/node_modules/.bin/eslint','tools/test-matrix/scheduler.mjs','tests/tools/scheduler-committed-evidence-readback.test.mjs','tests/tools/support/canonical-scheduler-fixture.mjs']),('markdown',['markdownlint-cli2','--no-globs','tools/test-matrix/scheduler-committed-evidence-readback.md']),('change-contract',[node,'tools/governance/check-change-contract.mjs','--range','aeaf10e6f9fa215312c97d07c76c00ca55ed9e23..HEAD']),('diff-check',['git','diff','--check','aeaf10e6f9fa215312c97d07c76c00ca55ed9e23..HEAD'])]
records=[];source=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip()
for label,cmd in checks:
 p=subprocess.run(cmd,env=env,text=True,stdout=subprocess.PIPE,stderr=subprocess.STDOUT)
 (dest/(label+'.log')).write_text(p.stdout)
 records.append({'name':label,'argv':cmd,'cwd':root,'source':source,'exitCode':p.returncode,'log':label+'.log'})
 print(json.dumps({'name':label,'exitCode':p.returncode,'source':source}),flush=True)
 if 'ordinary' in label or p.returncode:print(p.stdout[-5000:],flush=True)
 if label=='preflight' and p.returncode:break
(dest/'commands.json').write_text(json.dumps(records,indent=2)+'\n')
sys.exit(any(x['exitCode'] for x in records))
