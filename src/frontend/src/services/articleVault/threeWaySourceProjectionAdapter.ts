import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import {
    createMarkdownEditorProjection,
    createMarkdownSourceCoordinateMap,
    stabilizeMarkdownEditorProjection
} from '@ozwasyd/element-plus/markdown-runtime';


import type {
    ConflictCoordinatePresentation,
    ConflictEvidencePresentation,
    ConflictItemPresentation
} from '@/components/article-vault/conflictEvidencePresentation';
import type { ParagraphSourceBytes } from '@/services/articleVault/paragraphSourceMerge';

import type {
    MarkdownEditorProjectionResult,
    MarkdownEditorSourceRange,
    MarkdownStableProjection,
    MarkdownSyntaxIdentityChange
} from '@ozwasyd/element-plus/markdown-runtime';

/** Value projection of VaultSourceByteIdentity; never a Shared admission proof or wire authorization. */
export interface ThreeWaySourceByteReference {
    readonly sha256: string;
    readonly byteLength: number;
    readonly hasUtf8Bom: boolean;
    readonly newlineStyle: 'none' | 'lf' | 'cr-lf' | 'mixed';
    readonly trailingWhitespaceLineCount: number;
    readonly hasFinalNewline: boolean;
}

/** Retains the original coordinate's source facts, without deriving metadata or sync state. */
export interface ThreeWaySourceProjectionCoordinate extends ConflictCoordinatePresentation {
    readonly schema: string;
    readonly schemaVersion: number;
    readonly source: ThreeWaySourceByteReference | null;
}

export type ThreeWaySourceProjectionBinding = Omit<ConflictEvidencePresentation['binding'], 'coordinates'> & {
    readonly coordinates: Readonly<Record<SourceSide, ThreeWaySourceProjectionCoordinate>>;
};

/**
 * Pure inputs supplied by the original owner. Equality with currentInput is value consistency only:
 * the host still owns currentness/admission and the real verified-input transport.
 */
export interface ThreeWaySourceProjectionInput {
    readonly bytes: ParagraphSourceBytes;
    readonly binding: ThreeWaySourceProjectionBinding;
    readonly currentInput: ThreeWaySourceProjectionBinding;
    readonly sourceDisposition: Pick<ConflictItemPresentation, 'type' | 'disposition'>;
    readonly expectedRuntime: { readonly parser: string; readonly parserVersion: string; };
}

type SourceSide = 'base' | 'local' | 'server';
type ChangedSide = Exclude<SourceSide, 'base'>;

export interface SourceProjectionRange {
    readonly from: number;
    readonly to: number;
}

/** Canonical parser/identity refs only; no text, labels, paths or reconstructed AST. */
export interface SourceProjectionNodeReference {
    readonly source: SourceSide;
    readonly sourceSha256: string;
    readonly nodeIdentity: string;
    readonly blockIdentity: string;
    readonly kind: string;
    readonly status: string;
    readonly diagnosticCode: string | null;
    readonly rawUtf16Range: SourceProjectionRange;
    readonly rawByteRange: SourceProjectionRange;
    readonly contentByteRanges: readonly SourceProjectionRange[];
    readonly markerByteRanges: readonly SourceProjectionRange[];
    readonly parentByteRange: SourceProjectionRange | null;
    readonly childByteRanges: readonly SourceProjectionRange[];
    readonly table: {
        readonly rows: readonly {
            readonly rawByteRange: SourceProjectionRange;
            readonly cellByteRanges: readonly SourceProjectionRange[];
        }[];
        readonly separatorRow: number;
        readonly alignments: readonly string[];
    } | null;
}

/** One exact replacement envelope per side. It is conservative, not a paragraph merge hunk. */
export interface SourceProjectionChangeReference {
    readonly side: ChangedSide;
    readonly baseByteRange: SourceProjectionRange;
    readonly nextByteRange: SourceProjectionRange;
    readonly baseSliceSha256: string;
    readonly nextSliceSha256: string;
    readonly baseNodeIdentities: readonly string[];
    readonly nextNodeIdentities: readonly string[];
}

