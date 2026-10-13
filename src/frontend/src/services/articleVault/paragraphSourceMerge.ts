import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    createMarkdownEditorProjection,
    createMarkdownSourceCoordinateMap,
    stabilizeMarkdownEditorProjection,
    type MarkdownEditorProjectionResult
} from '@ozwasyd/element-plus/markdown-runtime';

import {
    projectThreeWaySource,
    verifyThreeWaySourceProjection,
    type ThreeWaySourceProjectionInput,
    type ThreeWaySourceProjectionResult
} from '@/services/articleVault/threeWaySourceProjectionAdapter';

/** Pure computation only. The Shared process-owned admission proof has no frontend transport yet. */
export interface ParagraphSourceBytes {
    readonly base: Uint8Array;
    readonly local: Uint8Array;
    readonly server: Uint8Array;
}

export interface ParagraphSourceHunk {
    readonly side: 'local' | 'server';
    readonly from: number;
    readonly to: number;
    readonly baseNodeIdentity: string;
    readonly insert: Uint8Array;
}

export interface ParagraphSourceProvenance {
    readonly algorithmVersion: typeof algorithmVersion;
    readonly policySha256: string;
    readonly parser: string;
    readonly parserVersion: string;
    readonly baseSha256: string;
    readonly localSha256: string;
    readonly serverSha256: string;
}

export interface ParagraphSourceCandidate extends ParagraphSourceProvenance {
    readonly hunks: readonly ParagraphSourceHunk[];
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
}

export interface ParagraphSourceConflictDiagnostic {
    readonly baseNodeIdentity: string;
    readonly baseByteRange: { readonly from: number; readonly to: number; };
    readonly local: ParagraphSourceHunkRef;
    readonly server: ParagraphSourceHunkRef;
}

export interface ParagraphSourceHunkRef {
    readonly from: number;
    readonly to: number;
    readonly sourceSha256: string;
    readonly insertSha256: string;
    readonly insertByteLength: number;
}

export interface ParagraphSourceSyntaxDiagnostic {
    readonly source: 'base' | 'local' | 'server' | 'candidate';
    readonly sourceSha256: string;
    readonly parser: string;
    readonly parserVersion: string;
    readonly nodeIdentity: string;
    readonly kind: string;
    readonly status: string;
    readonly diagnosticCode: string | null;
    readonly rawUtf16Range: { readonly from: number; readonly to: number; };
    readonly rawByteRange: { readonly from: number; readonly to: number; };
    readonly diagnostics: readonly {
        readonly code: string;
        readonly rawUtf16Range: { readonly from: number; readonly to: number; };
        readonly rawByteRange: { readonly from: number; readonly to: number; };
    }[];
}

export type ParagraphSourceResult =
    | { readonly kind: 'computed'; readonly candidate: ParagraphSourceCandidate; }
    | {
        readonly kind: 'manual'; readonly reasonCode: string; readonly baseNodeIdentities: readonly string[];
        readonly conflicts: readonly ParagraphSourceConflictDiagnostic[]; readonly provenance: ParagraphSourceProvenance;
    }
    | { readonly kind: 'rejected'; readonly reasonCode: string; readonly diagnostics: readonly ParagraphSourceSyntaxDiagnostic[]; };

/** Value-bound composition only; the host still owns verified-input transport and admission. */
export interface ProjectedParagraphSourceCandidate {
    readonly algorithmVersion: typeof projectedAlgorithmVersion;
    readonly projection: ThreeWaySourceProjectionResult;
    readonly paragraph: ParagraphSourceCandidate;
    readonly contentSha256: string;
}

export type ProjectedParagraphSourceResult =
    | { readonly kind: 'computed'; readonly candidate: ProjectedParagraphSourceCandidate; }
    | {
        readonly kind: 'manual' | 'rejected'; readonly projection: ThreeWaySourceProjectionResult;
        readonly paragraph: ParagraphSourceResult | null;
    };

const projectedAlgorithmVersion = 'fsusblog.article-vault.projected-paragraph-computation.v1';

const algorithmVersion = 'fsusblog.article-vault.paragraph-byte-computation.v1';
const policySha256 = hash(new TextEncoder().encode(JSON.stringify([
    algorithmVersion, 'canonical-public-projection', 'paragraph-only', 'same-base-node-manual',
    'raw-byte-hunks', 'unchanged-boundaries', 'html-boundary-unsupported', 'closed-own-candidate-data', 'no-coordinate-admission'
])));

