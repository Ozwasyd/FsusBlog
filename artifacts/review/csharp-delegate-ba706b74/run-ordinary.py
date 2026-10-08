import datetime,hashlib,json,pathlib,re,subprocess,sys
root=pathlib.Path.cwd(); out=root/'.tmp/csharp-delegate'
names=[
 'C# style governance accepts Roslyn expression braces and multiline verbatim content',
 'C# style governance aggregates tabs braces indentation using naming and line-ending failures',
 'parameter attributes keep framework enum arguments separate from multiline parameter names',
 'C# source lexer preserves the three character-class regex match contracts',
 'C# source lexer retains real array and generic naming and declaration refusals',
 'contextual record expressions do not exempt lowercase types named with',
 'singular Miss enums and plural flags retain both naming refusal controls',
 'array-valued attributes retain genuine contextual record expressions',
 'delegate declarations check the actual name across native and C# return-type syntax',
 'delegate declarations retain naming refusals for each return-type syntax',
 *['parameter attributes still reject an uppercase '+n for n in ['first multiline parameter','continuation parameter','named attribute argument','multiple attributes','ordinary parameter']]]
assert len(names)==15
source=(root/'tests/tools/csharp-style.test.mjs').read_text()
for name in names[:10]: assert "test('"+name+"'" in source
scope={'kind':'positive-ordinary-case-list-before-execution','expectedCount':15,'allowedNames':names,'heldCasesExcluded':'baseline/rebind/history/receipt/cohort/held audits and Git-replacement controls; no aggregate run','deniedEquivalentControlsCreated':False}
(out/'positive-test-scope.json').write_text(json.dumps(scope,indent=2)+'\n')
pattern='^(?:'+'|'.join(re.escape(name) for name in names)+')$'
cmd=['node','--test','--test-name-pattern='+pattern,'tests/tools/csharp-style.test.mjs']
head=subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip();start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with (out/'ordinary-15-current.log').open('w') as log: result=subprocess.run(cmd,stdout=log,stderr=subprocess.STDOUT)
log=(out/'ordinary-15-current.log').read_text();match=re.search(r'^ℹ tests (\d+)$',log,re.M)
observation={'kind':'actual-ordinary-source-test-observation-not-qualification','headBefore':head,'headAfter':subprocess.check_output(['git','rev-parse','HEAD'],text=True).strip(),'argv':cmd,'startedAtUtc':start,'endedAtUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exitCode':result.returncode,'expectedCount':15,'actualCount':int(match[1]) if match else None,'log':'ordinary-15-current.log','logSha256':hashlib.sha256(log.encode()).hexdigest(),'heldControlsExecuted':False}
(out/'ordinary-15-current.json').write_text(json.dumps(observation,indent=2)+'\n');print(json.dumps(observation,indent=2));assert observation['actualCount']==15;sys.exit(result.returncode)
