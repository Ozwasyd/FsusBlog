const ts=require('/workspace/chain1975-runtime-attempt-borrow/src/frontend/node_modules/typescript');
const fs=require('fs'),cp=require('child_process'),crypto=require('crypto');
const file='tests/frontend/unit/composables/useImageUploadRuntime.test.ts',base='04195f8a0d2ad16d14c8d66a2f876c428e606f3e';
function calls(text){const sf=ts.createSourceFile(file,text,ts.ScriptTarget.Latest,true),out=[];function visit(n){if(ts.isCallExpression(n)&&['it','beforeEach','afterEach'].includes(n.expression.getText(sf)))out.push({kind:n.expression.getText(sf),text:n.getText(sf)});ts.forEachChild(n,visit)}visit(sf);return out}
const original=calls(cp.execFileSync('git',['show',`${base}:${file}`],{encoding:'utf8'})),current=calls(fs.readFileSync(file,'utf8'));
const rows=original.map(o=>({kind:o.kind,unchanged:current.some(c=>c.text===o.text),sha256:crypto.createHash('sha256').update(o.text).digest('hex')}));
const result={testedSource:cp.execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),base,parser:ts.version,originalTests:rows.filter(x=>x.kind==='it').length,rows};
fs.writeFileSync('/workspace/chain-1975-evidence/runtime-review-repair-20261010/final-original11-and-hooks.json',JSON.stringify(result,null,2)+'\n');
if(rows.some(x=>!x.unchanged)||result.originalTests!==11)process.exit(1);
console.log('Original11 full calls and every original hook unchanged; TS '+ts.version);
