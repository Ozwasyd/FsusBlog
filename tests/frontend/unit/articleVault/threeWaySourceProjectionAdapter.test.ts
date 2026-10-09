import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import * as runtime from '@ozwasyd/element-plus/markdown-runtime';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeParagraphSourceMerge } from '@/services/articleVault/paragraphSourceMerge';
import {
    projectThreeWaySource,
    verifyThreeWaySourceProjection
} from '@/services/articleVault/threeWaySourceProjectionAdapter';
import type {
    ThreeWaySourceByteReference,
    ThreeWaySourceProjectionCoordinate,
    ThreeWaySourceProjectionInput,
    ThreeWaySourceProjectionResult
} from '@/services/articleVault/threeWaySourceProjectionAdapter';

const encode = (value: string) => new TextEncoder().encode(value);
const digest = (value: Uint8Array) => bytesToHex(sha256(value));
const valueDigest = (value: unknown) => digest(encode(JSON.stringify(value)));
const baseText = 'Alpha middle omega.\n\nOther paragraph.\n';

// Test fixtures follow the actual Shared value contract; they assert no runtime authority.
function sourceReference(text: string): ThreeWaySourceByteReference {
    const bytes = encode(text);
    const content = text.startsWith('\uFEFF') ? text.slice(1) : text;
    const endings = content.match(/\r\n|\r|\n/gu) ?? [];
    const kinds = new Set(endings);
    const lines = content.split(/\r\n|\r|\n/gu);
    return {
        sha256: digest(bytes), byteLength: bytes.length, hasUtf8Bom: text.startsWith('\uFEFF'),
        newlineStyle: kinds.size === 0 ? 'none' : kinds.size === 1 && kinds.has('\n') ? 'lf'
            : kinds.size === 1 && kinds.has('\r\n') ? 'cr-lf' : 'mixed',
        trailingWhitespaceLineCount: lines.filter(line => /[ \t]$/u.test(line)).length,
        hasFinalNewline: /[\r\n]$/u.test(content)
    };
}

function coordinate(text: string): ThreeWaySourceProjectionCoordinate {
    const value = {
        schema: 'fsusblog.article-vault.coordinate.v1', schemaVersion: 1, present: true, deleted: false,
        serverRevision: 1, source: sourceReference(text), metadataManifestSha256: valueDigest('metadata'),
        dependencySha256: valueDigest('dependency'), lifecycle: 'draft', permissionSha256: valueDigest('permission'),
        contentSha256: ''
    };
    return { ...value, contentSha256: valueDigest(value) };
}

function input(base = baseText, local = base, server = base): ThreeWaySourceProjectionInput {
    const projection = runtime.createMarkdownEditorProjection(base);
    const binding = {
        portableArticleIdentity: 'portable-article-2117', operationIdentity: 'operation-2117',
        planSha256: valueDigest('current-plan'),
        coordinates: { base: coordinate(base), local: coordinate(local), server: coordinate(server) }
    };
    return {
        bytes: { base: encode(base), local: encode(local), server: encode(server) },
        binding, currentInput: structuredClone(binding), sourceDisposition: { type: 'source-disjoint', disposition: 'automatic' },
        expectedRuntime: { parser: projection.identity.parser, parserVersion: projection.identity.version }
    };
}

function codes(result: ThreeWaySourceProjectionResult): readonly string[] {
    return result.diagnostics.map(item => item.code);
}

function expectManual(value: ThreeWaySourceProjectionInput, code: string): ThreeWaySourceProjectionResult {
    const result = projectThreeWaySource(value);
    expect(result.kind).toBe('manual');
    expect(codes(result)).toContain(code);
    expect(verifyThreeWaySourceProjection(value, result)).toBe(true);
    return result;
}

function expectRejected(value: ThreeWaySourceProjectionInput, code: string): void {
    const result = projectThreeWaySource(value);
    expect(result.kind).toBe('rejected');
    expect(codes(result)).toContain(code);
}

afterEach(() => vi.restoreAllMocks());

