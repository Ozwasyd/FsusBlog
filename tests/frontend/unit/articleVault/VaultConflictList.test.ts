// @vitest-environment happy-dom

import { mount } from '@vue/test-utils';
import { afterEach, describe, expect, it } from 'vitest';
import VaultConflictList from '@/components/article-vault/VaultConflictList.vue';
import {
    conflictActionIntent, conflictTypeLabel
} from '@/components/article-vault/conflictEvidencePresentation';
import type { ConflictEvidencePresentation } from '@/components/article-vault/conflictEvidencePresentation';
import schema from '../../../../src/shared/Contracts/ArticleVault/article-vault-conflict-evidence.schema.json';

/** Synthetic presentation fixtures exercise controls, not verified transport or terminal qualification. */
function evidence(index = 0): ConflictEvidencePresentation {
    const coordinate = {
        present: true, deleted: false, serverRevision: 3, lifecycle: 'draft', source: { sha256: 'a'.repeat(64) },
        metadataManifestSha256: 'b'.repeat(64), dependencySha256: 'c'.repeat(64),
        permissionSha256: 'd'.repeat(64), contentSha256: 'e'.repeat(64)
    };
    return {
        schema: schema.properties.schema.const, schemaVersion: schema.properties.schemaVersion.const,
        registrySha256: 'f'.repeat(64), contentSha256: index.toString(16).padStart(64, '0'),
        binding: {
            portableArticleIdentity: `article-${index}`, operationIdentity: `operation-${index}`,
            planSha256: '9'.repeat(64), coordinates: { base: coordinate, local: coordinate, server: coordinate }
        },
        items: [{ type: 'source-overlap', disposition: 'manual',
            allowedActions: ['propose-source-replacement', 'cancel-operation'],
            observation: { source: {
                localChanges: [{ start: 0, end: 3, semanticNodeIdentity: 'node-1' }],
                serverChanges: [{ start: 2, end: 4, semanticNodeIdentity: 'node-1' }]
            } } }]
    };
}

const mounted: ReturnType<typeof mount>[] = [];
function render(entries: readonly ConflictEvidencePresentation[]) {
    const wrapper = mount(VaultConflictList, { props: { evidence: entries, schema }, attachTo: document.body });
    mounted.push(wrapper);
    return wrapper;
}
afterEach(() => { mounted.splice(0).forEach(wrapper => wrapper.unmount()); });