export interface ThreeWaySourceProjectionDiagnostic {
    readonly code: string;
    readonly refs: readonly SourceProjectionNodeReference[];
    readonly changes: readonly ChangedSide[];
    readonly ranges?: readonly {
        readonly source: SourceSide;
        readonly sourceSha256: string;
        readonly rawByteRange: SourceProjectionRange;
    }[];
}

export interface ThreeWaySourceProjectionIdentity {
    readonly algorithmVersion: string;
    readonly algorithmSha256: string;
    readonly policySha256: string;
    readonly parser: string | null;
    readonly parserVersion: string | null;
    readonly parserContractSha256: string | null;
    readonly syntaxCoverageSha256: string | null;
    readonly bindingSha256: string | null;
    readonly sourceDisposition: readonly string[];
    readonly inputs: readonly {
        readonly side: SourceSide;
        readonly coordinateSha256: string;
        readonly source: ThreeWaySourceByteReference;
    }[];
}

/** Non-admitting diagnostic candidate. Even projected does not grant automatic merge or execution. */
export interface ThreeWaySourceProjectionResult {
    readonly kind: 'projected' | 'manual' | 'rejected';
    readonly identity: ThreeWaySourceProjectionIdentity;
    readonly projections: readonly SourceProjectionNodeReference[];
    readonly changes: readonly SourceProjectionChangeReference[];
    readonly diagnostics: readonly ThreeWaySourceProjectionDiagnostic[];
    readonly contentSha256: string;
}

const algorithmVersion = 'fsusblog.article-vault.three-way-source-projection.v1';
// Digests identify the algorithm and public parser contract, not a binary custody proof.
const algorithmSha256 = digestValue([
    algorithmVersion, 'copy-three-byte-snapshots', 'validate-shared-value-seals', 'canonical-projection',
    'canonical-stabilization-from-common-base', 'scalar-safe-raw-envelope', 'range-and-semantic-overlap',
    'diagnose-without-retargeting', 'closed-fresh-projection-verification'
]);
const maxSnapshotBytes = 131072;
const maxNodes = 256;
const sides: readonly SourceSide[] = ['base', 'local', 'server'];
const policySha256 = digestValue([
    algorithmVersion, maxSnapshotBytes, maxNodes, 'canonical-public-parser-and-identities',
    'raw-utf8-exact-envelope', 'same-semantic-boundary-manual', 'no-new-id-correspondence',
    'moved-or-repeated-syntax-manual', 'non-paragraph-edit-manual', 'unrepresented-bytes-manual',
    'value-consistency-without-admission', 'no-candidate-bytes-or-writes'
]);

interface Snapshot {
    readonly bytes: Uint8Array;
    readonly raw: string;
    readonly projection: MarkdownEditorProjectionResult;
    readonly coordinates: ReturnType<typeof createMarkdownSourceCoordinateMap>;
    readonly stable: MarkdownStableProjection;
    readonly refs: readonly SourceProjectionNodeReference[];
}

interface Change {
    readonly transaction: MarkdownSyntaxIdentityChange;
    readonly ref: SourceProjectionChangeReference;
}

/** Copies all three original byte snapshots, validates refs and projects through the public runtime. */
export function projectThreeWaySource(input: ThreeWaySourceProjectionInput): ThreeWaySourceProjectionResult
{
    return recompute(input);
}

/** Fresh bytes, ranges, canonical nodes and identities are recomputed; no supplied result is reused. */
export function verifyThreeWaySourceProjection(
    input: ThreeWaySourceProjectionInput,
    supplied: unknown
): boolean
{
    try
    {
        const fresh = recompute(input);
        return fresh.identity.bindingSha256 !== null && closedEqual(supplied, fresh);
    }
    catch
    {
        return false;
    }
}

