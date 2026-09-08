import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveDependencyPullTarget } from '../../tools/governance/dependency-pull-target.mjs';

const item = { id: 'action', manager: 'github-actions', packageName: 'owner/action', files: ['.github/workflows/test.yml', '.github/workflows/build.yml'] };
const mapping = { number: 1, state: 'open', dependencyId: 'action', packageName: 'owner/action', headSha: 'a'.repeat(40), targetVersion: 'v9' };

test('PR target comes from every registered file at exact head, not the title claim', async () => {
    const calls = [];
    const pin = 'b'.repeat(40);
    const result = await resolveDependencyPullTarget({ mapping, item, config: {}, readFileAtHead: async (file, sha) => {
        calls.push([file, sha]);
        return `steps:\n  - uses: owner/action@${pin} # v9`;
    } });
    assert.equal(result.targetVersion, pin);
    assert.equal(result.declaredTargetVersion, 'v9');
    assert.deepEqual(calls, item.files.map(file => [file, mapping.headSha]));
});

test('partial PR updates and unavailable source do not become verified targets', async () => {
    await assert.rejects(resolveDependencyPullTarget({ mapping, item, config: {}, readFileAtHead: async file =>
        `- uses: owner/action@${(file.includes('test') ? 'b' : 'c').repeat(40)}` }), /references-disagree/);
    await assert.rejects(resolveDependencyPullTarget({ mapping, item, config: {}, readFileAtHead: async () => {
        throw new Error('source unavailable');
    } }), /source unavailable/);
});

test('mutable refs and unsafe source paths are rejected before any reads', async () => {
    const readFileAtHead = async () => { throw new Error('must not read'); };
    await assert.rejects(resolveDependencyPullTarget({ mapping: { ...mapping, headSha: 'main' }, item, config: {}, readFileAtHead }), /identity_invalid/);
    for (const file of ['/absolute', '../escape', 'dir/../escape', 'dir\\escape'])
    {
        await assert.rejects(resolveDependencyPullTarget({ mapping, item: { ...item, files: [file] }, config: {}, readFileAtHead }), /path_invalid/);
    }
});