interface Paragraph {
    readonly id: string;
    readonly nodeFrom: number;
    readonly nodeTo: number;
    readonly from: number;
    readonly to: number;
    readonly content: Uint8Array;
}

interface Snapshot {
    readonly bytes: Uint8Array;
    readonly projection: MarkdownEditorProjectionResult;
    readonly paragraphs: readonly Paragraph[];
    readonly boundaries: readonly Uint8Array[];
}

interface SourceFailure {
    readonly reasonCode: string;
    readonly diagnostics: readonly ParagraphSourceSyntaxDiagnostic[];
}

interface ThreeSnapshots {
    readonly base: Snapshot;
    readonly local: Snapshot;
    readonly server: Snapshot;
}

/** Canonical projection may restrict the original paragraph computation, never widen its eligibility. */
export function computeProjectedParagraphSourceMerge(input: ThreeWaySourceProjectionInput): ProjectedParagraphSourceResult
{
    const held = holdProjectionBytes(input);
    const projection = projectThreeWaySource(held);
    if (projection.kind !== 'projected')
    {
        return { kind: projection.kind, projection, paragraph: null };
    }
    if (!verifyThreeWaySourceProjection(held, projection))
    {
        return { kind: 'rejected', projection, paragraph: null };
    }
    const paragraph = computeParagraphSourceMerge(held.bytes);
    if (paragraph.kind !== 'computed')
    {
        return { kind: paragraph.kind, projection, paragraph };
    }
    if (!verifyParagraphSourceCandidate(held.bytes, paragraph.candidate))
    {
        return { kind: 'rejected', projection, paragraph: null };
    }
    return {
        kind: 'computed', candidate: {
            algorithmVersion: projectedAlgorithmVersion, projection, paragraph: paragraph.candidate,
            contentSha256: projectedCandidateDigest(projection.contentSha256, paragraph.candidate.contentSha256)
        }
    };
}

/** Fresh canonical projection and the original independent byte/hunk verifier both have to agree. */
export function verifyProjectedParagraphSourceCandidate(input: ThreeWaySourceProjectionInput, supplied: unknown): boolean
{
    try
    {
        const fields = readOwnData(supplied, ['algorithmVersion', 'projection', 'paragraph', 'contentSha256']);
        if (fields?.algorithmVersion !== projectedAlgorithmVersion || typeof fields.contentSha256 !== 'string')
        {
            return false;
        }
        const held = holdProjectionBytes(input);
        const fresh = projectThreeWaySource(held);
        // Read supplied nested candidates only through the original descriptor-based verifiers.
        const paragraph = readClosedCandidate(fields.paragraph, 256);
        return fresh.kind === 'projected' && paragraph !== null
            && verifyThreeWaySourceProjection(held, fields.projection)
            && verifyParagraphSourceCandidate(held.bytes, paragraph)
            && fields.contentSha256 === projectedCandidateDigest(fresh.contentSha256, paragraph.contentSha256);
    }
    catch
    {
        return false;
    }
}

function holdProjectionBytes(input: ThreeWaySourceProjectionInput): ThreeWaySourceProjectionInput
{
    if (!input?.bytes || !(input.bytes.base instanceof Uint8Array) || !(input.bytes.local instanceof Uint8Array)
        || !(input.bytes.server instanceof Uint8Array)
        // Oversized inputs go directly to the canonical adapter's refusal without an extra allocation.
        || [input.bytes.base, input.bytes.local, input.bytes.server].some(bytes => bytes.byteLength > 131072))
    {
        return input;
    }
    return { ...input, bytes: {
        base: input.bytes.base.slice(), local: input.bytes.local.slice(), server: input.bytes.server.slice()
    } };
}

function projectedCandidateDigest(projectionSha256: string, paragraphSha256: string): string
{
    return hash(new TextEncoder().encode(JSON.stringify([projectedAlgorithmVersion, projectionSha256, paragraphSha256])));
}