describe('Article Vault three-way source projection', () => {
    it('projects unchanged actual canonical nodes without granting admission', () => {
        const value = input();
        const result = projectThreeWaySource(value);
        expect(result.kind).toBe('projected');
        expect(result.changes).toEqual([]);
        expect(result.projections).toHaveLength(6);
        expect(verifyThreeWaySourceProjection(value, result)).toBe(true);
        expect(Object.keys(result)).toEqual(['kind', 'identity', 'projections', 'changes', 'diagnostics', 'contentSha256']);
        expect(JSON.stringify(result)).not.toMatch(/admitted|receipt|allowedActions|verified|historicalFact/u);
    });

    it('leaves the original disjoint paragraph computation intact', () => {
        const value = input('First paragraph.\n\nSecond paragraph.\n',
            'Edited first paragraph.\n\nSecond paragraph.\n', 'First paragraph.\n\nEdited second paragraph.\n');
        expect(computeParagraphSourceMerge(value.bytes).kind).toBe('computed');
        const result = projectThreeWaySource(value);
        expect(result.kind).toBe('manual');
        expect(codes(result)).toContain('correspondence_ambiguous');
        expect(result.changes[0].baseNodeIdentities).not.toEqual(result.changes[1].baseNodeIdentities);
    });

    it('projects only canonical retained identities for disjoint paragraph changes', () => {
        const value = input(baseText, baseText.replace('Alpha', 'Local'), baseText.replace('Other', 'Third'));
        const result = projectThreeWaySource(value);
        expect(result.kind).toBe('projected');
        expect(result.changes).toHaveLength(2);
        expect(result.changes[0].baseNodeIdentities).not.toEqual(result.changes[1].baseNodeIdentities);
        expect(verifyThreeWaySourceProjection(value, result)).toBe(true);
        expect(result).not.toHaveProperty('bytes');
    });

    it('reports same semantic node for disjoint byte ranges', () => {
        const result = expectManual(input(baseText, baseText.replace('Alpha', 'Local'), baseText.replace('omega', 'sigma')),
            'semantic_boundary_overlap');
        expect(codes(result)).not.toContain('byte_range_overlap');
        expect(result.changes[0].baseByteRange.to).toBeLessThan(result.changes[1].baseByteRange.from);
        expect(result.diagnostics.find(item => item.code === 'semantic_boundary_overlap')?.refs[0].kind).toBe('paragraph');
    });

    it('reports intersecting byte changes', () => {
        expectManual(input(baseText, baseText.replace('Alpha', 'Local'), baseText.replace('Alpha', 'Third')), 'byte_range_overlap');
    });

    it('reports heading boundary changes with canonical ranges', () => {
        const result = expectManual(input('# Heading\n\nBody.\n', '## Heading\n\nBody.\n'), 'structural_change_manual');
        expect(result.diagnostics.flatMap(item => item.refs).some(ref => ref.kind === 'heading')).toBe(true);
    });

    it('reports list boundary changes with canonical ranges', () => {
        const result = expectManual(input('- One\n- Two\n', '- One\n  - Two\n'), 'structural_change_manual');
        expect(result.projections.some(ref => ref.kind === 'list')).toBe(true);
    });

    it('reports table boundary changes with canonical ranges', () => {
        const result = expectManual(input('| A | B |\n|---|---|\n| 1 | 2 |\n',
            '| A | B | C |\n|---|---|---|\n| 1 | 2 | 3 |\n'), 'structural_change_manual');
        expect(result.projections.some(ref => ref.kind === 'table' && (ref.table?.rows.length ?? 0) > 0)).toBe(true);
    });

    it('reports fence boundary changes with canonical ranges', () => {
        const result = expectManual(input('```text\nBody\n```\n', '````text\nBody\n````\n'), 'structural_change_manual');
        expect(result.projections.some(ref => ref.kind === 'code' && ref.markerByteRanges.length > 0)).toBe(true);
    });

    it('reports unsupported frontmatter coverage without a second parser', () => {
        const result = projectThreeWaySource(input('---\ntitle: private-frontmatter\n---\n\nBody.\n',
            '---\ntitle: changed-frontmatter\n---\n\nBody.\n'));
        expect(result.kind).toBe('manual');
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(JSON.stringify(result)).not.toContain('frontmatter\n');
        expect(JSON.stringify(result)).not.toContain('private-frontmatter');
    });

    it('reports inline link semantic boundaries', () => {
        const result = expectManual(input('A [link](https://example.test/a).\n', 'A [link](https://example.test/b).\n'),
            'structural_change_manual');
        expect(result.projections.some(ref => ref.kind === 'link')).toBe(true);
    });

    it('reports anchor and embed semantic boundaries', () => {
        const source = '# Title ^stable-id\n\n::embed[target="target" mode="article"]\n';
        const result = projectThreeWaySource(input(source, source.replace('stable-id', 'new-anchor')));
        expect(result.kind).toBe('manual');
        expect(result.diagnostics.length).toBeGreaterThan(0);
        expect(result.projections.some(ref => ref.kind === 'anchor')).toBe(true);
        expect(result.projections.some(ref => ref.kind === 'embed')).toBe(true);
    });

    it('keeps raw HTML and angle boundaries unsupported even without changes', () => {
        const result = expectManual(input('<div>private-html</div>\n'), 'html_or_angle_boundary_unsupported');
        expect(JSON.stringify(result)).not.toContain('private-html');
    });

    it('reports deletion versus edit at the original node', () => {
        const result = expectManual(input('First.\n\nSecond.\n', 'Second.\n', 'First edited.\n\nSecond.\n'), 'delete_vs_edit');
        const diagnostic = result.diagnostics.find(item => item.code === 'delete_vs_edit');
        expect(diagnostic?.refs[0].rawByteRange).toEqual({ from: 0, to: 7 });
        expectManual(input('First.\n', '\n', 'First edited.\n'), 'delete_vs_edit');
    });

    it('reports exact syntax movement ambiguity without retargeting', () => {
        expectManual(input('First.\n\nSecond.\n', 'Second.\n\nFirst.\n'), 'movement_or_identity_ambiguous');
    });

    it('reports repeated syntax ambiguity without guessing a match', () => {
        expectManual(input('Same.\n\nSame.\n', 'Changed.\n\nSame.\n'), 'repeated_syntax_ambiguous');
    });

    it('keeps new canonical IDs ambiguous after length-changing edits', () => {
        const value = input(baseText, baseText.replace('Alpha', 'Very long changed text'));
        const result = expectManual(value, 'correspondence_ambiguous');
        const original = result.projections.find(ref => ref.source === 'base');
        const changed = result.projections.find(ref => ref.source === 'local');
        expect(changed?.nodeIdentity).not.toBe(original?.nodeIdentity);
    });

    it('rejects malformed unclosed fences with actual parser diagnostics', () => {
        const value = input('```text\nprivate-unclosed\n');
        expectRejected(value, 'malformed_source');
        const result = projectThreeWaySource(value);
        expect(result.projections.some(ref => ref.status === 'malformed' && ref.diagnosticCode !== null)).toBe(true);
        expect(JSON.stringify(result)).not.toContain('private-unclosed');
    });

    it('rejects unknown parser state without exposing exception context', () => {
        const value = input();
        vi.spyOn(runtime, 'createMarkdownEditorProjection').mockImplementationOnce(() => {
            throw new Error('private-parser-exception-context');
        });
        const result = projectThreeWaySource(value);
        expect(result.kind).toBe('rejected');
        expect(codes(result)).toContain('parser_utf8_coordinate_or_budget_unavailable');
        expect(JSON.stringify(result)).not.toContain('private-parser-exception-context');
    });

    it('rejects parser version drift against the actual current runtime', () => {
        const value = input();
        expectRejected({ ...value, expectedRuntime: { ...value.expectedRuntime, parserVersion: 'old-version' } }, 'parser_or_version_drift');
        expectRejected({ ...value, expectedRuntime: { ...value.expectedRuntime, parser: 'other-parser' } }, 'parser_or_version_drift');
    });

    it('preserves BOM CRLF emoji trailing spaces and final newline byte offsets', () => {
        const source = '\uFEFFAlpha 😀 omega.  \r\n\r\nOther.\r\n';
        const value = input(source, source.replace('Alpha', 'Local'), source.replace('omega', 'sigma'));
        const original = structuredClone(value.bytes);
        const result = expectManual(value, 'semantic_boundary_overlap');
        expect(result.changes[0].baseByteRange).toEqual({ from: 3, to: 8 });
        const projection = runtime.createMarkdownEditorProjection(source);
        const coordinates = runtime.createMarkdownSourceCoordinateMap(source);
        for (const ref of result.projections.filter(ref => ref.source === 'base')) {
            const node = projection.nodes.find(entry => entry.blockIdentity === ref.blockIdentity);
            expect(node).toBeDefined();
            if (!node) throw new Error('missing_canonical_node');
            expect(ref.rawByteRange).toEqual({
                from: coordinates.toRawUtf8Offset(node.rawRange.start), to: coordinates.toRawUtf8Offset(node.rawRange.end)
            });
        }
        expect(result.identity.inputs[0].source).toEqual(sourceReference(source));
        expect(value.bytes).toEqual(original);
    });

    it('keeps an emoji replacement on whole UTF8 scalar boundaries', () => {
        const value = input('Alpha 😀 omega.\n', 'Alpha 😎 omega.\n');
        const result = projectThreeWaySource(value);
        expect(result.changes[0].baseByteRange).toEqual({ from: 6, to: 10 });
        expect(result.changes[0].nextByteRange).toEqual({ from: 6, to: 10 });
        expect(result.changes[0].nextSliceSha256).toBe(digest(encode('😎')));
    });

    it('preserves LF missing final newline and mixed newline facts', () => {
        for (const source of ['No final newline', 'First.\n\nSecond.\n', 'First.\r\n\r\nSecond.\n', 'First.\rSecond.\r']) {
            const value = input(source);
            const result = projectThreeWaySource(value);
            expect(result.identity.inputs[0].source).toEqual(sourceReference(source));
            expect(result.changes).toEqual([]);
            expect(verifyThreeWaySourceProjection(value, result)).toBe(true);
        }
    });

    it('reports normalization trim and newline changes instead of hiding them', () => {
        const source = '\uFEFFAlpha.  \r\n\r\nOther.\r\n';
        const value = input(source, 'Alpha.\n\nOther.\n');
        const result = projectThreeWaySource(value);
        expect(result.kind).toBe('manual');
        expect(result.changes).toHaveLength(1);
        expect(result.identity.inputs[0].source.sha256).not.toBe(result.identity.inputs[1].source.sha256);
        expect(computeParagraphSourceMerge(value.bytes).kind).toBe('rejected');
    });

    it('rejects missing base rather than falling back to two-way comparison', () => {
        const value = input();
        expectRejected({ ...value, bytes: { local: value.bytes.local, server: value.bytes.server } } as ThreeWaySourceProjectionInput,
            'three_snapshots_required');
    });

    it('rejects byte tamper and stale source reference facts', () => {
        const value = input();
        const changed = value.bytes.local.slice();
        changed[0] = 66;
        expectRejected({ ...value, bytes: { ...value.bytes, local: changed } }, 'source_reference_mismatch');
        const binding = structuredClone(value.binding);
        const c = binding.coordinates.local;
        const source = { ...c.source!, byteLength: c.source!.byteLength + 1 };
        const updated = { ...c, source, contentSha256: '' };
        const coordinates = { ...binding.coordinates, local: { ...updated, contentSha256: valueDigest(updated) } };
        expectRejected({ ...value, binding: { ...binding, coordinates }, currentInput: { ...binding, coordinates } }, 'source_reference_mismatch');
    });

    it('rejects portable identity operation and current coordinate drift', () => {
        const value = input();
        expectRejected({ ...value, currentInput: { ...value.currentInput, portableArticleIdentity: 'other-article' } }, 'identity_or_coordinate_drift');
        expectRejected({ ...value, currentInput: { ...value.currentInput, operationIdentity: 'other-operation' } }, 'identity_or_coordinate_drift');
        const c = value.currentInput.coordinates.local;
        expectRejected({ ...value, currentInput: { ...value.currentInput, coordinates: {
            ...value.currentInput.coordinates, local: { ...c, contentSha256: valueDigest('stale-coordinate') }
        } } }, 'identity_or_coordinate_drift');
    });

    it('rejects coordinate schema digest and missing snapshot drift', () => {
        const value = input();
        for (const patch of [{ schemaVersion: 2 }, { contentSha256: valueDigest('wrong') }, { present: false }, { deleted: true }]) {
            const binding = { ...value.binding, coordinates: {
                ...value.binding.coordinates, base: { ...value.binding.coordinates.base, ...patch }
            } };
            expectRejected({ ...value, binding, currentInput: binding }, 'identity_or_coordinate_drift');
        }
    });

    it('preserves upstream manual and rejected source dispositions', () => {
        const value = input();
        expectManual({ ...value, sourceDisposition: { type: 'source-overlap', disposition: 'manual' } }, 'upstream_source_disposition');
        expectRejected({ ...value, sourceDisposition: { type: 'source-disjoint', disposition: 'rejected' } }, 'upstream_source_disposition');
        expectRejected({ ...value, sourceDisposition: { type: 'source-overlap', disposition: 'automatic' } }, 'source_disposition_invalid');
    });

    it('binds algorithm policy parser version inputs ranges and diagnostics against tamper', () => {
        const value = input(baseText, baseText.replace('Alpha', 'Local'), baseText.replace('omega', 'sigma'));
        const result = projectThreeWaySource(value);
        expect(verifyThreeWaySourceProjection(value, result)).toBe(true);
        for (const field of ['algorithmVersion', 'algorithmSha256', 'policySha256', 'parser', 'parserVersion', 'parserContractSha256', 'bindingSha256', 'syntaxCoverageSha256']) {
            expect(verifyThreeWaySourceProjection(value, { ...result, identity: { ...result.identity, [field]: 'drift' } })).toBe(false);
        }
        expect(verifyThreeWaySourceProjection(value, { ...result, changes: [] })).toBe(false);
        expect(verifyThreeWaySourceProjection(value, { ...result, diagnostics: [] })).toBe(false);
        expect(verifyThreeWaySourceProjection(value, { ...result, contentSha256: valueDigest('tampered') })).toBe(false);
        expect(verifyThreeWaySourceProjection(value, { ...result, hiddenContext: 'private-full-context' })).toBe(false);
        expect(verifyThreeWaySourceProjection(input(), result)).toBe(false);
    });

    it('rejects invalid UTF8 actual bytes and bounds projection workload', () => {
        const value = input();
        const invalid = new Uint8Array([0xc0, 0xaf]);
        const validLength = coordinate('aa');
        const invalidCoordinate = { ...validLength, source: { ...validLength.source!, sha256: digest(invalid) }, contentSha256: '' };
        const local = { ...invalidCoordinate, contentSha256: valueDigest(invalidCoordinate) };
        const binding = { ...value.binding, coordinates: { ...value.binding.coordinates, local } };
        expectRejected({ ...value, bytes: { ...value.bytes, local: invalid }, binding, currentInput: binding },
            'parser_utf8_coordinate_or_budget_unavailable');
        expectRejected({ ...value, bytes: { ...value.bytes, local: new Uint8Array(131073) } }, 'snapshot_budget_exceeded');
        const many = input(Array.from({ length: 257 }, (_, index) => `Paragraph ${index}.\n`).join('\n'));
        expectRejected(many, 'parser_utf8_coordinate_or_budget_unavailable');
    });

    it('keeps full source and hidden diagnostic context out of ordinary logs', () => {
        const source = '# private-sensitive-heading\n\nprivate-sensitive-body 😀\n';
        const value = input(source, source.replace('# ', '## '));
        const spies = [vi.spyOn(console, 'log'), vi.spyOn(console, 'warn'), vi.spyOn(console, 'error')];
        const result = projectThreeWaySource(value);
        expect(result.kind).toBe('manual');
        expect(JSON.stringify(result)).not.toContain('private-sensitive');
        expect(JSON.stringify(result)).not.toContain(source);
        for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    });
});
