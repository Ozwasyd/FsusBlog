import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompositionSource } from '../FsusBlog/tests/frontend/support/layout/compositionSource.mjs';

const repositoryRoot = '/workspace/chain-1895-origin-export-successor/FsusBlog';
const fsusUIRoot = '/workspace/chain-1895-component-prop-source/FsusUI';
const directory = mkdtempSync(join(tmpdir(), 'central-order2-original-'));
const observations = [];
try
{
    for (const mode of ['unknown-omission', 'reverse-order'])
    {
        const parent = join(directory, mode);
        const { mkdirSync } = await import('node:fs');
        mkdirSync(parent);
        const owner = join(parent, 'Owner.vue');
        const entry = join(parent, 'Entry.vue');
        const ownerBytes = '<script setup>const props=defineProps({tag:{type:[String,Object],default:"button"}});</script><template><component :is="tag"/></template>';
        const entryBytes = mode === 'unknown-omission'
            ? '<script setup>import Owner from "./Owner.vue";</script><template><Owner tag="a"/><Owner :tag="unknown"/></template>'
            : '<script setup>import Owner from "./Owner.vue";</script><template><Owner tag="a"/><Owner tag="span"/></template>';
        writeFileSync(owner, ownerBytes); writeFileSync(entry, entryBytes);
        const source = createCompositionSource({ repositoryRoot, fsusUIRoot });
        const first = source.graph([entry]);
        const target = first.nodes.find((n) => n.file === owner && n.origin.kind === 'native-prop');
        const second = first.nodes.filter((n) => n.file === entry && n.definition === owner)[1];
        function supplier(graph)
        {
            try { return { accepted: true, inputs: source.resolveTargetInputs(target, graph) }; }
            catch (error) { return { accepted: false, message: error.message }; }
        }
        const before = { errors: structuredClone(first.errors), suppliers: supplier(first), arraySuppliers: supplier(first.nodes), recordNodes: source.parse(entry).nodes.slice(), instrumentation: source.instrument(entry, entryBytes) };
        const map = source.nodes;
        const original = [...Map.prototype.entries.call(map)];
        map.values = mode === 'unknown-omission'
            ? function* () { yield* [...Map.prototype.values.call(this)].filter((n) => n !== second); }
            : function* () { yield* [...Map.prototype.values.call(this)].reverse(); };
        let after;
        try
        {
            const repeated = source.graph([entry]);
            after = { errors: repeated.errors, suppliers: supplier(repeated), arraySuppliers: supplier(repeated.nodes), recordNodes: source.parse(entry).nodes.slice(), instrumentation: source.instrument(entry, entryBytes), sourceBindingErrors: source.resolver.sourceBindings().errors };
        }
        catch (error) { after = { rejected: true, message: error.message }; }
        observations.push({ mode, exactOwnerBytes: ownerBytes, exactEntryBytes: entryBytes, finalNewlines: false, parserRootOverride: false, priorParseOrResolverCalls: false, sameNativeKeys: [...Map.prototype.keys.call(map)].every((id, i) => id === original[i][0]), sameNativeSize: Object.getOwnPropertyDescriptor(Map.prototype, 'size').get.call(map) === original.length, samePointers: original.every(([id, node]) => Map.prototype.get.call(map, id) === node), before, after, assertionsExecuted: false });
    }
    writeFileSync(new URL(process.argv[2] ?? 'order2-before-observation.json', import.meta.url), JSON.stringify(observations, null, 2) + '\n');
    console.log(JSON.stringify(observations.map(({ mode, before, after, sameNativeKeys, sameNativeSize, samePointers }) => ({ mode, sameNativeKeys, sameNativeSize, samePointers, beforeErrors: before.errors.map((e) => e.reason), beforeSupplierAccepted: before.suppliers.accepted, beforeTargets: before.suppliers.inputs?.map((s) => s.target.name), afterErrors: after.errors?.map((e) => e.reason), afterTargets: after.suppliers?.inputs?.map((s) => s.target.name), afterArrayTargets: after.arraySuppliers?.inputs?.map((s) => s.target.name), rejected: after.rejected ?? false, message: after.message }))));
}
finally { rmSync(directory, { recursive: true, force: true }); }