/** No plan fields, asserted verified flags, storage, writer or coordinate-admission result. */
export function computeParagraphSourceMerge(input: ParagraphSourceBytes): ParagraphSourceResult
{
    const read = readSnapshots(input);
    if ('reasonCode' in read)
    {
        return { kind: 'rejected', ...read };
    }
    const local = changes(read.base, read.local, 'local');
    const server = changes(read.base, read.server, 'server');
    const bound = provenance(read);
    const overlap = local.filter(left => server.some(right => left.baseNodeIdentity === right.baseNodeIdentity));
    if (overlap.length > 0)
    {
        return {
            kind: 'manual', reasonCode: 'article_vault_source_same_base_node',
            baseNodeIdentities: overlap.map(hunk => hunk.baseNodeIdentity),
            provenance: bound,
            conflicts: overlap.map(left =>
            {
                const right = server.find(entry => entry.baseNodeIdentity === left.baseNodeIdentity)!;
                const node = read.base.paragraphs.find(entry => entry.id === left.baseNodeIdentity)!;
                return {
                    baseNodeIdentity: left.baseNodeIdentity,
                    baseByteRange: { from: node.nodeFrom, to: node.nodeTo },
                    local: hunkRef(left, bound.localSha256), server: hunkRef(right, bound.serverSha256)
                };
            })
        };
    }
    const hunks = [...local, ...server].sort((left, right) => left.from - right.from);
    const bytes = apply(read.base.bytes, hunks);
    const parsed = readOne(bytes, hash(read.base.bytes), 'candidate');
    if ('reasonCode' in parsed || parsed.paragraphs.length !== read.base.paragraphs.length)
    {
        return { kind: 'rejected', reasonCode: 'article_vault_source_candidate_boundary_drift',
            diagnostics: 'reasonCode' in parsed ? parsed.diagnostics : [] };
    }
    const candidate: ParagraphSourceCandidate = {
        ...bound,
        hunks, bytes, contentSha256: ''
    };
    return { kind: 'computed', candidate: { ...candidate, contentSha256: paragraphSourceCandidateDigest(candidate) } };
}

/** Rereads actual bytes/parser output and checks every original paragraph decision without calling compute. */
export function verifyParagraphSourceCandidate(input: ParagraphSourceBytes, suppliedCandidate: unknown): boolean
{
    const read = readSnapshots(input);
    if ('reasonCode' in read)
    {
        return false;
    }
    // Read only closed own data descriptors, then own copies; no candidate or hunk getter is executed.
    const candidate = readClosedCandidate(suppliedCandidate, read.base.paragraphs.length);
    if (candidate?.algorithmVersion !== algorithmVersion
        || candidate.policySha256 !== policySha256 || candidate.parser !== read.base.projection.identity.parser
        || candidate.parserVersion !== read.base.projection.identity.version
        || candidate.baseSha256 !== hash(read.base.bytes) || candidate.localSha256 !== hash(read.local.bytes)
        || candidate.serverSha256 !== hash(read.server.bytes))
    {
        return false;
    }
    const expected: ParagraphSourceHunk[] = [];
    for (let index = 0; index < read.base.paragraphs.length; index++)
    {
        const base = read.base.paragraphs[index];
        const local = read.local.paragraphs[index];
        const server = read.server.paragraphs[index];
        const localChanged = !equal(base.content, local.content);
        const serverChanged = !equal(base.content, server.content);
        if (localChanged && serverChanged)
        {
            return false;
        }
        if (localChanged)
        {
            expected.push(hunk(base, local, 'local'));
        }
        else if (serverChanged)
        {
            expected.push(hunk(base, server, 'server'));
        }
    }
    expected.sort((left, right) => left.from - right.from);
    if (candidate.hunks.length !== expected.length)
    {
        return false;
    }
    for (let index = 0; index < expected.length; index++)
    {
        const actual = candidate.hunks[index];
        const original = expected[index];
        if (!actual || !(actual.insert instanceof Uint8Array) || actual.side !== original.side
            || actual.from !== original.from || actual.to !== original.to
            || actual.baseNodeIdentity !== original.baseNodeIdentity || !equal(actual.insert, original.insert))
        {
            return false;
        }
    }
    const bytes = apply(read.base.bytes, expected);
    const parsed = readOne(bytes, hash(read.base.bytes), 'candidate');
    return !('reasonCode' in parsed) && parsed.paragraphs.length === read.base.paragraphs.length
        && equal(candidate.bytes, bytes) && candidate.contentSha256 === paragraphSourceCandidateDigest(candidate);
}

