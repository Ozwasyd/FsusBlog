import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { readVaultEmbedSyntax, verifyVaultEmbedSyntax } from '@/services/articleVault/embedSyntaxReader';

const digest = (source: string) => createHash('sha256').update(source).digest('hex');
const target = 'article:01991e72-a611-7d16-9fd4-38f7d2e65498';

describe('Vault public embed grammar consumption', () => {
    it.each(['article', 'heading', 'block'])('consumes the upstream required mode %s without guessing Blog target semantics', async mode => {
        const source = `标题 😀\r\n::embed[target="${target}" mode="${mode}"]\r\n`;
        const snapshot = await readVaultEmbedSyntax(source, digest(source));
        expect(snapshot.valid).toBe(true);
        expect(snapshot.directives).toHaveLength(1);
        const directive = snapshot.directives[0]!;
        expect(directive.mode).toBe(mode);
        expect(directive.targetToken).toBe(target);
        expect(source.slice(directive.start, directive.end)).toBe(`::embed[target="${target}" mode="${mode}"]`);
        expect(await verifyVaultEmbedSyntax(source, digest(source), snapshot)).toBe(true);
    });

    it.each([
        `::embed[target="${target}"]`,
        `::embed[mode="article" target="${target}"]`,
        `::embed[target="${target}" mode="latest"]`,
        `::embed[target="${target}" mode="article"] trailing`,
        `::embed[target="" mode="article"]`
    ])('fails closed on upstream malformed syntax: %s', async source => {
        const snapshot = await readVaultEmbedSyntax(source, digest(source));
        expect(snapshot.valid).toBe(false);
        expect(snapshot.directives).toEqual([]);
        expect(snapshot.diagnostics.length).toBeGreaterThan(0);
        expect(snapshot.diagnostics.every(diagnostic => !('message' in diagnostic))).toBe(true);
    });

    it('never adds a decoder for legacy includes or wikilinks', async () => {
        const source = `::include[${target}]\n![[${target}]]\n<div data-embed="${target}"></div>`;
        const snapshot = await readVaultEmbedSyntax(source, digest(source));
        expect(snapshot.directives).toEqual([]);
    });

    it('blocks valid siblings when any embed syntax is malformed', async () => {
        const source = `::embed[target="${target}" mode="article"]\n::embed[target="${target}"]`;
        const snapshot = await readVaultEmbedSyntax(source, digest(source));
        expect(snapshot.valid).toBe(false);
        expect(snapshot.directives).toEqual([]);
    });

    it('rejects source, token, parser-contract and range tamper', async () => {
        const source = `::embed[target="${target}" mode="article"]`;
        const snapshot = await readVaultEmbedSyntax(source, digest(source));
        await expect(readVaultEmbedSyntax(`${source}\n`, digest(source))).rejects.toThrow('vault_embed_source_digest_mismatch');
        for (const changed of [
            { ...snapshot.directives[0]!, targetToken: 'latest' },
            { ...snapshot.directives[0]!, start: 1 },
            { ...snapshot.directives[0]!, mode: 'block' as const }
        ]) {
            expect(await verifyVaultEmbedSyntax(source, digest(source), { ...snapshot, directives: [changed] })).toBe(false);
        }
        expect(await verifyVaultEmbedSyntax(source, digest(source), {
            ...snapshot,
            directives: Array(snapshot.directives.length)
        })).toBe(false);
    });
});
