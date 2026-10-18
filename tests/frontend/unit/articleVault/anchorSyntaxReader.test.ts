import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { readVaultAnchorSyntax, verifyVaultAnchorSyntax } from '@/services/articleVault/anchorSyntaxReader';

const bindingFor = (source: string) => ({
    siteIdentity: 'site:primary',
    vaultIdentity: 'vault:primary',
    portableArticleIdentity: 'article:01991e72-9a2c-7b60-8f47-b339f58e4a11',
    sourceRevision: 8,
    sourceSha256: createHash('sha256').update(source).digest('hex')
});

describe('Vault public anchor grammar consumption', () => {
    it.each(['Paragraph ^stable-id', '\uFEFF标题 😀 ^stable-id\r\n', '| cell |\n^stable-id\n'])('retains canonical identity and exact raw UTF-16 ranges: %s', async source => {
        const binding = bindingFor(source);
        const snapshot = await readVaultAnchorSyntax(source, binding, binding);
        expect(snapshot.valid).toBe(true);
        expect(snapshot.anchors).toHaveLength(1);
        const anchor = snapshot.anchors[0]!;
        expect(anchor.anchorIdentity).toBe('stable-id');
        expect(source.slice(anchor.start, anchor.end)).toBe('^stable-id');
        expect(await verifyVaultAnchorSyntax(source, binding, snapshot)).toBe(true);
    });

    it.each([
        ['Paragraph ^same\nOther ^same', 'anchor-duplicate'],
        ['Paragraph ^Upper', 'anchor-invalid-id'],
        ['^orphan', 'anchor-orphan'],
        ['Paragraph\n\n^gap', 'anchor-cross-gap']
    ])('blocks every target when grammar reports %s', async (source, code) => {
        const binding = bindingFor(source);
        const snapshot = await readVaultAnchorSyntax(source, binding, binding);
        expect(snapshot.valid).toBe(false);
        expect(snapshot.anchors).toEqual([]);
        expect(snapshot.diagnostics.some(diagnostic => diagnostic.code === code)).toBe(true);
        expect(snapshot.diagnostics.every(diagnostic => !('message' in diagnostic))).toBe(true);
    });

    it('does not mint targets for absent markers, sidecars, HTML ids or literal code', async () => {
        const source = 'Paragraph\n<div id="hidden">text</div>\n```md\nLiteral ^inside\n```\n';
        const binding = bindingFor(source);
        const snapshot = await readVaultAnchorSyntax(source, binding, binding);
        expect(snapshot.valid).toBe(true);
        expect(snapshot.anchors).toEqual([]);
    });

    it.each(['siteIdentity', 'vaultIdentity', 'portableArticleIdentity', 'sourceRevision'] as const)('rejects stale/cross-context %s even for identical source bytes', async field => {
        const source = 'Paragraph ^stable-id';
        const expected = bindingFor(source);
        const changed = { ...expected, [field]: field === 'sourceRevision' ? 9 : 'other' };
        await expect(readVaultAnchorSyntax(source, changed, expected)).rejects.toThrow('vault_anchor_source_binding_mismatch');
    });

    it('rejects modified source bytes and candidate marker/range tamper', async () => {
        const source = 'Paragraph ^stable-id';
        const binding = bindingFor(source);
        await expect(readVaultAnchorSyntax(`${source}\n`, binding, binding)).rejects.toThrow('vault_anchor_source_digest_mismatch');
        const snapshot = await readVaultAnchorSyntax(source, binding, binding);
        expect(await verifyVaultAnchorSyntax(source, binding, {
            ...snapshot,
            anchors: [{ ...snapshot.anchors[0]!, anchorIdentity: 'other-id' }]
        })).toBe(false);
        expect(await verifyVaultAnchorSyntax(source, binding, {
            ...snapshot,
            anchors: [{ ...snapshot.anchors[0]!, start: 0 }]
        })).toBe(false);
        expect(await verifyVaultAnchorSyntax(source, binding, {
            ...snapshot,
            anchors: Array(snapshot.anchors.length)
        })).toBe(false);
    });

    it('rebuilds deletion from source rather than retaining the previous target', async () => {
        const before = 'Paragraph ^stable-id';
        const after = 'Paragraph';
        const old = await readVaultAnchorSyntax(before, bindingFor(before), bindingFor(before));
        const current = await readVaultAnchorSyntax(after, bindingFor(after), bindingFor(after));
        expect(old.anchors).toHaveLength(1);
        expect(current.anchors).toEqual([]);
        expect(await verifyVaultAnchorSyntax(after, bindingFor(after), old)).toBe(false);
    });
});