export function paragraphSourceCandidateDigest(candidate: ParagraphSourceCandidate): string
{
    return hash(new TextEncoder().encode(JSON.stringify([
        candidate.algorithmVersion, candidate.policySha256, candidate.parser, candidate.parserVersion,
        candidate.baseSha256, candidate.localSha256, candidate.serverSha256,
        candidate.hunks.map(h => [h.side, h.from, h.to, h.baseNodeIdentity, hash(h.insert)]), hash(candidate.bytes)
    ])));
}

function readOwnData(value: unknown, fields: readonly string[]): Record<string, unknown> | null
{
    if (value === null || typeof value !== 'object'
        || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null))
    {
        return null;
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || keys.some(key => typeof key !== 'string' || !fields.includes(key)))
    {
        return null;
    }
    const entries: [string, unknown][] = [];
    for (const field of fields)
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, field);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        {
            return null;
        }
        const data: unknown = descriptor.value;
        entries.push([field, data]);
    }
    return Object.fromEntries(entries);
}

function copyClosedBytes(value: unknown): Uint8Array | null
{
    if (!(value instanceof Uint8Array) || Object.getPrototypeOf(value) !== Uint8Array.prototype)
    {
        return null;
    }
    // Reject custom properties/accessors before any byte-array member is consumed.
    for (const key of Reflect.ownKeys(value))
    {
        if (typeof key !== 'string' || !Number.isSafeInteger(Number(key)) || Number(key) < 0 || String(Number(key)) !== key)
        {
            return null;
        }
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !Object.hasOwn(descriptor, 'value'))
        {
            return null;
        }
    }
    return new Uint8Array(value);
}

function readClosedCandidate(value: unknown, maxHunks: number): ParagraphSourceCandidate | null
{
    try
    {
        const fields = readOwnData(value, ['algorithmVersion', 'policySha256', 'parser', 'parserVersion',
            'baseSha256', 'localSha256', 'serverSha256', 'hunks', 'bytes', 'contentSha256']);
        if (fields?.algorithmVersion !== algorithmVersion || typeof fields.policySha256 !== 'string'
            || typeof fields.parser !== 'string' || typeof fields.parserVersion !== 'string'
            || typeof fields.baseSha256 !== 'string' || typeof fields.localSha256 !== 'string'
            || typeof fields.serverSha256 !== 'string' || typeof fields.contentSha256 !== 'string'
            || !Array.isArray(fields.hunks))
        {
            return null;
        }
        const bytes = copyClosedBytes(fields.bytes);
        const lengthDescriptor = Object.getOwnPropertyDescriptor(fields.hunks, 'length');
        const length: unknown = lengthDescriptor?.value;
        if (!bytes || typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > maxHunks
            || Reflect.ownKeys(fields.hunks).length !== length + 1)
        {
            return null;
        }
        const hunks: ParagraphSourceHunk[] = [];
        for (let index = 0; index < length; index++)
        {
            const descriptor = Object.getOwnPropertyDescriptor(fields.hunks, index);
            if (!descriptor || !Object.hasOwn(descriptor, 'value'))
            {
                return null;
            }
            const entry: unknown = descriptor.value;
            const h = readOwnData(entry, ['side', 'from', 'to', 'baseNodeIdentity', 'insert']);
            if (!h || (h.side !== 'local' && h.side !== 'server') || typeof h.from !== 'number'
                || !Number.isSafeInteger(h.from) || h.from < 0 || typeof h.to !== 'number'
                || !Number.isSafeInteger(h.to) || h.to < h.from || typeof h.baseNodeIdentity !== 'string'
                || h.baseNodeIdentity.length === 0)
            {
                return null;
            }
            const insert = copyClosedBytes(h.insert);
            if (!insert)
            {
                return null;
            }
            hunks.push({ side: h.side, from: h.from, to: h.to, baseNodeIdentity: h.baseNodeIdentity, insert });
        }
        return {
            algorithmVersion, policySha256: fields.policySha256, parser: fields.parser, parserVersion: fields.parserVersion,
            baseSha256: fields.baseSha256, localSha256: fields.localSha256, serverSha256: fields.serverSha256,
            hunks, bytes, contentSha256: fields.contentSha256
        };
    }
    catch
    {
        return null;
    }
}