function recompute(input: ThreeWaySourceProjectionInput): ThreeWaySourceProjectionResult
{
    let identity: ThreeWaySourceProjectionIdentity = {
        algorithmVersion, algorithmSha256, policySha256, parser: null, parserVersion: null, parserContractSha256: null,
        syntaxCoverageSha256: null, bindingSha256: null, sourceDisposition: [], inputs: []
    };
    let refs: readonly SourceProjectionNodeReference[] = [];
    try
    {
        if (!input?.bytes || sides.some(side => !(input.bytes[side] instanceof Uint8Array)))
        {
            return reject(identity, 'three_snapshots_required');
        }
        if (sides.some(side => input.bytes[side].byteLength > maxSnapshotBytes))
        {
            return reject(identity, 'snapshot_budget_exceeded');
        }
        const bytes = { base: input.bytes.base.slice(), local: input.bytes.local.slice(), server: input.bytes.server.slice() };
        const binding = bindingValues(input.binding);
        const current = bindingValues(input.currentInput);
        if (!binding || !current || !closedEqual(binding, current))
        {
            return reject(identity, 'identity_or_coordinate_drift');
        }
        const disposition = input.sourceDisposition;
        if (!disposition || !['source-disjoint', 'source-overlap'].includes(disposition.type)
            || !['automatic', 'manual', 'rejected'].includes(disposition.disposition)
            || (disposition.type === 'source-overlap' && disposition.disposition === 'automatic'))
        {
            return reject(identity, 'source_disposition_invalid');
        }
        const inputs: ThreeWaySourceProjectionIdentity['inputs'][number][] = [];
        for (const side of sides)
        {
            const coordinate = input.binding.coordinates[side];
            const source = sourceFacts(bytes[side]);
            if (!coordinate.source || !closedEqual(coordinate.source, source))
            {
                return reject(identity, 'source_reference_mismatch');
            }
            inputs.push({ side, coordinateSha256: coordinate.contentSha256, source });
        }
        identity = {
            ...identity, bindingSha256: digestValue(binding), inputs,
            sourceDisposition: [disposition.type, disposition.disposition]
        };
        // Scope the canonical document identity to the original portable identity and base coordinate.
        const document = {
            id: digestValue([input.binding.portableArticleIdentity, inputs[0].coordinateSha256]), epoch: 1
        };
        const base = snapshot(bytes.base, 'base', document);
        const local = snapshot(bytes.local, 'local', document, base);
        const server = snapshot(bytes.server, 'server', document, base);
        const snapshots = { base, local, server };
        refs = sides.flatMap(side => snapshots[side].refs);
        identity = {
            ...identity, parser: base.projection.identity.parser, parserVersion: base.projection.identity.version,
            syntaxCoverageSha256: digestValue(base.projection.syntaxCoverage),
            parserContractSha256: digestValue([
                base.projection.identity.parser, base.projection.identity.version, base.projection.syntaxCoverage
            ])
        };
        if (sides.some(side => snapshots[side].projection.identity.parser !== identity.parser
            || snapshots[side].projection.identity.version !== identity.parserVersion
            || digestValue(snapshots[side].projection.syntaxCoverage) !== identity.syntaxCoverageSha256)
            || input.expectedRuntime?.parser !== identity.parser
            || input.expectedRuntime.parserVersion !== identity.parserVersion)
        {
            return reject(identity, 'parser_or_version_drift', refs);
        }
        const malformed = refs.filter(ref => ref.status !== 'valid' || ref.diagnosticCode !== null);
        if (malformed.length > 0 || sides.some(side => snapshots[side].projection.diagnostics.length > 0))
        {
            return reject(identity, 'malformed_source', malformed.length ? malformed : refs);
        }
        const diagnostics: ThreeWaySourceProjectionDiagnostic[] = [];
        for (const side of sides)
        {
            const source = snapshots[side];
            const gaps = uncoveredRanges(source);
            if (gaps.length > 0)
            {
                diagnostics.push({ code: 'unsupported_source_coverage', refs: [], changes: [],
                    ranges: gaps.map(rawByteRange => ({ source: side, sourceSha256: hash(source.bytes), rawByteRange })) });
            }
            if (source.bytes.includes(60) || source.bytes.includes(62))
            {
                diagnostics.push({ code: 'html_or_angle_boundary_unsupported', refs: source.refs, changes: [] });
            }
        }
        const localChange = change(base, local, 'local');
        const serverChange = change(base, server, 'server');
        const changes = [localChange, serverChange].filter((entry): entry is Change => entry !== null);
        for (const entry of changes)
        {
            diagnoseSide(base, snapshots[entry.ref.side], entry, diagnostics);
        }
        if (localChange && serverChange)
        {
            const common = base.refs.filter(ref => localChange.ref.baseNodeIdentities.includes(ref.nodeIdentity)
                && serverChange.ref.baseNodeIdentities.includes(ref.nodeIdentity));
            if (intersects(localChange.ref.baseByteRange, serverChange.ref.baseByteRange))
            {
                diagnostics.push({ code: 'byte_range_overlap', refs: common, changes: ['local', 'server'] });
            }
            if (common.length > 0)
            {
                diagnostics.push({ code: 'semantic_boundary_overlap', refs: common, changes: ['local', 'server'] });
                if (common.some(ref => fullyDeleted(ref, localChange, local) || fullyDeleted(ref, serverChange, server)))
                {
                    diagnostics.push({ code: 'delete_vs_edit', refs: common, changes: ['local', 'server'] });
                }
            }
        }
        if (disposition.disposition !== 'automatic' || disposition.type === 'source-overlap')
        {
            diagnostics.push({ code: 'upstream_source_disposition', refs: [], changes: [] });
        }
        return seal({
            kind: disposition.disposition === 'rejected' ? 'rejected' : diagnostics.length ? 'manual' : 'projected',
            identity, projections: refs, changes: changes.map(entry => entry.ref), diagnostics
        });
    }
    catch
    {
        // Exception messages may contain source; they never enter the result or telemetry.
        return reject(identity, 'parser_utf8_coordinate_or_budget_unavailable', refs);
    }
}