describe('Vault conflict evidence presentation', () => {
    it('keeps every canonical taxonomy type visible without a generic fallback', () => {
        for (const type of schema.$defs.type.enum) expect(conflictTypeLabel(type, schema)).toBeTruthy();
        expect(conflictTypeLabel('conflicted', schema)).toBeNull();
    });

    it('shows three-way references and affected byte ranges without selecting an action', () => {
        const wrapper = render([evidence()]);
        expect(wrapper.findAll('[data-conflict-type]').map(item => item.attributes('data-conflict-type')))
            .toEqual(['source-overlap']);
        expect(wrapper.text()).toContain('共同基线');
        expect(wrapper.text()).toContain('本地');
        expect(wrapper.text()).toContain('服务端');
        expect(wrapper.text()).toContain('[0, 3)');
        expect(wrapper.findAll('[aria-checked="true"], [aria-pressed="true"], input:checked')).toHaveLength(0);
        expect(wrapper.emitted('request-action')).toBeUndefined();
    });

    it('emits only an exact per-item intent and leaves the evidence unchanged', async () => {
        const entry = evidence();
        const before = JSON.stringify(entry);
        const wrapper = render([entry]);
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('request-action')).toEqual([[{
            evidenceSha256: entry.contentSha256, operationIdentity: 'operation-0',
            portableArticleIdentity: 'article-0', type: 'source-overlap', action: 'propose-source-replacement'
        }]]);
        expect(JSON.stringify(entry)).toBe(before);
        expect(wrapper.text()).not.toContain('已同步');
    });

    it('preserves rejected permission/publication authority and offers only supplied closed actions', async () => {
        const entry = evidence();
        const authorityEntry = { ...entry, items: [{ type: 'permission-conflict', disposition: 'rejected',
            allowedActions: ['refresh-evidence', 'cancel-operation'], observation: { authority: { kind: 'permission' } } }] };
        const wrapper = render([authorityEntry]);
        expect(wrapper.text()).toContain('权限由服务端决定');
        expect(wrapper.text()).toContain('已阻止');
        expect(conflictActionIntent(authorityEntry, authorityEntry.items[0], 'accept-all-local', schema)).toBeNull();
        expect(conflictActionIntent(authorityEntry, entry.items[0], 'propose-source-replacement', schema)).toBeNull();
        await wrapper.get('button').trigger('click');
        expect(wrapper.emitted('request-action')?.[0]?.[0]).toMatchObject({ action: 'refresh-evidence' });
    });

    it.each(['unknown-type', 'unknown-action', 'unknown-schema', 'unknown-disposition'])('refuses display compatibility drift: %s', variant => {
        const entry = evidence();
        const item = entry.items[0];
        const changed = { ...entry,
            schema: variant === 'unknown-schema' ? 'future-schema' : entry.schema,
            items: [{ ...item,
                type: variant === 'unknown-type' ? 'conflicted' : item.type,
                disposition: variant === 'unknown-disposition' ? 'winner' : item.disposition,
                allowedActions: variant === 'unknown-action' ? ['accept-all-local'] : item.allowedActions
            }] };
        const wrapper = render([changed]);
        expect(wrapper.text()).toContain('不兼容');
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(conflictActionIntent(changed, changed.items[0], changed.items[0].allowedActions[0], schema)).toBeNull();
    });

    it('never renders unexpected private source/value/token fields', () => {
        const entry = { ...evidence(), rawSource: 'private正文', token: 'secret-token',
            privateMetadata: { title: 'private-title' } };
        const wrapper = render([entry]);
        for (const secret of ['private正文', 'secret-token', 'private-title']) expect(wrapper.html()).not.toContain(secret);
        expect(wrapper.findAll('[contenteditable], textarea, input')).toHaveLength(0);
    });

    it('bounds long article/context lists, preserves order and returns page focus to the heading', async () => {
        const entries = Array.from({ length: 25 }, (_, index) => evidence(index));
        const wrapper = render(entries);
        expect(wrapper.findAll('h3').map(node => node.text())).toEqual(entries.slice(0, 10).map(entry => `文章 ${entry.binding.portableArticleIdentity}`));
        const next = wrapper.findAll('button').find(button => button.attributes('aria-label') === 'Go to next page');
        expect(next).toBeDefined();
        await next!.trigger('click');
        expect(wrapper.findAll('h3').map(node => node.text())).toEqual(entries.slice(10, 20).map(entry => `文章 ${entry.binding.portableArticleIdentity}`));
        expect(document.activeElement).toBe(wrapper.get('h2').element);
        await wrapper.setProps({ evidence: [evidence(40)] });
        expect(wrapper.findAll('h3').map(node => node.text())).toEqual(['文章 article-40']);
        expect(wrapper.get('[role="status"]').text()).toContain('第 1 / 1 页');
    });

    it('caps diagnostic range display and keeps exact item identity', () => {
        const entry = evidence();
        const long = { ...entry, items: [{ ...entry.items[0], observation: { source: {
            localChanges: Array.from({ length: 50 }, (_, index) => ({ start: index, end: index + 1, semanticNodeIdentity: `node-${index}` })),
            serverChanges: []
        } } }] };
        const wrapper = render([long]);
        expect(wrapper.findAll('[data-conflict-type] ul li')).toHaveLength(20);
        expect(wrapper.text()).toContain('显示前 20 个范围');
        expect(wrapper.get('[data-conflict-type]').attributes('data-conflict-type')).toBe('source-overlap');
    });

    it('provides a named semantic region, action groups and a quiet empty state', () => {
        const wrapper = render([]);
        expect(wrapper.attributes('aria-labelledby')).toBe(wrapper.get('h2').attributes('id'));
        expect(wrapper.get('h2').attributes('tabindex')).toBe('-1');
        expect(wrapper.text()).toContain('没有可显示的冲突');
        expect(wrapper.findAll('button')).toHaveLength(0);
        expect(wrapper.findAll('[role="alert"]')).toHaveLength(0);
    });
});