function readSnapshots(input: ParagraphSourceBytes): ThreeSnapshots | SourceFailure
{
    if (!input || !(input.base instanceof Uint8Array) || !(input.local instanceof Uint8Array)
        || !(input.server instanceof Uint8Array))
    {
        return failure('article_vault_source_three_snapshots_required');
    }
    const documentId = hash(input.base);
    const base = readOne(input.base, documentId, 'base');
    const local = readOne(input.local, documentId, 'local');
    const server = readOne(input.server, documentId, 'server');
    if ('reasonCode' in base)
    {
        return base;
    }
    if ('reasonCode' in local)
    {
        return local;
    }
    if ('reasonCode' in server)
    {
        return server;
    }
    for (const next of [local, server])
    {
        if (next.projection.identity.parser !== base.projection.identity.parser
            || next.projection.identity.version !== base.projection.identity.version)
        {
            return failure('article_vault_source_parser_drift');
        }
        if (next.paragraphs.length !== base.paragraphs.length)
        {
            return failure('article_vault_source_boundary_or_delete_ambiguity');
        }
        if (next.boundaries.length !== base.boundaries.length
            || next.boundaries.some((bytes, index) => !equal(bytes, base.boundaries[index])))
        {
            return failure('article_vault_source_boundary_drift');
        }
        if (!equal(next.bytes.slice(0, hasBom(next.bytes) ? 3 : 0), base.bytes.slice(0, hasBom(base.bytes) ? 3 : 0)))
        {
            return failure('article_vault_source_format_drift');
        }
        for (let index = 0; index < base.paragraphs.length; index++)
        {
            if (!equal(base.paragraphs[index].content, next.paragraphs[index].content)
                && base.paragraphs.some((paragraph, other) => other !== index
                    && equal(paragraph.content, next.paragraphs[index].content)))
            {
                return failure('article_vault_source_move_ambiguity');
            }
        }
    }
    return { base, local, server };
}

function readOne(original: Uint8Array, documentId: string, source: ParagraphSourceSyntaxDiagnostic['source']): Snapshot | SourceFailure
{
    const bytes = original.slice();
    try
    {
        const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!equal(new TextEncoder().encode(raw), bytes))
        {
            return failure('article_vault_source_utf8_invalid');
        }
        const projection = createMarkdownEditorProjection(raw);
        const coordinates = createMarkdownSourceCoordinateMap(raw);
        // Conservative eligibility restriction only. Diagnostics retain the parser's actual paragraph kind.
        if (bytes.includes(60) || bytes.includes(62))
        {
            return failure('article_vault_source_html_boundary_unsupported', syntaxDiagnostics(projection, coordinates, bytes, source));
        }
        if (projection.identity.rawSource !== raw || projection.diagnostics.length > 0 || projection.nodes.length === 0
            || projection.nodes.some(node => node.kind !== 'paragraph' || node.status !== 'valid'
                || node.diagnosticCode !== null || node.parentRawRange !== null || node.childRawRanges.length > 0
                || node.rawMarkerRanges.length > 0 || node.rawContentRanges.length !== 1))
        {
            return failure('article_vault_source_semantic_boundary_unsupported', syntaxDiagnostics(projection, coordinates, bytes, source));
        }
        const stable = stabilizeMarkdownEditorProjection(projection, { id: documentId, epoch: 1 });
        const paragraphs: Paragraph[] = [];
        const boundaries: Uint8Array[] = [];
        let previous = 0;
        for (let index = 0; index < projection.nodes.length; index++)
        {
            const node = projection.nodes[index];
            const content = node.rawContentRanges[0];
            const from = coordinates.toRawUtf8Offset(content.start);
            const to = coordinates.toRawUtf8Offset(content.end);
            if (from < previous || to < from || to > bytes.length
                || coordinates.toRawOffsetFromUtf8(from) !== content.start
                || coordinates.toRawOffsetFromUtf8(to) !== content.end)
            {
                return failure('article_vault_source_coordinate_invalid');
            }
            boundaries.push(bytes.slice(previous, from));
            paragraphs.push({ id: stable.nodes[index].id, from, to, content: bytes.slice(from, to),
                nodeFrom: coordinates.toRawUtf8Offset(node.rawRange.start), nodeTo: coordinates.toRawUtf8Offset(node.rawRange.end) });
            previous = to;
        }
        boundaries.push(bytes.slice(previous));
        return { bytes, projection, paragraphs, boundaries };
    }
    catch
    {
        return failure('article_vault_source_parser_or_utf8_unavailable');
    }
}