function snapshot(
    bytes: Uint8Array,
    side: SourceSide,
    document: { readonly id: string; readonly epoch: number; },
    previous?: Snapshot
): Snapshot
{
    const raw = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    if (!equalBytes(new TextEncoder().encode(raw), bytes))
    {
        throw new Error('utf8_roundtrip');
    }
    const projection = createMarkdownEditorProjection(raw);
    const coordinates = createMarkdownSourceCoordinateMap(raw);
    if (projection.identity.rawSource !== raw || coordinates.rawSource !== raw
        || projection.identity.normalizedSource !== coordinates.normalizedSource
        || projection.syntaxCoverage.parser !== projection.identity.parser
        || projection.syntaxCoverage.version !== projection.identity.version
        || projection.nodes.length > maxNodes
        || projection.nodes.some(node => !new Set<string>(projection.syntaxCoverage.kinds).has(node.kind)
            || !['valid', 'malformed'].includes(node.status)))
    {
        throw new Error('projection_contract');
    }
    const stable = stabilizeMarkdownEditorProjection(projection, document, previous?.stable,
        previous ? transaction(previous.raw, raw) : undefined);
    if (stable.nodes.length !== projection.nodes.length)
    {
        throw new Error('identity_contract');
    }
    const sourceSha256 = hash(bytes);
    const refs = stable.nodes.map(node => ({
        source: side, sourceSha256, nodeIdentity: node.id, blockIdentity: node.blockIdentity,
        kind: node.kind, status: node.status, diagnosticCode: node.diagnosticCode,
        rawUtf16Range: { from: node.rawRange.start, to: node.rawRange.end },
        rawByteRange: byteRange(coordinates, node.rawRange),
        contentByteRanges: node.rawContentRanges.map(range => byteRange(coordinates, range)),
        markerByteRanges: node.rawMarkerRanges.map(range => byteRange(coordinates, range)),
        parentByteRange: node.parentRawRange === null ? null : byteRange(coordinates, node.parentRawRange),
        childByteRanges: node.childRawRanges.map(range => byteRange(coordinates, range)),
        table: node.table ? {
            rows: node.table.rows.map(row => ({ rawByteRange: byteRange(coordinates, row.rawRange),
                cellByteRanges: row.rawCellRanges.map(range => byteRange(coordinates, range)) })),
            separatorRow: node.table.separatorRow, alignments: [...node.table.alignments]
        } : null
    }));
    if (new Set(refs.map(ref => ref.nodeIdentity)).size !== refs.length)
    {
        throw new Error('identity_duplicate');
    }
    for (const diagnostic of projection.diagnostics)
    {
        byteRange(coordinates, diagnostic.rawRange);
    }
    return { bytes, raw, projection, coordinates, stable, refs };
}

