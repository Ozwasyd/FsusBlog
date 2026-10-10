import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createCompositionSource} from '../FsusBlog/tests/frontend/support/layout/compositionSource.mjs';
const repositoryRoot='/workspace/chain-1895-origin-export-successor/FsusBlog';
const fsusUIRoot='/workspace/chain-1895-component-prop-source/FsusUI';
const directory=mkdtempSync(join(tmpdir(),'central-original-bare-h-'));
test.after(()=>rmSync(directory,{recursive:true,force:true}));
const observations=[];
function fixture(name,text){const file=join(directory,name);writeFileSync(file,text);return file;}
function source(){return createCompositionSource({repositoryRoot,fsusUIRoot});}
test('sealed parser genuine fresh JSX sibling',()=>{
 const text='export default()=> <button><span>actual</span></button>;';
 const entry=fixture('Sibling.tsx',text);const s=source();const first=s.graph([entry]);
 observations.push({name:'preceding fresh JSX sibling',entry,text,errors:first.errors,nodeCount:first.nodes.length});
 writeFileSync(new URL('bare-h-original-observations.json',import.meta.url),JSON.stringify(observations,null,2)+'\n');
 assert.deepEqual(first.errors,[]);
});
test('sealed parser genuine repeated Vue h real default slot',()=>{
 const text="import {h} from 'vue';export default()=>h('button',{},'actual');";
 const entry=fixture('Entry.ts',text);const s=source();const first=s.graph([entry]);
 observations.push({name:'sealed parser genuine repeated Vue h real default slot',entry,text,errors:first.errors,nodeCount:first.nodes.length,assertionAboutToExecute:'assert.deepEqual(first.errors, [])',laterAssertions:'UNRUN if the first assertion fails',parserRootOverride:false,priorParseOrResolverCalls:false});
 writeFileSync(new URL('bare-h-original-observations.json',import.meta.url),JSON.stringify(observations,null,2)+'\n');
 assert.deepEqual(first.errors,[]);
 const second=s.graph([entry]);
 assert.deepEqual(second.errors,[]);
 assert.deepEqual(second.nodes.map(n=>n.id),first.nodes.map(n=>n.id));
 const instrumented=s.instrument(entry,text);
 assert.ok(instrumented.includes('data-fsus-composition-node'));
});
test('sealed parser supported defineComponent Vue h remains separate',()=>{
 const text="import {defineComponent, Fragment, h, renderSlot} from 'vue'; export default defineComponent({setup(_, {slots}) { return () => {return h('button', {}, 'actual');}; }});";
 const entry=fixture('Supported.ts',text);const s=source();const first=s.graph([entry]);
 observations.push({name:'separate supported defineComponent Vue h',entry,text,errors:first.errors,nodeCount:first.nodes.length});
 writeFileSync(new URL('bare-h-original-observations.json',import.meta.url),JSON.stringify(observations,null,2)+'\n');
 assert.deepEqual(first.errors,[]);
 assert.equal(first.nodes.length,1);
 assert.equal(first.nodes[0].slotInputs.present.default,true);
 const second=s.graph([entry]);
 assert.deepEqual(second.errors,[]);
 assert.deepEqual(second.nodes.map(n=>n.id),first.nodes.map(n=>n.id));
 assert.ok(s.instrument(entry,text).includes('data-fsus-composition-node'));
});