function failure(reasonCode: string, diagnostics: readonly ParagraphSourceSyntaxDiagnostic[] = []): SourceFailure
{
    return { reasonCode, diagnostics };
}

function provenance(read: ThreeSnapshots): ParagraphSourceProvenance
{
    return {
        algorithmVersion, policySha256, parser: read.base.projection.identity.parser,
        parserVersion: read.base.projection.identity.version,
        baseSha256: hash(read.base.bytes), localSha256: hash(read.local.bytes), serverSha256: hash(read.server.bytes)
    };
}

function hunkRef(h: ParagraphSourceHunk, sourceSha256: string): ParagraphSourceHunkRef
{
    return { from: h.from, to: h.to, sourceSha256, insertSha256: hash(h.insert), insertByteLength: h.insert.length };
}

function syntaxDiagnostics(
    projection: MarkdownEditorProjectionResult,
    coordinates: ReturnType<typeof createMarkdownSourceCoordinateMap>,
    bytes: Uint8Array,
    source: ParagraphSourceSyntaxDiagnostic['source']
): readonly ParagraphSourceSyntaxDiagnostic[]
{
    const sourceSha256 = hash(bytes);
    return projection.nodes.map(node => ({
        source, sourceSha256, parser: projection.identity.parser, parserVersion: projection.identity.version,
        nodeIdentity: node.blockIdentity, kind: node.kind, status: node.status, diagnosticCode: node.diagnosticCode,
        rawUtf16Range: { from: node.rawRange.start, to: node.rawRange.end },
        rawByteRange: { from: coordinates.toRawUtf8Offset(node.rawRange.start), to: coordinates.toRawUtf8Offset(node.rawRange.end) },
        diagnostics: projection.diagnostics.filter(d => d.blockIdentity === node.blockIdentity).map(d => ({
            code: d.code, rawUtf16Range: { from: d.rawRange.start, to: d.rawRange.end },
            rawByteRange: { from: coordinates.toRawUtf8Offset(d.rawRange.start), to: coordinates.toRawUtf8Offset(d.rawRange.end) }
        }))
    }));
}

function changes(base: Snapshot, next: Snapshot, side: 'local' | 'server'): ParagraphSourceHunk[]
{
    return base.paragraphs.flatMap((paragraph, index) => equal(paragraph.content, next.paragraphs[index].content)
        ? [] : [hunk(paragraph, next.paragraphs[index], side)]);
}

function hunk(base: Paragraph, next: Paragraph, side: 'local' | 'server'): ParagraphSourceHunk
{
    let prefix = 0;
    while (prefix < base.content.length && prefix < next.content.length && base.content[prefix] === next.content[prefix])
    {
        prefix++;
    }
    let leftEnd = base.content.length;
    let rightEnd = next.content.length;
    while (leftEnd > prefix && rightEnd > prefix && base.content[leftEnd - 1] === next.content[rightEnd - 1])
    {
        leftEnd--;
        rightEnd--;
    }
    return { side, from: base.from + prefix, to: base.from + leftEnd, baseNodeIdentity: base.id, insert: next.content.slice(prefix, rightEnd) };
}

function apply(base: Uint8Array, hunks: readonly ParagraphSourceHunk[]): Uint8Array
{
    const length = base.length + hunks.reduce((sum, h) => sum + h.insert.length - (h.to - h.from), 0);
    const output = new Uint8Array(length);
    let previous = 0;
    let offset = 0;
    for (const h of hunks)
    {
        const unchanged = base.slice(previous, h.from);
        output.set(unchanged, offset);
        offset += unchanged.length;
        output.set(h.insert, offset);
        offset += h.insert.length;
        previous = h.to;
    }
    output.set(base.slice(previous), offset);
    return output;
}

function equal(left: Uint8Array, right: Uint8Array): boolean
{
    return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

function hasBom(bytes: Uint8Array): boolean
{
    return bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
}

function hash(bytes: Uint8Array): string
{
    return bytesToHex(sha256(bytes));
}