function byteRange(
    coordinates: ReturnType<typeof createMarkdownSourceCoordinateMap>,
    range: MarkdownEditorSourceRange
): SourceProjectionRange
{
    const from = coordinates.toRawUtf8Offset(range.start);
    const to = coordinates.toRawUtf8Offset(range.end);
    if (to < from || coordinates.toRawOffsetFromUtf8(from) !== range.start
        || coordinates.toRawOffsetFromUtf8(to) !== range.end)
    {
        throw new Error('coordinate_roundtrip');
    }
    return { from, to };
}

// Raw scalar-safe envelope only. No syntax parser, node matching, similarity or merge computation.
function transaction(base: string, next: string): MarkdownSyntaxIdentityChange | undefined
{
    if (base === next)
    {
        return undefined;
    }
    let from = 0;
    while (from < base.length && from < next.length && base[from] === next[from])
    {
        from++;
    }
    if (splitsSurrogate(base, from) || splitsSurrogate(next, from))
    {
        from--;
    }
    let to = base.length;
    let nextTo = next.length;
    while (to > from && nextTo > from && base[to - 1] === next[nextTo - 1])
    {
        to--;
        nextTo--;
    }
    if (splitsSurrogate(base, to) || splitsSurrogate(next, nextTo))
    {
        to++;
        nextTo++;
    }
    return { from, to, insert: next.slice(from, nextTo) };
}

function splitsSurrogate(raw: string, offset: number): boolean
{
    return offset > 0 && offset < raw.length && raw.charCodeAt(offset - 1) >= 0xd800
        && raw.charCodeAt(offset - 1) <= 0xdbff && raw.charCodeAt(offset) >= 0xdc00 && raw.charCodeAt(offset) <= 0xdfff;
}

function change(base: Snapshot, next: Snapshot, side: ChangedSide): Change | null
{
    const edit = transaction(base.raw, next.raw);
    if (!edit)
    {
        return null;
    }
    const baseByteRange = byteRange(base.coordinates, { start: edit.from, end: edit.to });
    const nextByteRange = byteRange(next.coordinates, { start: edit.from, end: edit.from + edit.insert.length });
    return {
        transaction: edit,
        ref: {
            side, baseByteRange, nextByteRange,
            baseSliceSha256: hash(base.bytes.slice(baseByteRange.from, baseByteRange.to)),
            nextSliceSha256: hash(next.bytes.slice(nextByteRange.from, nextByteRange.to)),
            baseNodeIdentities: base.refs.filter(ref => touches(ref.rawByteRange, baseByteRange)).map(ref => ref.nodeIdentity),
            nextNodeIdentities: next.refs.filter(ref => touches(ref.rawByteRange, nextByteRange)).map(ref => ref.nodeIdentity)
        }
    };
}

