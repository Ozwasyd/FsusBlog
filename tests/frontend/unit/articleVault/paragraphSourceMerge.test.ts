import { describe, expect, it, vi } from 'vitest';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createMarkdownEditorProjection, createMarkdownSourceCoordinateMap } from '@ozwasyd/element-plus/markdown-runtime';
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
            expect(result.provenance.baseSha256).toBe(bytesToHex(sha256(bytes.base)));
            expect(result.provenance.localSha256).toBe(bytesToHex(sha256(bytes.local)));
            expect(result.provenance.serverSha256).toBe(bytesToHex(sha256(bytes.server)));
            expect(result.conflicts).toEqual([{
                baseNodeIdentity: result.baseNodeIdentities[0], baseByteRange: { from: 0, to: 20 },
                local: { from: 0, to: 5, sourceSha256: bytesToHex(sha256(bytes.local)),
                    insertSha256: bytesToHex(sha256(encode('Local'))), insertByteLength: 5 },
                server: { from: 13, to: 18, sourceSha256: bytesToHex(sha256(bytes.server)),
                    insertSha256: bytesToHex(sha256(encode('remote'))), insertByteLength: 6 }
            }]);
            expect(JSON.stringify(result)).not.toContain('Alpha middle');
            expect(JSON.stringify(result)).not.toContain('Local middle');
            expect(result.conflicts[0].local.to).toBeLessThan(result.conflicts[0].server.from);
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

    it.each([
        '# Secret heading 😀\r\n',
        '```unclosed\r\nsecret 😀\r\n',
        '---\r\ntitle: secret\r\n---\r\n',
        '<div>secret 😀</div>\r\n'
    ])('reports actual parser-owned syntax refs and byte ranges without source text: %j', source => {
        const projection = createMarkdownEditorProjection(source);
        const coordinates = createMarkdownSourceCoordinateMap(source);
        const bytes = input('First.\n\nSecond.\n', source);
        const result = computeParagraphSourceMerge(bytes);
        expect(result.kind).toBe('rejected');
        if (result.kind !== 'rejected') throw new Error('expected_rejection');
        expect(result.diagnostics.length).toBeGreaterThan(0);
        for (const diagnostic of result.diagnostics) {
            const node = projection.nodes.find(entry => entry.blockIdentity === diagnostic.nodeIdentity);
            expect(node).toBeDefined();
            if (!node) throw new Error('missing_actual_parser_node');
            expect(diagnostic.source).toBe('local');
            expect(diagnostic.sourceSha256).toBe(bytesToHex(sha256(bytes.local)));
            expect(diagnostic.parser).toBe(projection.identity.parser);
            expect(diagnostic.parserVersion).toBe(projection.identity.version);
            expect(diagnostic.kind).toBe(node.kind);
            expect(diagnostic.status).toBe(node.status);
            expect(diagnostic.diagnosticCode).toBe(node.diagnosticCode);
            expect(diagnostic.rawUtf16Range).toEqual({ from: node.rawRange.start, to: node.rawRange.end });
            expect(diagnostic.rawByteRange).toEqual({
                from: coordinates.toRawUtf8Offset(node.rawRange.start), to: coordinates.toRawUtf8Offset(node.rawRange.end)
            });
            expect(diagnostic.diagnostics).toEqual(projection.diagnostics
                .filter(entry => entry.blockIdentity === node.blockIdentity).map(entry => ({
                    code: entry.code, rawUtf16Range: { from: entry.rawRange.start, to: entry.rawRange.end },
                    rawByteRange: { from: coordinates.toRawUtf8Offset(entry.rawRange.start), to: coordinates.toRawUtf8Offset(entry.rawRange.end) }
                })));
        }
        if (source.startsWith('<div>')) {
            expect(result.reasonCode).toBe('article_vault_source_html_boundary_unsupported');
            expect(result.diagnostics[0].kind).toBe('paragraph');
        }
        if (source.startsWith('```')) {
            expect(result.diagnostics.some(entry => entry.status === 'malformed' && entry.diagnostics.length > 0)).toBe(true);
        }
        expect(JSON.stringify(result)).not.toContain('secret');
        expect(JSON.stringify(result)).not.toContain('Secret heading');
    });

    it('preserves real UTF8 base-node refs in a same-node conflict with BOM and CRLF', () => {
        const source = '\uFEFFAlpha 😀 omega.  \r\n\r\nOther.\r\n';
        const bytes = input(source, source.replace('Alpha', 'Local'), source.replace('omega', 'remote'));
        const original = bytes.base.slice();
        const result = computeParagraphSourceMerge(bytes);
        expect(result.kind).toBe('manual');
        if (result.kind !== 'manual') throw new Error('expected_manual');
        const node = createMarkdownEditorProjection(source).nodes[0];
        const coordinates = createMarkdownSourceCoordinateMap(source);
        expect(result.conflicts[0].baseByteRange).toEqual({
            from: coordinates.toRawUtf8Offset(node.rawRange.start), to: coordinates.toRawUtf8Offset(node.rawRange.end)
        });
        expect(result.conflicts[0].local.from).toBe(3);
        expect(result.conflicts[0].local.to).toBe(8);
        expect(result.conflicts[0].server.from).toBeGreaterThan(result.conflicts[0].local.to);
        expect(Array.from(bytes.base)).toEqual(Array.from(original));
        expect(JSON.stringify(result)).not.toContain('Alpha');
    });

    it('rejects unknown, hidden, symbol and inherited candidate fields even when the old digest matches', () => {
        const bytes = input('First.\n\nSecond.\n', 'Local first.\n\nSecond.\n');
        const original = candidate(bytes);
        const unknown = { ...original, verified: true };
        const hidden = { ...original };
        Object.defineProperty(hidden, 'unrecognized', { value: true });
        const symbol = { ...original, [Symbol('unknown')]: true };
        const inherited: unknown = Object.assign(Object.create({ verified: true }), original);
        for (const supplied of [unknown, hidden, symbol, inherited]) {
            expect(verifyParagraphSourceCandidate(bytes, supplied)).toBe(false);
        }
        expect(verifyParagraphSourceCandidate(bytes, Object.freeze({ ...original }))).toBe(true);
    });

    it('rejects every accessor-bearing candidate field without invoking any getter', () => {
        const bytes = input('First.\n\nSecond.\n', 'Local first.\n\nSecond.\n');
        const original = candidate(bytes);
        for (const field of Object.keys(original)) {
            const supplied = { ...original };
            const getter = vi.fn(() => { throw new Error('getter_must_not_execute'); });
            Object.defineProperty(supplied, field, { get: getter, enumerable: true });
            expect(verifyParagraphSourceCandidate(bytes, supplied)).toBe(false);
            expect(getter).not.toHaveBeenCalled();
        }
    });

    it('rejects hunk, hunk-array and byte-buffer accessors without executing them', () => {
        const bytes = input('First.\n\nSecond.\n', 'Local first.\n\nSecond.\n');
        const original = candidate(bytes);
        for (const field of Object.keys(original.hunks[0])) {
            const h = { ...original.hunks[0] };
            const getter = vi.fn(() => { throw new Error('hunk_getter_must_not_execute'); });
            Object.defineProperty(h, field, { get: getter, enumerable: true });
            expect(verifyParagraphSourceCandidate(bytes, { ...original, hunks: [h] })).toBe(false);
            expect(getter).not.toHaveBeenCalled();
        }
        const hunks = [...original.hunks];
        const getter = vi.fn(() => { throw new Error('array_getter_must_not_execute'); });
        Object.defineProperty(hunks, 0, { get: getter, enumerable: true });
        expect(verifyParagraphSourceCandidate(bytes, { ...original, hunks })).toBe(false);
        expect(getter).not.toHaveBeenCalled();
        const suppliedBytes = original.bytes.slice();
        const byteGetter = vi.fn(() => { throw new Error('byte_getter_must_not_execute'); });
        Object.defineProperty(suppliedBytes, 'length', { get: byteGetter });
        expect(verifyParagraphSourceCandidate(bytes, { ...original, bytes: suppliedBytes })).toBe(false);
        expect(byteGetter).not.toHaveBeenCalled();
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
