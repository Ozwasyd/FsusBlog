import { describe, expect, it } from 'vitest';
import {
    computeParagraphSourceMerge,
    paragraphSourceCandidateDigest,
    verifyParagraphSourceCandidate,
    type ParagraphSourceBytes,
    type ParagraphSourceCandidate
} from '@/services/articleVault/paragraphSourceMerge';

const encode = (text: string) => new TextEncoder().encode(text);
const snapshots = (base: string, local: string, server: string): ParagraphSourceBytes => ({
    base: encode(base), local: encode(local), server: encode(server)
});

function computed(input: ParagraphSourceBytes): ParagraphSourceCandidate
{
    const result = computeParagraphSourceMerge(input);
    expect(result.kind).toBe('computed');
    if (result.kind !== 'computed') throw new Error('terminal_source_candidate_missing');
    return result.candidate;
}

function reseal(candidate: ParagraphSourceCandidate): ParagraphSourceCandidate
{
    return { ...candidate, contentSha256: paragraphSourceCandidateDigest(candidate) };
}

describe('Article Vault terminal prerequisite: actual paragraph reader, without execution admission', () => {
    it.each([
        ['LF with BOM and final newline', '\uFEFF', '\n', '\n'],
        ['CRLF with BOM and final newline', '\uFEFF', '\r\n', '\r\n'],
        ['LF without BOM or final newline', '', '\n', ''],
        ['CRLF without BOM or final newline', '', '\r\n', '']
    ])('keeps untouched bytes and snapshot ownership: %s', (_label, bom, newline, final) => {
        const first = '前缀😀 original e\u0301.  ';
        const middle = 'Unchanged middle paragraph.  ';
        const last = 'শেষ original paragraph.';
        const compose = (left: string, right: string) => `${bom}${left}${newline}${newline}${middle}${newline}${newline}${right}${final}`;
        const input = snapshots(compose(first, last), compose(first.replace('original', 'local'), last),
            compose(first, last.replace('original', 'server')));
        const before = [input.base.slice(), input.local.slice(), input.server.slice()];
        const candidate = computed(input);
        expect(candidate.bytes).toEqual(encode(compose(first.replace('original', 'local'), last.replace('original', 'server'))));
        expect(verifyParagraphSourceCandidate(input, candidate)).toBe(true);
        expect(candidate.hunks).toHaveLength(2);
        expect(new Set(candidate.hunks.map(hunk => hunk.baseNodeIdentity)).size).toBe(2);
        expect([input.base, input.local, input.server]).toEqual(before);
        candidate.bytes.fill(0);
        expect([input.base, input.local, input.server]).toEqual(before);
        expect(verifyParagraphSourceCandidate(input, candidate)).toBe(false);
    });

    it.each([
        ['separate character ranges', 'Local middle omega.', 'Alpha middle server.'],
        ['identical changed bytes', 'Shared middle omega.', 'Shared middle omega.'],
        ['longer local version', 'Alpha much more complete local middle omega.', 'Alpha middle server.']
    ])('keeps same base node changes manual: %s', (_label, local, server) => {
        const result = computeParagraphSourceMerge(snapshots('Alpha middle omega.\n\nUntouched.\n',
            `${local}\n\nUntouched.\n`, `${server}\n\nUntouched.\n`));
        expect(result.kind).toBe('manual');
        if (result.kind === 'manual') {
            expect(result.reasonCode).toBe('article_vault_source_same_base_node');
            expect(result.baseNodeIdentities).toHaveLength(1);
        }
    });

    it('rejects two-way input and stale base, local or server even when candidate digest is resealed', () => {
        const input = snapshots('First.\n\nSecond.\n', 'Local first.\n\nSecond.\n', 'First.\n\nServer second.\n');
        const candidate = computed(input);
        for (const side of ['base', 'local', 'server'] as const) {
            expect(verifyParagraphSourceCandidate({ ...input, [side]: encode('Drifted first.\n\nSecond.\n') }, candidate)).toBe(false);
        }
        const { base: _base, ...twoWay } = input;
        expect(computeParagraphSourceMerge(twoWay as ParagraphSourceBytes)).toEqual({
            kind: 'rejected', reasonCode: 'article_vault_source_three_snapshots_required', diagnostics: []
        });
        for (const bytes of [input.local, input.server]) {
            expect(verifyParagraphSourceCandidate(input, reseal({ ...candidate, bytes }))).toBe(false);
        }
    });

    it('rejects freshly sealed direct diff edits, provenance swaps and unknown hunk authority', () => {
        const input = snapshots('First.\n\nSecond.\n', 'Local first.\n\nSecond.\n', 'First.\n\nServer second.\n');
        const candidate = computed(input);
        const first = candidate.hunks[0];
        const changes: ParagraphSourceCandidate[] = [
            { ...candidate, hunks: candidate.hunks.slice(1) },
            { ...candidate, hunks: [{ ...first, side: 'server' }, candidate.hunks[1]] },
            { ...candidate, hunks: [{ ...first, baseNodeIdentity: candidate.hunks[1].baseNodeIdentity }, candidate.hunks[1]] },
            { ...candidate, hunks: [{ ...first, insert: encode('UI injected bytes') }, candidate.hunks[1]] },
            { ...candidate, hunks: [{ ...first, from: first.from + 1 }, candidate.hunks[1]] },
            { ...candidate, hunks: [{ ...first, verified: true }, candidate.hunks[1]] } as ParagraphSourceCandidate,
            { ...candidate, parserVersion: 'caller-asserted-parser' },
            { ...candidate, baseSha256: candidate.localSha256 }
        ];
        for (const changed of changes) {
            expect(verifyParagraphSourceCandidate(input, reseal(changed))).toBe(false);
        }
    });

    it.each([
        ['heading', '# secret-private-heading\n\nParagraph.\n'],
        ['list', '- secret-private-item\n- Other\n'],
        ['table', '| secret-private-table | B |\n|---|---|\n| 1 | 2 |\n'],
        ['fenced block', '```text\nsecret-private-block\n```\n'],
        ['malformed fence', '```text\nsecret-private-malformed\n'],
        ['YAML publication', '---\nPublished: true\ntitle: secret-private-yaml\n---\n\nParagraph.\n'],
        ['conflict markers', '<<<<<<< local\nsecret-private-local\n=======\nsecret-private-server\n>>>>>>> server\n'],
        ['inline link', '[secret-private-link](https://private.example.test/token)\n'],
        ['raw HTML', '<div data-token="secret-private-html">Text</div>\n']
    ])('fails closed on %s in every coordinate without returning source or credentials', (_label, text) => {
        const original = snapshots('First.\n\nSecond.\n', 'Local.\n\nSecond.\n', 'First.\n\nServer.\n');
        for (const side of ['base', 'local', 'server'] as const) {
            const result = computeParagraphSourceMerge({ ...original, [side]: encode(text) });
            expect(result.kind).toBe('rejected');
            expect(JSON.stringify(result)).not.toContain('secret-private');
            expect(JSON.stringify(result)).not.toContain('private.example.test');
        }
    });

    it('rejects byte formatting drift and malformed UTF-8 rather than normalizing a candidate', () => {
        const input = snapshots('\uFEFFFirst.\r\n\r\nSecond.\r\n', '\uFEFFLocal.\r\n\r\nSecond.\r\n', '\uFEFFFirst.\r\n\r\nServer.\r\n');
        for (const local of [
            encode('Local.\r\n\r\nSecond.\r\n'),
            encode('\uFEFFLocal.\n\nSecond.\n'),
            encode('\uFEFFLocal.\r\n\r\nSecond.'),
            new Uint8Array([0xc0, 0xaf]),
            new Uint8Array([0xed, 0xa0, 0x80])
        ]) {
            expect(computeParagraphSourceMerge({ ...input, local }).kind).toBe('rejected');
        }
    });
});
