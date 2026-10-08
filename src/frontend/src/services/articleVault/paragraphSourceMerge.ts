import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    createMarkdownEditorProjection,
    createMarkdownSourceCoordinateMap,
    stabilizeMarkdownEditorProjection,
    type MarkdownEditorProjectionResult
} from '@ozwasyd/element-plus/markdown-runtime';

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

export interface ParagraphSourceCandidate {
    readonly algorithmVersion: typeof algorithmVersion;
    readonly policySha256: string;
    readonly parser: string;
    readonly parserVersion: string;
    readonly baseSha256: string;
    readonly localSha256: string;
    readonly serverSha256: string;
    readonly hunks: readonly ParagraphSourceHunk[];
    readonly bytes: Uint8Array;
    readonly contentSha256: string;
}

export type ParagraphSourceResult =
    | { readonly kind: 'computed'; readonly candidate: ParagraphSourceCandidate; }
    | { readonly kind: 'manual'; readonly reasonCode: string; readonly baseNodeIdentities: readonly string[]; }
    | { readonly kind: 'rejected'; readonly reasonCode: string; };

const algorithmVersion = 'fsusblog.article-vault.paragraph-byte-computation.v1';
const policySha256 = hash(new TextEncoder().encode(JSON.stringify([
    algorithmVersion, 'canonical-public-projection', 'paragraph-only', 'same-base-node-manual',
    'raw-byte-hunks', 'unchanged-boundaries', 'html-boundary-unsupported', 'no-coordinate-admission'
])));

