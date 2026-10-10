import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCompositionSource } from '../FsusBlog/tests/frontend/support/layout/compositionSource.mjs';
const root = mkdtempSync(join(tmpdir(), 'central-functional-construction-'));
try
{
    const file = join(root, 'Entry.ts');
    const bytes = "import {h} from 'vue';export default()=>h('button',{},'actual');";
    writeFileSync(file, bytes);
    const source = createCompositionSource({ repositoryRoot: '/workspace/chain-1895-origin-export-successor/FsusBlog', fsusUIRoot: '/workspace/chain-1895-component-prop-source/FsusUI' });
    const graph = source.graph([file]);
    if (graph.errors.length) throw new Error(JSON.stringify(graph.errors));
    const construction = source.parse(file).renderSource.functional.renderCalls[0];
    const result = { file, exactBytes: bytes, finalNewline: false, parserRootOverride: false, graphErrors: graph.errors, construction, resolvedDependencies: construction.dependencies.length, unresolvedDependencies: construction.unresolvedDependencies.length, sourceBindingErrors: source.resolver.sourceBindings().errors, qualificationEligible: false, runtimeEffects: 'unbound', observationNotAssertionCount: true };
    writeFileSync(new URL('functional-construction-facts.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ resolvedDependencies: result.resolvedDependencies, unresolvedDependencies: result.unresolvedDependencies, qualificationEligible: false, runtimeEffects: 'unbound' }));
}
finally { rmSync(root, { recursive: true, force: true }); }
