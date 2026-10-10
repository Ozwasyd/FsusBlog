import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompositionSource } from '../FsusBlog/tests/frontend/support/layout/compositionSource.mjs';

const directory = mkdtempSync(join(tmpdir(), 'central-order1-original-'));
const owner = join(directory, 'Owner.vue');
const entry = join(directory, 'Entry.vue');
const ownerBytes = '<script setup>const props=defineProps({tag:{type:[String,Object],default:"button"}});</script><template><component :is="tag"/></template>';
const entryBytes = '<script setup>import Owner from "./Owner.vue";</script><template><Owner tag="a"/><Owner tag="span"/></template>';
try
{
    writeFileSync(owner, ownerBytes);
    writeFileSync(entry, entryBytes);
    const source = createCompositionSource({ repositoryRoot: '/workspace/chain-1895-origin-export-successor/FsusBlog', fsusUIRoot: '/workspace/chain-1895-component-prop-source/FsusUI' });
    const first = source.graph([entry]);
    const target = first.nodes.find((n) => n.file === owner && n.origin.kind === 'native-prop');
    const before = { errors: first.errors, suppliers: source.resolveTargetInputs(target, first), recordNodes: source.parse(entry).nodes.slice(), instrumentation: source.instrument(entry, entryBytes) };
    const firstCall = first.nodes.find((n) => n.file === entry && n.definition === owner);
    const map = source.nodes;
    const original = [...map];
    map.delete(firstCall.id);
    map.set(firstCall.id, firstCall);
    const sameSize = map.size === original.length;
    const samePointers = original.every(([id, node]) => map.get(id) === node);
    const sameOrder = [...map.keys()].every((id, index) => id === original[index][0]);
    let after;
    try
    {
        const repeated = source.graph([entry]);
        after = { errors: repeated.errors, suppliers: source.resolveTargetInputs(target, repeated), recordNodes: source.parse(entry).nodes.slice(), instrumentation: source.instrument(entry, entryBytes), sourceBindingErrors: source.resolver.sourceBindings().errors };
    }
    catch (error)
    {
        after = { rejected: true, message: error.message };
    }
    const observation = { exactOwnerBytes: ownerBytes, exactEntryBytes: entryBytes, finalNewlines: false, parserRootOverride: false, priorParseOrResolverCalls: false, firstCall: firstCall.id, sameSize, samePointers, sameOrder, before, after, assertionsExecuted: false, qualificationEligible: false };
    writeFileSync(new URL(process.argv[2] ?? 'order1-before-observation.json', import.meta.url), JSON.stringify(observation, null, 2) + '\n');
    console.log(JSON.stringify({ firstCall: firstCall.id, sameSize, samePointers, sameOrder, beforeTargets: before.suppliers.map((s) => s.target.name), afterTargets: after.suppliers?.map((s) => s.target.name), rejected: after.rejected ?? false, message: after.message }));
}
finally
{
    rmSync(directory, { recursive: true, force: true });
}