function diagnoseSide(
    base: Snapshot,
    next: Snapshot,
    change: Change,
    diagnostics: ThreeWaySourceProjectionDiagnostic[]
): void
{
    const touched = base.refs.filter(ref => change.ref.baseNodeIdentities.includes(ref.nodeIdentity));
    const nextTouched = next.refs.filter(ref => change.ref.nextNodeIdentities.includes(ref.nodeIdentity));
    const add = (code: string, refs: readonly SourceProjectionNodeReference[]) =>
    {
        diagnostics.push({ code, refs, changes: [change.ref.side] });
    };
    if (touched.length === 0 || nextTouched.length === 0)
    {
        add('unrepresented_or_deleted_boundary', [...touched, ...nextTouched]);
    }
    if ([...touched, ...nextTouched].some(ref => ref.kind !== 'paragraph' || ref.parentByteRange !== null
        || ref.childByteRanges.length > 0 || ref.markerByteRanges.length > 0 || ref.contentByteRanges.length !== 1))
    {
        add('structural_change_manual', [...touched, ...nextTouched]);
    }
    if (touched.some(ref => !contains(ref.contentByteRanges[0], change.ref.baseByteRange))
        || nextTouched.some(ref => !contains(ref.contentByteRanges[0], change.ref.nextByteRange)))
    {
        add('semantic_boundary_change', [...touched, ...nextTouched]);
    }
    const newNodes = nextTouched.filter(ref => !base.refs.some(original => original.nodeIdentity === ref.nodeIdentity));
    const absent = touched.filter(ref => next.stable.resolve(ref.nodeIdentity).status !== 'current');
    if (newNodes.length > 0 || absent.length > 0)
    {
        add('correspondence_ambiguous', [...absent, ...newNodes]);
    }
    for (const original of base.refs)
    {
        const retained = next.refs.find(ref => ref.nodeIdentity === original.nodeIdentity);
        if (!retained)
        {
            continue;
        }
        const expected = remapRange(original.rawUtf16Range, change.transaction);
        const originalBytes = base.bytes.slice(original.rawByteRange.from, original.rawByteRange.to);
        const nextBytes = next.bytes.slice(retained.rawByteRange.from, retained.rawByteRange.to);
        if (expected && (!sameRange(expected, retained.rawUtf16Range) || !equalBytes(originalBytes, nextBytes)))
        {
            add('movement_or_identity_ambiguous', [original, retained]);
        }
        else if (!expected && equalBytes(originalBytes, nextBytes)
            && !sameRange(original.rawUtf16Range, retained.rawUtf16Range))
        {
            add('movement_or_identity_ambiguous', [original, retained]);
        }
    }
    // Repeated exact syntax inside the edited envelope cannot establish unique correspondence.
    for (const original of touched)
    {
        const content = base.bytes.slice(original.rawByteRange.from, original.rawByteRange.to);
        if (base.refs.some(other => other.nodeIdentity !== original.nodeIdentity && other.kind === original.kind
            && equalBytes(content, base.bytes.slice(other.rawByteRange.from, other.rawByteRange.to))))
        {
            add('repeated_syntax_ambiguous', [original]);
        }
    }
    if (!unchangedOutsideContent(base, next, change))
    {
        add('unrepresented_source_change', [...touched, ...nextTouched]);
    }
}

// Validate parser coverage; gaps may contain whitespace/BOM only. This does not classify syntax.
function uncoveredRanges(snapshot: Snapshot): SourceProjectionRange[]
{
    const ranges = snapshot.refs.map(ref => ref.rawByteRange).sort((left, right) => left.from - right.from);
    const gaps: SourceProjectionRange[] = [];
    let end = 0;
    for (const range of [...ranges, { from: snapshot.bytes.length, to: snapshot.bytes.length }])
    {
        if (range.from > end)
        {
            const start = end === 0 && snapshot.bytes[0] === 239 && snapshot.bytes[1] === 187
                && snapshot.bytes[2] === 191 ? 3 : end;
            if (snapshot.bytes.slice(start, range.from).some(byte => ![9, 10, 13, 32].includes(byte)))
            {
                gaps.push({ from: start, to: range.from });
            }
        }
        end = Math.max(end, range.to);
    }
    return gaps;
}

function unchangedOutsideContent(base: Snapshot, next: Snapshot, change: Change): boolean
{
    const original = base.refs.filter(ref => change.ref.baseNodeIdentities.includes(ref.nodeIdentity));
    const updated = next.refs.filter(ref => change.ref.nextNodeIdentities.includes(ref.nodeIdentity));
    return original.length === 1 && updated.length === 1
        && original[0].nodeIdentity === updated[0].nodeIdentity
        && original[0].kind === 'paragraph' && updated[0].kind === 'paragraph'
        && contains(original[0].contentByteRanges[0], change.ref.baseByteRange)
        && contains(updated[0].contentByteRanges[0], change.ref.nextByteRange);
}

function remapRange(range: SourceProjectionRange, change: MarkdownSyntaxIdentityChange): SourceProjectionRange | null
{
    if (range.to <= change.from)
    {
        return range;
    }
    if (range.from >= change.to)
    {
        const delta = change.insert.length - (change.to - change.from);
        return { from: range.from + delta, to: range.to + delta };
    }
    return null;
}

