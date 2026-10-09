import json,subprocess,os,re,collections,pathlib,sys
root=pathlib.Path('/workspace/FsusBlog-writer-owned-upload-2246'); a=root/'.tmp/chain-2246/writer-owned-upload'/(sys.argv[2] if len(sys.argv)>2 else sys.argv[1]);a.mkdir(exist_ok=True)
env=os.environ.copy(); env['PATH']='/workspace/.toolchains/chain2246-node2416/node-v24.16.0-linux-x64/bin:'+env['PATH']; env['FSUSBLOG_LOCAL_FSUSUI_ROOT']='/workspace/FsusUI-palette-2246'
groups={
 'positive': {'composables/useAdminArticleWrite.ownedUploadObservation.test.ts':12},
 'regression': {'composables/useImageUploadRuntime.test.ts':26,
    'services/authoring/articleAttachmentUploadProvider.test.ts':27,
    'services/authoring/articleAttachmentBusinessState.test.ts':26,
    'services/authoring/articleAttachmentFactsBusiness.test.ts':3, 'api/upload.test.ts':5,
    'authoring/articleAttachmentBusinessIntentReader.test.ts':21,
    'authoring/articlePreviewCurrentAuthorities.test.ts':16,
    'composables/useAdminArticleWrite.authoringGates.test.ts':15,
    'composables/useAdminArticleWrite.previewCurrentAuthorities.test.ts':9},
 'legacy': {'composables/useAdminArticleWrite.uploadProviderInputs.test.ts':2}
}
expected=groups[sys.argv[1]];total=sum(expected.values())
files=['../../tests/frontend/unit/'+file for file in expected]
base=['node','node_modules/vitest/vitest.mjs']; args=['--config','vitest.config.ts']+files
commands=[]
def run(key,argv):
 with (a/(key+'.log')).open('w') as f: result=subprocess.run(argv,cwd=root/'src/frontend',env=env,stdout=f,stderr=subprocess.STDOUT)
 commands.append(dict(key=key,args=argv,exitCode=result.returncode)); (a/'positive-command.json').write_text(json.dumps(commands,indent=2))
 if result.returncode: print((a/(key+'.log')).read_text()); sys.exit(result.returncode)
run('collect',base+['list']+args+['--json',str(a/'positive-list.json')])
rows=json.loads((a/'positive-list.json').read_text()); counts=collections.Counter(pathlib.Path(x['file']).name for x in rows)
assert counts=={pathlib.Path(file).name:count for file,count in expected.items()},counts
names=[x['name'].replace(' > ',' ') for x in rows]; assert len(names)==len(set(names))==total
pattern='^(?:'+'|'.join(re.escape(x) for x in names)+')$'
hooks={}
for file in files:
 s=(root/'src/frontend'/file).read_text(); assert not re.search(r'\.(only|skip|todo|fails)\b',s)
 hooks[file]={x:len(re.findall(x+r'\(',s)) for x in ['beforeEach','afterEach','enableAutoUnmount']}
(a/'admission.json').write_text(json.dumps(dict(counts=counts,names=names,hooks=hooks,pattern=pattern),indent=2))
run('runtime-collect',base+['list']+args+['--testNamePattern',pattern,'--json',str(a/'runtime-positive-list.json')])
assert sorted((x['file'],x['name']) for x in json.loads((a/'runtime-positive-list.json').read_text()))==sorted((x['file'],x['name']) for x in rows)
run('unit',base+['run']+args+['--testNamePattern',pattern,'--reporter=default','--reporter=json','--outputFile='+str(a/'unit-results.json')])
r=json.loads((a/'unit-results.json').read_text()); assert r['success'] and r['numTotalTests']==r['numPassedTests']==total and r['numFailedTests']==r['numPendingTests']==r['numTodoTests']==0
print(f'Exact{total} {sys.argv[1]} controls PASS; original hooks retained.')
