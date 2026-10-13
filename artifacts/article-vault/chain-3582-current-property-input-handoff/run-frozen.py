import pathlib,subprocess,json,datetime,hashlib,xml.etree.ElementTree as ET,collections,sys
root=pathlib.Path('/workspace/FsusBlog');out=root/'.tmp/chain-3582-expanded/property-3d177'
sha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip(); status=subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True);assert not status,status
paths=json.loads((out/'source-paths.json').read_text())
hashes=lambda:{p:hashlib.sha256((root/p).read_bytes()).hexdigest() for p in paths}
report={'source':sha,'supplier':'3d177f17fa34bdf322447f1ea917469d2c938869','baseline':'dfc2d8754caf67507068d779608f66305d9d6c79','fetchedMaster':'537bb3fa2f9ef54e0a2e93a925a4ce6fa335ceea','runIdentity':'chain3582-current-properties-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'),'startedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceFiles':hashes(),'scope':'ordinary exact new composition12 plus canonical current-property, foundation, finite planner/codec and retained property-merge regressions; controlled read ports only','qualification':{'DB':False,'HTTP':False,'productionProvider':False,'atomicFence':False,'native':False,'fullV1':False,'issueAccepted':False},'commands':[]}
filter='Scope=CurrentPropertyInputs|FullyQualifiedName~ArticlePackageCurrentPropertyReaderTests|FullyQualifiedName~ArticlePropertyValueFoundationTests|FullyQualifiedName~ArticlePackageManifestCandidateCodecTests|FullyQualifiedName~ArticlePackageManifestCandidatePlannerTests|FullyQualifiedName~ArticleVaultPropertyMetadataMergeTests|FullyQualifiedName~ArticleVaultPackagePropertyMetadataBridgeTests'
commands=[('restore',['dotnet','restore','tests/backend/FsusBlog.Server.Tests.csproj','--locked-mode']),('build',['dotnet','build','tests/backend/FsusBlog.Server.Tests.csproj','--no-restore','--configuration','Release','--verbosity','quiet']),('test',['dotnet','test','tests/backend/FsusBlog.Server.Tests.csproj','--configuration','Release','--no-build','--no-restore','--filter',filter,'--logger','trx;LogFileName=frozen-properties.trx','--results-directory',str(out)]),('style',['node','tools/dotnet/check-csharp-style.mjs',*[a for p in paths if p.endswith('.cs') for a in ['--file',p]]]),('docs',['node','tools/docs/generate-document-lifecycle.mjs','--check']),('authoritative-docs',['node','tools/docs/check-authoritative-docs.mjs'])]
for name,argv in commands:
 start=datetime.datetime.now(datetime.timezone.utc).isoformat()
 with (out/('frozen-'+name+'.log')).open('w') as f:r=subprocess.run(argv,cwd=root,stdout=f,stderr=subprocess.STDOUT)
 report['commands'].append({'argv':argv,'exitCode':r.returncode,'startedUtc':start,'endedUtc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'log':'frozen-'+name+'.log'})
 print(name,r.returncode,flush=True)
 if r.returncode:break
report['sdk']=subprocess.check_output(['dotnet','--version'],text=True).strip()
report['endSource']=subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip();report['endStatus']=subprocess.check_output(['git','status','--porcelain'],cwd=root,text=True);report['sourceUnchanged']=report['sourceFiles']==hashes()
report['assemblyHashes']={str(p.relative_to(root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in [root/'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll',root/'tests/backend/bin/Release/net10.0/FsusBlog.Server.dll',root/'tests/backend/bin/Release/net10.0/FsusBlog.Shared.dll']}
trx=out/'frozen-properties.trx'
if trx.exists():
 tree=ET.parse(trx);report['counts']=tree.find('.//{*}Counters').attrib
 definitions={e.attrib['id']:e.find('{*}TestMethod').attrib['className'].split(',')[0] for e in tree.findall('.//{*}UnitTest')}
 report['classCounts']=dict(collections.Counter(definitions[x.attrib['testId']] for x in tree.findall('.//{*}UnitTestResult')))
report['endedUtc']=datetime.datetime.now(datetime.timezone.utc).isoformat();(out/'frozen-result.json').write_text(json.dumps(report,indent=2)+'\n')
assert report['source']==report['endSource'] and not report['endStatus'] and report['sourceUnchanged']
assert all(x['exitCode']==0 for x in report['commands']) and len(report['commands'])==len(commands)
