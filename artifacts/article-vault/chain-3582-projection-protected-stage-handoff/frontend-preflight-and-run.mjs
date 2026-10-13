import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import path from 'node:path';
const root='/workspace/FsusBlog';
const frontend=path.join(root,'src/frontend');
const out=path.join(root,'.tmp/chain-3582-expanded/source-projection-composition',process.argv[2]);
if(!process.argv[2] || !/^[a-z0-9-]+$/.test(process.argv[2])) throw Error('explicit run identity required');
mkdirSync(out,{recursive:true});
const require=createRequire(path.join(frontend,'package.json'));
const ts=require('typescript');
const files=['tests/frontend/unit/articleVault/paragraphSourceMerge.test.ts','tests/frontend/unit/articleVault/threeWaySourceProjectionAdapter.test.ts'];
const counts={
 'Article Vault canonical projection and original paragraph composition':21,
 'Article Vault paragraph source computation with actual canonical parser':24,
 'Article Vault three-way source projection':32
};
const escape=s=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const methods=[];
for(const file of files){
 const ast=ts.createSourceFile(file,readFileSync(path.join(root,file),'utf8'),ts.ScriptTarget.Latest,true);
 for(const stmt of ast.statements){
  if(!ts.isExpressionStatement(stmt) || !ts.isCallExpression(stmt.expression) || stmt.expression.expression.getText(ast)!=='describe') continue;
  const group=stmt.expression.arguments[0].text;
  if(!Object.hasOwn(counts,group)) throw Error('unknown suite '+group);
  const body=stmt.expression.arguments[1].body;
  for(const child of body.statements){
   if(!ts.isExpressionStatement(child) || !ts.isCallExpression(child.expression)) throw Error('unexpected suite declaration');
   const call=child.expression; let cases=1;
   if(call.expression.getText(ast)!=='it'){
    if(!ts.isCallExpression(call.expression) || call.expression.expression.getText(ast)!=='it.each') throw Error('non-positive test selection');
    let table=call.expression.arguments[0];
    if(ts.isAsExpression(table))table=table.expression;
    if(!ts.isArrayLiteralExpression(table)||!table.elements.length)throw Error('nonliteral or empty parameter table');
    cases=table.elements.length;
   }
   const title=call.arguments[0].text;
   if(typeof title!=='string'||!title.length)throw Error('test name unavailable');
   const pattern='^'+escape(group+' > ')+escape(title).replace(/%j|%s/g,'.+')+'$';
   methods.push({file,group,title,cases,pattern});
  }
 }
}
for(const [group,total] of Object.entries(counts))if(methods.filter(m=>m.group===group).reduce((n,m)=>n+m.cases,0)!==total)throw Error('static expected method/case mismatch '+group);
const selector='^('+Object.keys(counts).map(escape).join('|')+') ';
if(methods.length===0 || !selector || files.length!==2)throw Error('empty selection');
function run(name,args){
 const command=[process.execPath,path.join(frontend,'node_modules/vitest/vitest.mjs'),...args];
 const start=new Date().toISOString();
 const r=spawnSync(command[0],command.slice(1),{cwd:frontend,env:{...process.env,FSUSBLOG_LOCAL_FSUSUI_ROOT:'/workspace/FsusUI',FSUSBLOG_VITEST_MAX_WORKERS:'1',FSUSBLOG_VITEST_REPORT_ID:path.basename(out)},encoding:'utf8',maxBuffer:32*1024*1024});
 writeFileSync(path.join(out,name+'.log'),(r.stdout??'')+(r.stderr??''));
 writeFileSync(path.join(out,name+'.command.json'),JSON.stringify({command,cwd:frontend,start,end:new Date().toISOString(),exitCode:r.status,error:r.error?.message??null},null,2)+'\n');
 if(r.status!==0||r.error)throw Error(name+' failed; no fallback permitted');
}
const shared=['--config','vitest.config.ts','--testNamePattern',selector];
run('discovery',['list',...files.map(f=>path.join(root,f)),...shared,'--json='+path.join(out,'discovery.json')]);
const items=JSON.parse(readFileSync(path.join(out,'discovery.json'),'utf8'));
if(!Array.isArray(items)||items.length!==77)throw Error('discovery count mismatch or empty selection');
if(new Set(items.map(i=>i.file+'\0'+i.name)).size!==77)throw Error('duplicate discovery');
for(const item of items){
 const file=path.relative(root,item.file);
 if(methods.filter(m=>m.file===file&&new RegExp(m.pattern).test(item.name)).length!==1)throw Error('unexpected discovered method '+item.name);
}
for(const m of methods)if(items.filter(i=>path.relative(root,i.file)===m.file&&new RegExp(m.pattern).test(i.name)).length!==m.cases)throw Error('discovered method/case mismatch '+m.title);
const hashes=Object.fromEntries([...files,'src/frontend/vitest.config.ts','src/frontend/vitest.shared.mjs','tests/frontend/support/unit/setup.ts','tests/frontend/support/unit/animationFrameEnvironment.ts','src/frontend/src/services/articleVault/paragraphSourceMerge.ts','src/frontend/src/services/articleVault/threeWaySourceProjectionAdapter.ts'].map(f=>[f,createHash('sha256').update(readFileSync(path.join(root,f))).digest('hex')]));
const sha=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).stdout.trim();
const ui=spawnSync('git',['rev-parse','HEAD'],{cwd:'/workspace/FsusUI',encoding:'utf8'}).stdout.trim();
writeFileSync(path.join(out,'preflight.json'),JSON.stringify({status:'PASS',sourceCommit:sha,fsusUiCommit:ui,counts,methods,selector,hashes,hooksInspection:{selectedFixture:'pure byte/value fixtures, real public FsusUI parser; no native writer, database, network, external resources or fixture hooks',workerAfterEach:'vi.restoreAllMocks()',rootHooks:'none; accessor spies are local vi.fn only',sharedSetup:'one HappyDOM Window, task-local animation timers; beforeAll activates local zh-CN locale graph, topology logging optional; afterAll disposes all timers; original AEDS/PoW/search mocks do not replace markdown runtime',scope:'ordinary exact original-project tests, not qualification or verified-input transport'},node:process.version,vitest:require('vitest/package.json').version},null,2)+'\n');
run('test',['run',...files.map(f=>path.join(root,f)),...shared,'--reporter=default','--reporter=json','--outputFile.json='+path.join(out,'results.json')]);
const result=JSON.parse(readFileSync(path.join(out,'results.json'),'utf8'));
if(result.numTotalTests!==77||result.numPassedTests!==77||result.numFailedTests!==0||result.numPendingTests!==0)throw Error('execution count/status mismatch');
console.log(JSON.stringify({sourceCommit:sha,fsusUiCommit:ui,counts,total:77,passed:result.numPassedTests,output:out}));
