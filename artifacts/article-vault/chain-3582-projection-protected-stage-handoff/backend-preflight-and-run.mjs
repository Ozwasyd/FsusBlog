import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readVstestDiscoveryDiagnostic } from '../../../tools/test/vstest-discovery-diagnostic.mjs';
const root='/workspace/FsusBlog';
const out=path.join(root,'.tmp/chain-3582-expanded/protected-stage-composition',process.argv[2]??'working');
fs.mkdirSync(out,{recursive:true});
const methods={
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.ProtectedStageComposition_SharesSoleWriterStorageAndExistingKeysWithoutIo':1,
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.ProtectedStageComposition_MissingOriginalOwnerLeavesRegistrationUnchanged':3,
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.ProtectedStageComposition_RefusesDuplicateAndCompetingEncryptedStorage':2,
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.EncryptedRecoveryComposition_RequiresProtectionAndUsesTheSoleStorageInstance':1,
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.EncryptedRecoveryComposition_BindsExistingKeysToActualProtectionWithoutCreatingOrReadingKeys':1,
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.BackupProtectionComposition_RequiresExistingKeyOwnerAndSharesTheActualProvider':1,
 'FsusBlog.Server.Tests.Unit.ArticleVaultRecoveryServiceRegistrationTests.ProductionComposition_ResolvesTheExistingPostgresCheckpointStoreWithinEachScope':1
};
const expected=10;
const names=Object.keys(methods);
if(names.length!==7||Object.values(methods).reduce((a,b)=>a+b,0)!==expected)throw Error('allowlist-count-invalid: no test execution');
if(process.env.FSUSBLOG_TEST_REDIS_DIAGNOSTICS)throw Error('unreviewed global diagnostic opt-in: no test execution');
const filter=names.map(n=>'FullyQualifiedName='+n).join('|');
if(!filter||!filter.split('|').every(n=>/^FullyQualifiedName=[A-Za-z0-9_.]+$/.test(n)))throw Error('positive-fqn-filter-invalid: no test execution');
const sourceFiles=['src/backend/Services/ArticleVault/ArticleVaultRecoveryStageComposition.cs','src/backend/Services/ArticleVault/PostgresArticleVaultOperationCheckpointStore.cs','src/backend/Infrastructure/Bootstrap/ArticleVaultRecoveryServiceCollectionExtensions.cs','tests/backend/Unit/ArticleVaultRecoveryServiceRegistrationTests.cs','tests/backend/Helpers/TestInfrastructure/RedisOperationFailureDiagnosticCollector.cs'];
const hashes=Object.fromEntries(sourceFiles.map(p=>[p,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')]));
const command=(argv,log)=>{
 const startedUtc=new Date().toISOString();const r=spawnSync('dotnet',argv,{cwd:root,encoding:'utf8',maxBuffer:64*1024*1024});
 fs.writeFileSync(path.join(out,log),String(r.stdout??'')+String(r.stderr??''));
 fs.writeFileSync(path.join(out,log+'.command.json'),JSON.stringify({argv:['dotnet',...argv],startedUtc,endedUtc:new Date().toISOString(),exitCode:r.status,signal:r.signal,error:r.error?.message??null},null,2)+'\n');
 if(r.error||r.signal||r.status!==0)throw Error('command failed; no next/test fallback: '+log);
};
const diagDir=path.join(out,'discovery');fs.mkdirSync(diagDir,{recursive:true});
command(['test','tests/backend/FsusBlog.Server.Tests.csproj','--configuration','Release','--no-build','--no-restore','--list-tests','--filter',filter,'--diag',path.join(diagDir,'union.txt')],'discovery.log');
const discovery=readVstestDiscoveryDiagnostic(diagDir,{expectedSource:path.join(root,'tests/backend/bin/Release/net10.0/FsusBlog.Server.Tests.dll')});
const selected=discovery.records.filter(r=>names.includes(r.fullyQualifiedName));
const actual=Object.fromEntries(names.map(n=>[n,selected.filter(r=>r.fullyQualifiedName===n).length]));
if(selected.length!==expected||names.some(n=>actual[n]!==methods[n]))throw Error('exact-case-count-mismatch: no test execution '+JSON.stringify(actual));
const preflight={sourceFiles:hashes,expectedCaseCount:expected,expectedMethods:methods,actualCaseCount:selected.length,actualMethods:actual,selected,filter,discoveryHostLogSha256:crypto.createHash('sha256').update(fs.readFileSync(discovery.file)).digest('hex'),fixtureReview:{selectedClass:'ArticleVaultRecoveryServiceRegistrationTests; no class/collection/assembly fixture or lifecycle hooks',newSetup:'Actual canonical writer/storage constructors with original NSubstitute execution/proposal/key ports; task-owned NpgsqlDataSource.Create only, no OpenConnection/SQL/HTTP/native writes',newCleanup:'NpgsqlDataSource, ServiceProvider and both scopes all disposed with using',existingControls:'Same controlled registration class; scoped DI and real provider types; no connection opened or credentials used',assemblyHook:'Original RedisOperationFailureDiagnosticCollector.Initialize opt-in absent; returns without resource hooks'},heldAudits:false,replacementHarness:false};
fs.writeFileSync(path.join(out,'preflight.json'),JSON.stringify(preflight,null,2)+'\n');
console.log('preflight verified exact positive FQNs='+names.length+' cases='+selected.length);
command(['test','tests/backend/FsusBlog.Server.Tests.csproj','--configuration','Release','--no-build','--no-restore','--filter',filter,'--logger','trx;LogFileName=protected-stage.trx','--results-directory',out],'working-tests.log');
console.log('original exact selected test command exit0');