interface Paragraph {
    readonly id: string;
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

interface ThreeSnapshots {
    readonly base: Snapshot;
    readonly local: Snapshot;
    readonly server: Snapshot;
}

/** No plan fields, asserted verified flags, storage, writer or coordinate-admission result. */
export function computeParagraphSourceMerge(input: ParagraphSourceBytes): ParagraphSourceResult
{
    const read = readSnapshots(input);
    if (typeof read === 'string')
    {
        return { kind: 'rejected', reasonCode: read };
    }
    const local = changes(read.base, read.local, 'local');
    const server = changes(read.base, read.server, 'server');
    const overlap = local.filter(left => server.some(right => left.baseNodeIdentity === right.baseNodeIdentity));
    if (overlap.length > 0)
    {
        return {
            kind: 'manual', reasonCode: 'article_vault_source_same_base_node',
            baseNodeIdentities: overlap.map(hunk => hunk.baseNodeIdentity)
        };
    }
    const hunks = [...local, ...server].sort((left, right) => left.from - right.from);
    const bytes = apply(read.base.bytes, hunks);
    const parsed = readOne(bytes, hash(read.base.bytes));
    if (typeof parsed === 'string' || parsed.paragraphs.length !== read.base.paragraphs.length)
    {
        return { kind: 'rejected', reasonCode: 'article_vault_source_candidate_boundary_drift' };
    }
    const candidate: ParagraphSourceCandidate = {
        algorithmVersion, policySha256,
        parser: read.base.projection.identity.parser,
        parserVersion: read.base.projection.identity.version,
        baseSha256: hash(read.base.bytes), localSha256: hash(read.local.bytes), serverSha256: hash(read.server.bytes),
        hunks, bytes, contentSha256: ''
    };
    return { kind: 'computed', candidate: { ...candidate, contentSha256: paragraphSourceCandidateDigest(candidate) } };
}

/** Rereads actual bytes/parser output and checks every original paragraph decision without calling compute. */
export function verifyParagraphSourceCandidate(input: ParagraphSourceBytes, candidate: ParagraphSourceCandidate): boolean
{
    const read = readSnapshots(input);
    if (typeof read === 'string' || candidate?.algorithmVersion !== algorithmVersion
        || candidate.policySha256 !== policySha256 || candidate.parser !== read.base.projection.identity.parser
        || candidate.parserVersion !== read.base.projection.identity.version
        || candidate.baseSha256 !== hash(read.base.bytes) || candidate.localSha256 !== hash(read.local.bytes)
        || candidate.serverSha256 !== hash(read.server.bytes) || !isClosedHunkArray(candidate.hunks)
        || !(candidate.bytes instanceof Uint8Array))
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
    const parsed = readOne(bytes, hash(read.base.bytes));
    return typeof parsed !== 'string' && parsed.paragraphs.length === read.base.paragraphs.length
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

function isClosedHunkArray(value: unknown): value is readonly ParagraphSourceHunk[]
{
    return Array.isArray(value) && value.every((entry: unknown) => isClosedHunk(entry));
}

function isClosedHunk(value: unknown): value is ParagraphSourceHunk
{
    if (value === null || typeof value !== 'object')
    {
        return false;
    }
    const entry = value as Record<string, unknown>;
    const fields = ['side', 'from', 'to', 'baseNodeIdentity', 'insert'];
    const keys = Object.keys(entry);
    return keys.length === fields.length && keys.every(key => fields.includes(key))
        && (entry.side === 'local' || entry.side === 'server')
        && typeof entry.from === 'number' && Number.isSafeInteger(entry.from) && entry.from >= 0
        && typeof entry.to === 'number' && Number.isSafeInteger(entry.to) && entry.to >= entry.from
        && typeof entry.baseNodeIdentity === 'string' && entry.baseNodeIdentity.length > 0
        && entry.insert instanceof Uint8Array;
}

function readSnapshots(input: ParagraphSourceBytes): ThreeSnapshots | string
{
    if (!input || !(input.base instanceof Uint8Array) || !(input.local instanceof Uint8Array)
        || !(input.server instanceof Uint8Array))
    {
        return 'article_vault_source_three_snapshots_required';
    }
    const base = readOne(input.base, hash(input.base));
    const local = readOne(input.local, hash(input.base));
    const server = readOne(input.server, hash(input.base));
    if (typeof base === 'string')
    {
        return base;
    }
    if (typeof local === 'string')
    {
        return local;
    }
    if (typeof server === 'string')
    {
        return server;
    }
    for (const next of [local, server])
    {
        if (next.projection.identity.parser !== base.projection.identity.parser
            || next.projection.identity.version !== base.projection.identity.version)
        {
            return 'article_vault_source_parser_drift';
        }
        if (next.paragraphs.length !== base.paragraphs.length)
        {
            return 'article_vault_source_boundary_or_delete_ambiguity';
        }
        if (next.boundaries.length !== base.boundaries.length
            || next.boundaries.some((bytes, index) => !equal(bytes, base.boundaries[index])))
        {
            return 'article_vault_source_boundary_drift';
        }
        if (!equal(next.bytes.slice(0, hasBom(next.bytes) ? 3 : 0), base.bytes.slice(0, hasBom(base.bytes) ? 3 : 0)))
        {
            return 'article_vault_source_format_drift';
        }
        for (let index = 0; index < base.paragraphs.length; index++)
        {
            if (!equal(base.paragraphs[index].content, next.paragraphs[index].content)
                && base.paragraphs.some((paragraph, other) => other !== index
                    && equal(paragraph.content, next.paragraphs[index].content)))
            {
                return 'article_vault_source_move_ambiguity';
            }
        }
    }
    return { base, local, server };
}

function readOne(original: Uint8Array, documentId: string): Snapshot | string
{
    const bytes = original.slice();
    try
    {
        const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
        if (!equal(new TextEncoder().encode(raw), bytes))
        {
            return 'article_vault_source_utf8_invalid';
        }
        // A conservative eligibility restriction, not an HTML parser: the public projection does not distinguish raw HTML.
        if (bytes.includes(60) || bytes.includes(62))
        {
            return 'article_vault_source_html_boundary_unsupported';
        }
        const projection = createMarkdownEditorProjection(raw);
        if (projection.identity.rawSource !== raw || projection.diagnostics.length > 0 || projection.nodes.length === 0
            || projection.nodes.some(node => node.kind !== 'paragraph' || node.status !== 'valid'
                || node.diagnosticCode !== null || node.parentRawRange !== null || node.childRawRanges.length > 0
                || node.rawMarkerRanges.length > 0 || node.rawContentRanges.length !== 1))
        {
            return 'article_vault_source_semantic_boundary_unsupported';
        }
        const stable = stabilizeMarkdownEditorProjection(projection, { id: documentId, epoch: 1 });
        const coordinates = createMarkdownSourceCoordinateMap(raw);
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
                return 'article_vault_source_coordinate_invalid';
            }
            boundaries.push(bytes.slice(previous, from));
            paragraphs.push({ id: stable.nodes[index].id, from, to, content: bytes.slice(from, to) });
            previous = to;
        }
        boundaries.push(bytes.slice(previous));
        return { bytes, projection, paragraphs, boundaries };
    }
    catch
    {
        return 'article_vault_source_parser_or_utf8_unavailable';
    }
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
