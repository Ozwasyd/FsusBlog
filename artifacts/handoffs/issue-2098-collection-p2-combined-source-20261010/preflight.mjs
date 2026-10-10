import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {execFileSync,spawnSync} from 'node:child_process';
const root='/workspace/chain-1895-origin-export-successor/FsusBlog';
const out=path.dirname(new URL(import.meta.url).pathname);
const ts=createRequire(path.join(root,'src/frontend/package.json'))('typescript');
const counts={'tests/tools/layout-module-integration-source.test.mjs':125,'tests/tools/control-legality-ref-selectors.test.mjs':42,'tests/tools/layout-collection-source.test.mjs':278,'tests/tools/layout-slot-source.test.mjs':50,'tests/tools/layout-functional-source.test.mjs':89,'tests/tools/layout-target-source.test.mjs':58,'tests/tools/layout-router-view-source.test.mjs':20,'tests/tools/layout-composition-order-geometry.test.mjs':13,'tests/tools/layout-canonical-context-source.test.mjs':6,'tests/tools/layout-render-conjunction-source.test.mjs':12,'tests/tools/layout-standalone-props-source.test.mjs':20,'tests/tools/layout-render-declarations-source.test.mjs':8,'tests/tools/layout-returned-props-source.test.mjs':21,'tests/tools/layout-object-props-source.test.mjs':21,'tests/tools/layout-object-key-source.test.mjs':25,'tests/tools/layout-component-alternatives-source.test.mjs':16,'tests/tools/layout-script-constants-source.test.mjs':17,'tests/tools/layout-component-member-source.test.mjs':45,'tests/tools/layout-finite-component-source.test.mjs':23,'tests/tools/layout-script-render-source.test.mjs':33,'tests/tools/layout-factory-source.test.mjs':36,'tests/tools/layout-component-props-source.test.mjs':21,'tests/tools/layout-component-guards-source.test.mjs':10,'tests/tools/layout-composition-source.test.mjs':24,'tests/tools/control-legality.test.mjs':6};
const resolverNames=['actual app registration resolves an imported public component and rejects a shadow owner','unknown resolver callback and invalid template expressions fail closed','positive actual global import and direct adapter resolve the same public declaration','dynamic target, aliases, native TS render and parser corruption cannot evade discovery','ordinary native document structure is outside interaction registration','compiler-owned Vue structure preserves child controls; computed choices and recursion resolve'];
const held=['all twelve fixtures bind to actual router AST/import graph without a second map','actual contract, design and FsusUI digests are bound to the current run','order geometry real Chromium fixtures observe responsive flow and explicit limits'];
function check(ok,reason){if(!ok)throw new Error(reason);}
function nameValue(node,env){
 if(ts.isStringLiteral(node)||ts.isNoSubstitutionTemplateLiteral(node))return node.text;
 if(ts.isIdentifier(node)&&env.has(node.text))return env.get(node.text);
 if(ts.isTemplateExpression(node)){let v=node.head.text;for(const span of node.templateSpans){const x=nameValue(span.expression,env);check(typeof x==='string','unparsed dynamic selected test name');v+=x+span.literal.text;}return v;}
 return undefined;
}
try {
 const selections=[];
 for(const [file,count] of Object.entries(counts)){
  const text=fs.readFileSync(path.join(root,file),'utf8');const ast=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);check(ast.parseDiagnostics.length===0,'test-list parse failure: '+file);
  const names=[];const literalTables=new Map();for(const statement of ast.statements){if(ts.isVariableStatement(statement)&&statement.declarationList.flags&ts.NodeFlags.Const){for(const declaration of statement.declarationList.declarations){if(ts.isIdentifier(declaration.name)&&declaration.initializer&&ts.isArrayLiteralExpression(declaration.initializer)){check(!literalTables.has(declaration.name.text),'duplicate literal table');literalTables.set(declaration.name.text,declaration.initializer);}}}}
  function walk(node,env=new Map()){
   if(ts.isCallExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==='test') {const name=nameValue(node.arguments[0],env);check(typeof name==='string'&&name.length>0,'empty/unparsed test name: '+file);names.push(name);return;}
   if(ts.isForOfStatement(node)){
    const table=ts.isIdentifier(node.expression)?literalTables.get(node.expression.text):node.expression;check(table&&ts.isArrayLiteralExpression(table),'non-literal source control table: '+file);const declaration=node.initializer.declarations[0];
    for(const row of table.elements){const next=new Map(env);if(ts.isIdentifier(declaration.name)){next.set(declaration.name.text,nameValue(row,env));}else{check(ts.isObjectBindingPattern(declaration.name)===false&&ts.isArrayBindingPattern(declaration.name),'unknown loop binding');check(ts.isArrayLiteralExpression(row),'unknown loop row');declaration.name.elements.forEach((binding,index)=>{check(ts.isBindingElement(binding)&&ts.isIdentifier(binding.name),'unknown table binding');next.set(binding.name.text,nameValue(row.elements[index],env));});}walk(node.statement,next);}return;
   }
   if(ts.isFunctionDeclaration(node)||ts.isArrowFunction(node)||ts.isFunctionExpression(node))return;
   ts.forEachChild(node,child=>walk(child,env));
  }
  if(file.endsWith('/control-legality.test.mjs')){
   for(const statement of ast.statements){if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&ts.isIdentifier(statement.expression.expression)&&statement.expression.expression.text==='test'){const name=nameValue(statement.expression.arguments[0],new Map());if(resolverNames.includes(name))names.push(name);}}
  }else if((file.endsWith('/layout-composition-source.test.mjs')||file.endsWith('/layout-composition-order-geometry.test.mjs'))){
   for(const statement of ast.statements){if(ts.isExpressionStatement(statement)&&ts.isCallExpression(statement.expression)&&ts.isIdentifier(statement.expression.expression)&&statement.expression.expression.text==='test'){const name=nameValue(statement.expression.arguments[0],new Map());check(typeof name==='string','unparsed literal source regression');if(!held.includes(name))names.push(name);}}
  }else for(const statement of ast.statements)walk(statement);
  check(names.length===count&&new Set(names).size===count,'empty/duplicate/count mismatch: '+file+' actual='+names.length+' unique='+new Set(names).size+' expected='+count);
  check(names.every(name=>!held.includes(name)),'held test selected');
  const hooks=[];function hook(node){if(ts.isCallExpression(node)&&ts.isPropertyAccessExpression(node.expression)&&['before','after','beforeEach','afterEach'].includes(node.expression.name.text)){hooks.push(node.getText(ast));}ts.forEachChild(node,hook);}hook(ast);
  if(file.endsWith('/layout-slot-source.test.mjs')){check(hooks.length===2&&hooks[0]==='test.before(() => mkdirSync(directory, { recursive: true }))'&&hooks[1]==='test.after(() => rmSync(directory, { recursive: true, force: true }))','unreviewed slot hooks: '+file);}else if(file.endsWith('/control-legality-ref-selectors.test.mjs')){check(hooks.length===1&&hooks[0]==='t.after(() => fs.rmSync(root, { recursive: true, force: true }))','unreviewed per-case selector cleanup hook');check(!text.includes('registerHooks'),'alternate module resolution hook');}else if(file.endsWith('/layout-composition-order-geometry.test.mjs'))check(hooks.length===1&&hooks[0]==='context.after(async () => browser.close())'&&!names.includes('order geometry real Chromium fixtures observe responsive flow and explicit limits'),'unreviewed held browser cleanup hook');else check(hooks.length===1&&hooks[0].includes('rmSync')&&hooks[0].includes('recursive: true')&&hooks[0].includes('force: true'),'unreviewed hook: '+file);
  selections.push({file,expectedCount:count,names,fqns:names.map(name=>file+'::'+name),hooks,sourceSha256:createHash('sha256').update(text).digest('hex')});
 }
 const all=selections.flatMap(s=>s.names);check(all.length===new Set(all).size,'duplicate actual combined name count');
 const hookConfig=spawnSync('git',['config','--get','core.hooksPath'],{cwd:root,encoding:'utf8'});check(hookConfig.status===1&&!hookConfig.stdout,'unexpected Git hooks configuration');
 const hookDir=execFileSync('git',['rev-parse','--git-path','hooks'],{cwd:root,encoding:'utf8'}).trim();const hooksPath=path.resolve(root,hookDir);check(fs.readdirSync(hooksPath).every(name=>name.endsWith('.sample')),'active Git hook');
 const escaped=all.map(name=>name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'));
 const pattern='^(?:'+escaped.join('|')+')$';const compiled=new RegExp(pattern);check(all.every(name=>compiled.test(name)),'positive pattern construction failure');check(!held.some(name=>compiled.test(name)),'held pattern match');
 const args=['node','--test','--test-name-pattern='+pattern,...selections.map(s=>s.file)];
 const result={status:'passed',expectedCount:all.length,runner:'existing node --test runner; no replacement harness or shared gate change',selections,heldExcluded:held,gitHooks:{configuration:'unset (exit1 expected)',directory:hooksPath,active:[]},args};
 fs.writeFileSync(path.join(out,'positive-preflight.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({status:result.status,expectedCount:result.expectedCount,files:selections.map(({file,expectedCount})=>({file,expectedCount})),hooksReviewed:selections.length,heldExcluded:held}));
}catch(error){fs.writeFileSync(path.join(out,'positive-preflight-failed.json'),JSON.stringify({status:'failed',error:error.message,stopFurtherTestCommands:true})+'\n');console.error(error.message);process.exitCode=1;}
