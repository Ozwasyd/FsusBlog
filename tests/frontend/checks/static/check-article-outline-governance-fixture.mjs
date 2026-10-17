#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import {
    outlineFocusOwnershipViolations,
    outlinePanelContentFocusOwnershipViolations,
    outlinePanelContentOwnerImport
} from './check-article-outline-governance.mjs';

const source = fs.readFileSync(new URL('../../../../src/frontend/src/components/admin/article/ArticleWriteOutlineRail.vue', import.meta.url), 'utf8');

// Each mutation is applied only to an in-memory copy of the actual component.
// The production source and every existing outline check remain unchanged.
const controls = [
    ['disposal guard removed', '!disposed && generation === focusGeneration', 'generation === focusGeneration'],
    ['generation guard removed', '!disposed && generation === focusGeneration', '!disposed'],
    ['closed-state guard removed', '&& !isOpen.value && !isCompact.value', '&& !isCompact.value'],
    ['compact guard removed', '&& !isOpen.value && !isCompact.value', '&& !isOpen.value'],
    ['compact second restoration', 'if (!isCompact.value)\n    {\n        pendingFocusIntent', 'if (true)\n    {\n        pendingFocusIntent'],
    ['intent not consumed', '    pendingFocusIntent = null;\n    await nextTick();', '    await nextTick();'],
    ['unmount fails to invalidate', '    disposed = true;\n    mounted = false;\n    invalidateFocusReturn();', '    disposed = true;\n    mounted = false;'],
    ['breakpoint fails to invalidate', "watch(isCompact, invalidateFocusReturn, { flush: 'sync' });", ''],
    ['article replacement fails to invalidate', "watch(() => props.snapshot, invalidateFocusReturn, { flush: 'sync' });", ''],
    ['open fails to invalidate', 'const openRail = (): void =>\n{\n    invalidateFocusReturn();', 'const openRail = (): void =>\n{'],
    ['compact opener hidden', 'v-if="isCompact || !isOpen"', 'v-if="!isOpen"'],
    ['second closed handler', '@close="requestClose"\n        @update:model-value=', '@close="requestClose" @closed="focusLauncher"\n        @update:model-value='],
    ['second frame task', '    await nextTick();\n    // The modal Drawer', '    await nextTick();\n    requestAnimationFrame(focusLauncher);\n    // The modal Drawer']
];

test('the actual shared-modal and guarded-desktop owners satisfy the focus contract', () =>
{
    assert.deepEqual(outlineFocusOwnershipViolations(source), []);
});

for (const [name, before, after] of controls)
{
    test(`outline focus governance rejects ${name}`, () =>
    {
        assert.equal(source.split(before).length - 1, 1, `control must mutate exactly one real source site: ${name}`);
        assert.notDeepEqual(outlineFocusOwnershipViolations(source.replace(before, after)), [], name);
    });
}

test('comments containing old or new focus tokens cannot replace the executable guard', () =>
{
    const changed = source.replace('!disposed && generation === focusGeneration', 'true');
    assert.notEqual(changed, source);
    assert.notDeepEqual(outlineFocusOwnershipViolations(`${changed}\n<!-- focusReturnPending !disposed && generation === focusGeneration -->`), []);
});


const contentImport = "import OutlinePanelContent from './ArticleWriteOutlinePanelContent.vue';";

test('the product content owner follows the canonical runtime SFC import', () =>
{
    assert.equal(outlinePanelContentOwnerImport(source), './ArticleWriteOutlinePanelContent.vue');
});

for (const [name, replacement] of [
    ['comment-only owner', `// ${contentImport}`],
    ['type-only owner', "import type OutlinePanelContent from './ArticleWriteOutlinePanelContent.vue';"],
    ['different source owner', "import OutlinePanelContent from './OtherOutlineContent.vue';"],
    ['missing owner', '']
])
{
    test(`outline content governance rejects ${name}`, () =>
    {
        assert.equal(source.split(contentImport).length - 1, 1);
        assert.equal(outlinePanelContentOwnerImport(source.replace(contentImport, replacement)), null);
    });
}


const contentSource = fs.readFileSync(new URL('../../../../src/frontend/src/components/admin/article/ArticleWriteOutlinePanelContent.vue', import.meta.url), 'utf8');

test('the actual scoped content preserves tree focus without a modal restoration owner', () =>
{
    assert.deepEqual(outlinePanelContentFocusOwnershipViolations(contentSource), []);
});

const contentControls = [
    ['content frame task', '            await nextTick();', '            await nextTick();\n            requestAnimationFrame(() => undefined);'],
    ['content frame cancellation', '            contentDisposed = true;', '            contentDisposed = true;\n            cancelAnimationFrame(1);'],
    ['content closed handler', "                    onClick: () => emit('close')", "                    onClosed: () => emit('close'),\n                    onClick: () => emit('close')"],
    ['content direct launcher restoration', 'nodeButtons.get(nodeId)?.focus({ preventScroll: true });', 'launcherRef.value?.focus({ preventScroll: true });'],
    ['content launcher restoration call', 'nodeButtons.get(nodeId)?.focus({ preventScroll: true });', 'focusLauncher();'],
    ['content missing TypeScript script', '<script lang="ts">', '<script>']
];

for (const [name, before, after] of contentControls)
{
    test(`outline content governance rejects ${name}`, () =>
    {
        assert.equal(contentSource.split(before).length - 1, 1, `control must mutate exactly one real content site: ${name}`);
        assert.notDeepEqual(outlinePanelContentFocusOwnershipViolations(contentSource.replace(before, after)), [], name);
    });
}