function intersects(left: SourceProjectionRange, right: SourceProjectionRange): boolean
{
    if (left.from === left.to || right.from === right.to)
    {
        return touches(left, right);
    }
    return left.from < right.to && right.from < left.to;
}

function touches(node: SourceProjectionRange, change: SourceProjectionRange): boolean
{
    // Insertions at a syntax endpoint may alter either neighboring boundary; include both.
    if (change.from === change.to)
    {
        return node.from <= change.from && change.from <= node.to;
    }
    return node.from < change.to && change.from < node.to;
}

function contains(outer: SourceProjectionRange | undefined, inner: SourceProjectionRange): boolean
{
    return !!outer && outer.from <= inner.from && inner.to <= outer.to;
}

function fullyDeleted(ref: SourceProjectionNodeReference, change: Change, next: Snapshot): boolean
{
    return change.ref.nextByteRange.from === change.ref.nextByteRange.to
        && (contains(change.ref.baseByteRange, ref.rawByteRange)
            || (next.stable.resolve(ref.nodeIdentity).status === 'deleted' && ref.contentByteRanges.length > 0
                && ref.contentByteRanges.every(range => contains(change.ref.baseByteRange, range))));
}

function sameRange(left: SourceProjectionRange, right: SourceProjectionRange): boolean
{
    return left.from === right.from && left.to === right.to;
}

function bindingValues(binding: ThreeWaySourceProjectionBinding): readonly unknown[] | null
{
    if (!binding || !isIdentity(binding.portableArticleIdentity) || !isIdentity(binding.operationIdentity)
        || !isDigest(binding.planSha256) || !binding.coordinates)
    {
        return null;
    }
    const coordinates: unknown[] = [];
    for (const side of sides)
    {
        const c = binding.coordinates[side];
        if (!c?.source || c.schema !== 'fsusblog.article-vault.coordinate.v1' || c.schemaVersion !== 1 || c.present !== true || c.deleted !== false || !isDigest(c.contentSha256)
            || !isDigest(c.source.sha256) || !Number.isSafeInteger(c.source.byteLength) || c.source.byteLength < 0
            || !Number.isSafeInteger(c.source.trailingWhitespaceLineCount) || c.source.trailingWhitespaceLineCount < 0
            || !['none', 'lf', 'cr-lf', 'mixed'].includes(c.source.newlineStyle)
            || typeof c.source.hasUtf8Bom !== 'boolean' || typeof c.source.hasFinalNewline !== 'boolean'
            || (c.source.newlineStyle === 'none' && (c.source.hasFinalNewline || c.source.trailingWhitespaceLineCount > 0))
            || (side !== 'local' && c.serverRevision === null)
            || (c.serverRevision !== null && (!Number.isSafeInteger(c.serverRevision) || c.serverRevision <= 0))
            || !isDigest(c.metadataManifestSha256) || !isDigest(c.dependencySha256) || !isDigest(c.permissionSha256)
            || !['draft', 'scheduled', 'published', 'archived', 'deleted'].includes(c.lifecycle ?? '')
            || c.contentSha256 !== digestValue(coordinateValue(c)))
        {
            return null;
        }
        coordinates.push([
            side, c.schema, c.schemaVersion, c.present, c.deleted, c.serverRevision, c.contentSha256,
            c.metadataManifestSha256, c.dependencySha256, c.permissionSha256, c.lifecycle,
            c.source.sha256, c.source.byteLength, c.source.hasUtf8Bom, c.source.newlineStyle,
            c.source.trailingWhitespaceLineCount, c.source.hasFinalNewline
        ]);
    }
    return [binding.portableArticleIdentity, binding.operationIdentity, binding.planSha256, coordinates];
}

