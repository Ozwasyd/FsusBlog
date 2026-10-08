import { describe, expect, it } from 'vitest';
import {
    computeParagraphSourceMerge,
    paragraphSourceCandidateDigest,
    verifyParagraphSourceCandidate,
    type ParagraphSourceBytes,
    type ParagraphSourceCandidate
} from '@/services/articleVault/paragraphSourceMerge';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
const input = (base: string, local: string = base, server: string = base): ParagraphSourceBytes => ({
    base: encode(base), local: encode(local), server: encode(server)
});

function candidate(bytes: ParagraphSourceBytes): ParagraphSourceCandidate
{
    const result = computeParagraphSourceMerge(bytes);
    expect(result.kind).toBe('computed');
    if (result.kind !== 'computed') throw new Error('expected_computed_candidate');
    return result.candidate;
}

describe('Article Vault paragraph source computation with actual canonical parser', () => {
    it('applies real disjoint paragraph hunks and independently rereads all three projections', () => {
        const bytes = input('First paragraph.\n\nSecond paragraph.\n',
            'Edited first paragraph.\n\nSecond paragraph.\n',
            'First paragraph.\n\nEdited second paragraph.\n');
        const result = candidate(bytes);
        expect(decode(result.bytes)).toBe('Edited first paragraph.\n\nEdited second paragraph.\n');
        expect(result.hunks.map(h => h.side)).toEqual(['local', 'server']);
        expect(result.hunks[0].baseNodeIdentity).not.toBe(result.hunks[1].baseNodeIdentity);
        expect(verifyParagraphSourceCandidate(bytes, result)).toBe(true);
        expect(Object.keys(result)).not.toContain('verified');
        expect(Object.keys(result)).not.toContain('plan');
    });

    it('keeps byte-disjoint edits in the same real base semantic node manual', () => {
        const bytes = input('Alpha middle omega.\n\nOther paragraph.\n',
            'Local middle omega.\n\nOther paragraph.\n',
            'Alpha middle remote.\n\nOther paragraph.\n');
        const result = computeParagraphSourceMerge(bytes);
        expect(result.kind).toBe('manual');
        if (result.kind === 'manual') {
            expect(result.reasonCode).toBe('article_vault_source_same_base_node');
            expect(result.baseNodeIdentities).toHaveLength(1);
        }
    });

    it.each(['\n', '\r\n'])('preserves BOM, emoji, trailing spaces, %j and final newline exactly', newline => {
        const base = `\uFEFFFirst 😀 paragraph.  ${newline}${newline}Second paragraph.${newline}`;
        const local = `\uFEFFLocal 😀 paragraph.  ${newline}${newline}Second paragraph.${newline}`;
        const server = `\uFEFFFirst 😀 paragraph.  ${newline}${newline}Remote paragraph.${newline}`;
        const bytes = input(base, local, server);
        const result = candidate(bytes);
        expect(Array.from(result.bytes)).toEqual(Array.from(encode(
            `\uFEFFLocal 😀 paragraph.  ${newline}${newline}Remote paragraph.${newline}`)));
        expect(verifyParagraphSourceCandidate(bytes, result)).toBe(true);
    });

    it('preserves missing final newline and proves unchanged inputs as no-op', () => {
        const bytes = input('First.\n\nSecond.');
        const result = candidate(bytes);
        expect(result.hunks).toEqual([]);
        expect(Array.from(result.bytes)).toEqual(Array.from(bytes.base));
        expect(verifyParagraphSourceCandidate(bytes, result)).toBe(true);
    });

    it.each([
        '# Heading\n\nParagraph.\n',
        '- Item\n- Other\n',
        '| A | B |\n|---|---|\n| 1 | 2 |\n',
        '```text\nContent\n```\n',
        '```unclosed\nContent\n',
        '---\ntitle: secret\n---\n\nParagraph.\n',
        '<div>secret</div>\n',
        '[Link](https://example.test)\n'
    ])('rejects unsupported actual semantic boundaries without logging source: %j', source => {
        const result = computeParagraphSourceMerge(input(source));
        expect(result.kind).toBe('rejected');
        expect(JSON.stringify(result)).not.toContain(source);
        expect(JSON.stringify(result)).not.toContain('secret');
    });

    it('rejects missing base, invalid UTF8, deleted paragraph and paragraph move ambiguity', () => {
        const bytes = input('First.\n\nSecond.\n');
        expect(computeParagraphSourceMerge({ ...bytes, base: undefined } as unknown as ParagraphSourceBytes).kind).toBe('rejected');
        expect(computeParagraphSourceMerge({ ...bytes, local: new Uint8Array([0xff]) }).kind).toBe('rejected');
        expect(computeParagraphSourceMerge(input('First.\n\nSecond.\n', 'First.\n', 'First.\n\nEdited second.\n')).kind).toBe('rejected');
        expect(computeParagraphSourceMerge(input('First.\n\nSecond.\n', 'Second.\n\nFirst.\n')).kind).toBe('rejected');
    });

    it('rejects format-before-diff, new paragraph boundaries and BOM changes', () => {
        for (const bytes of [
            input('First.\r\n\r\nSecond.\r\n', 'First.\n\nSecond.\n'),
            input('First.\n\nSecond.\n', 'First.\n\n\nSecond.\n'),
            input('\uFEFFFirst.\n\nSecond.\n', 'First.\n\nSecond.\n')
        ]) expect(computeParagraphSourceMerge(bytes).kind).toBe('rejected');
    });

    it('rejects stale actual bytes, parser/policy drift and resealed byte/hunk/provenance tamper', () => {
        const bytes = input('First.\n\nSecond.\n', 'Local first.\n\nSecond.\n', 'First.\n\nRemote second.\n');
        const original = candidate(bytes);
        expect(verifyParagraphSourceCandidate({ ...bytes, server: encode('Other.\n\nSecond.\n') }, original)).toBe(false);
        const mutations: ParagraphSourceCandidate[] = [
            { ...original, parserVersion: 'stale' },
            { ...original, policySha256: 'unknown' },
            { ...original, baseSha256: original.localSha256 },
            { ...original, bytes: encode('generic winner\n') },
            { ...original, hunks: [] },
            { ...original, hunks: original.hunks.map((h, index) => index ? h : { ...h, extra: 'unknown-field' }) },
            { ...original, hunks: original.hunks.map((h, index) => index ? h : { ...h, from: h.from + 1 }) },
            { ...original, hunks: original.hunks.map((h, index) => index ? h : { ...h, baseNodeIdentity: 'invented-node' }) },
            { ...original, hunks: original.hunks.map((h, index) => index ? h : { ...h, insert: encode('untrusted') }) }
        ];
        for (const altered of mutations) {
            expect(verifyParagraphSourceCandidate(bytes,
                { ...altered, contentSha256: paragraphSourceCandidateDigest(altered) })).toBe(false);
        }
    });
});
