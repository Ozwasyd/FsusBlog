#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

import { outlineFocusOwnershipViolations } from './check-article-outline-governance.mjs';

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