// All accepted coordinate fields are ASCII vocabulary, digests, booleans or safe integers.
// Original Shared declaration order and its empty contentSha256 seal are retained verbatim.
function coordinateValue(c: ThreeWaySourceProjectionCoordinate): unknown
{
    const source = c.source;
    return {
        schema: c.schema, schemaVersion: c.schemaVersion, present: c.present, deleted: c.deleted,
        serverRevision: c.serverRevision,
        source: source === null ? null : {
            sha256: source.sha256, byteLength: source.byteLength, hasUtf8Bom: source.hasUtf8Bom,
            newlineStyle: source.newlineStyle, trailingWhitespaceLineCount: source.trailingWhitespaceLineCount,
            hasFinalNewline: source.hasFinalNewline
        },
        metadataManifestSha256: c.metadataManifestSha256, dependencySha256: c.dependencySha256,
        lifecycle: c.lifecycle, permissionSha256: c.permissionSha256, contentSha256: ''
    };
}

// Byte facts follow CaptureSourceBytes, including lone CR => mixed and space/tab line endings.
function sourceFacts(bytes: Uint8Array): ThreeWaySourceByteReference
{
    const hasUtf8Bom = bytes[0] === 239 && bytes[1] === 187 && bytes[2] === 191;
    let lf = false;
    let crLf = false;
    let loneCr = false;
    let trailingWhitespaceLineCount = 0;
    let start = hasUtf8Bom ? 3 : 0;
    for (let index = start; index < bytes.length; index++)
    {
        if (bytes[index] !== 10 && bytes[index] !== 13)
        {
            continue;
        }
        if (index > start && (bytes[index - 1] === 32 || bytes[index - 1] === 9))
        {
            trailingWhitespaceLineCount++;
        }
        if (bytes[index] === 13)
        {
            if (bytes[index + 1] === 10)
            {
                crLf = true;
                index++;
            }
            else
            {
                loneCr = true;
            }
        }
        else
        {
            lf = true;
        }
        start = index + 1;
    }
    if (start < bytes.length && (bytes[bytes.length - 1] === 32 || bytes[bytes.length - 1] === 9))
    {
        trailingWhitespaceLineCount++;
    }
    return {
        sha256: hash(bytes), byteLength: bytes.length, hasUtf8Bom,
        newlineStyle: !lf && !crLf && !loneCr ? 'none' : lf && !crLf && !loneCr ? 'lf' : crLf && !lf && !loneCr ? 'cr-lf' : 'mixed',
        trailingWhitespaceLineCount,
        hasFinalNewline: bytes.length > (hasUtf8Bom ? 3 : 0) && (bytes[bytes.length - 1] === 10 || bytes[bytes.length - 1] === 13)
    };
}

function isIdentity(value: string): boolean
{
    return typeof value === 'string' && value.length >= 3 && value.length <= 128 && !/[\s\0/\\]/u.test(value);
}

function isDigest(value: unknown): value is string
{
    return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function reject(
    identity: ThreeWaySourceProjectionIdentity,
    reason: string,
    refs: readonly SourceProjectionNodeReference[] = []
): ThreeWaySourceProjectionResult
{
    return seal({ kind: 'rejected', identity, projections: refs, changes: [],
        diagnostics: [{ code: reason, refs, changes: [] }] });
}

function seal(value: Omit<ThreeWaySourceProjectionResult, 'contentSha256'>): ThreeWaySourceProjectionResult
{
    return { ...value, contentSha256: digestValue(value) };
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean
{
    return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Inspect only own data descriptors. Candidate getters, extra fields and hidden context fail closed.
function closedEqual(value: unknown, expected: unknown): boolean
{
    if (expected === null || typeof expected !== 'object')
    {
        return value === expected;
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value) !== Array.isArray(expected))
    {
        return false;
    }
    if (Object.getPrototypeOf(value) !== (Array.isArray(expected) ? Array.prototype : Object.prototype))
    {
        return false;
    }
    const keys = Reflect.ownKeys(expected);
    const actualKeys = Reflect.ownKeys(value);
    if (keys.length !== actualKeys.length || actualKeys.some(key => !keys.includes(key)))
    {
        return false;
    }
    return keys.every(key =>
    {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !!descriptor && Object.hasOwn(descriptor, 'value')
            && closedEqual(descriptor.value, Object.getOwnPropertyDescriptor(expected, key)?.value);
    });
}

function digestValue(value: unknown): string
{
    return hash(new TextEncoder().encode(JSON.stringify(value)));
}

function hash(bytes: Uint8Array): string
{
    return bytesToHex(sha256(bytes));
}
