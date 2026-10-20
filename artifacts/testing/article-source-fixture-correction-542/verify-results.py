from pathlib import Path
import collections,gzip,json,hashlib,subprocess,xml.etree.ElementTree as E
p=Path(__file__).parent;root=Path('/workspace/FsusBlog');ns={'t':'http://microsoft.com/schemas/VisualStudio/TeamTest/2010'}
def read(f):
 b=f.read_bytes();b=gzip.decompress(b) if f.suffix=='.gz' else b;r=E.fromstring(b).findall('.//t:UnitTestResult',ns);return b,{x.attrib['testName']:x for x in r},r
raw,current,rows=read(p/'backend-full731.trx');_,old,oldrows=read(root/'artifacts/testing/article-source-hooks-80a/current728.trx.gz');_,migration,migrationrows=read(p/'migration182.trx');source=(p/'candidate.txt').read_text().strip()
report={'source':source,'counts':dict(collections.Counter(x.attrib['outcome'] for x in rows)),'total':len(rows),'uniqueNames':len(current),'frozen80':{'retained':len(old.keys()&current.keys()),'missing':sorted(old.keys()-current.keys()),'changedTestIds':[{'name':n,'old':old[n].attrib['testId'],'current':current[n].attrib['testId']} for n in old.keys()&current.keys() if old[n].attrib['testId']!=current[n].attrib['testId']],'currentOutcomes':dict(collections.Counter(current[n].attrib['outcome'] for n in old if n in current))},'newCases':[dict(current[n].attrib) for n in sorted(current.keys()-old.keys())],'originalCoverage':{},'failures':[{'name':x.attrib['testName'],'testId':x.attrib['testId'],'outcome':x.attrib['outcome'],'message':x.findtext('.//t:Message',namespaces=ns),'stack':x.findtext('.//t:StackTrace',namespaces=ns)} for x in rows if x.attrib['outcome']!='Passed'],'migration':{'counts':dict(collections.Counter(x.attrib['outcome'] for x in migrationrows)),'native22':dict(collections.Counter(x.attrib['outcome'] for n,x in migration.items() if '.ArticleMigrationSourceEnrollmentContractTests.' in n))},'sha256':{'backend-full731.trx':hashlib.sha256(raw).hexdigest()},'roster':[dict(x.attrib) for n,x in sorted(current.items())]}
for stem in ['original433','previous480','previous610','current619']:
 _,prior,_=read(root/f'artifacts/testing/article-source-hooks-46b/{stem}.trx.gz');report['originalCoverage'][stem]={'total':len(prior),'retained':len(prior.keys()&current.keys()),'missing':sorted(prior.keys()-current.keys()),'currentOutcomes':dict(collections.Counter(current[n].attrib['outcome'] for n in prior if n in current))}
_,supplier,_=read(p.parent.parent/'supplier-baseline.trx');report['supplier']={'unit23':dict(collections.Counter(current[n].attrib['outcome'] if n in current else 'MISSING' for n in supplier if '.Unit.' in n)),'pg33':dict(collections.Counter(current[n].attrib['outcome'] if n in current else 'MISSING' for n in supplier if '.Integration.' in n))}
for group in ['ArticleSourceMutationHooksIntegrationTests','SourceReceiptSchemaCoveragePostgresTests','CurrentSchemaIndexExpressionPostgresTests','CurrentSchemaOwnedProjectionExporterTests','CurrentSchemaRuntimeRollupTablesDatabaseTests','ScheduledPublish']:
 report.setdefault('groups',{})[group]=dict(collections.Counter(x.attrib['outcome'] for n,x in current.items() if group in n))
report['productionSourceChangedFrom80']=subprocess.check_output(['git','diff','--name-only','80a33e47d0d775aa6b445dfd994146a5c84fd745','--','src'],text=True).splitlines()
binding=json.loads((p/'binary-binding-before.json').read_text());report['binaryChangedDuringTests']=[f for f,h in binding['binarySha256'].items() if hashlib.sha256(Path(f).read_bytes()).hexdigest()!=h]
(p/'current-summary.json').write_text(json.dumps(report,indent=2)+'\n');print(json.dumps({k:v for k,v in report.items() if k not in ['roster','failures']},indent=2))
assert len(rows)==len(current)==731
assert report['counts']=={'Passed':731}
assert report['frozen80']['retained']==728 and not report['frozen80']['missing'] and not report['frozen80']['changedTestIds']
assert len(report['newCases'])==3 and all('OriginalProductionDdl_RejectsNegativeCounterUpdatesWithoutChangingOriginalClock' in x['testName'] for x in report['newCases'])
assert all(not v['missing'] and v['currentOutcomes']=={'Passed':v['total']} for v in report['originalCoverage'].values())
assert report['supplier']=={'unit23':{'Passed':23},'pg33':{'Passed':33}}
assert report['migration']=={'counts':{'Passed':182},'native22':{'Passed':22}}
assert not report['productionSourceChangedFrom80'] and not report['binaryChangedDuringTests']
