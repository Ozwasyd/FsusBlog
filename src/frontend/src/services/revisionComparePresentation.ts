import type {
    ArticleRevisionCompareResponse,
    RevisionByteRange,
    RevisionDiffHunk
} from '@/api/articleRevisionCompare';

export interface RevisionSourcePiece { text: string; changed: boolean; }
export interface RevisionSourceRow {
    id: string;
    kind: 0 | 1 | 2 | 3;
    base: RevisionSourcePiece[];
    compare: RevisionSourcePiece[];
    baseRange: RevisionByteRange;
    compareRange: RevisionByteRange;
    baseLine: number;
    compareLine: number;
    collapsed: boolean;
    headingIdentities: string[];
}

export interface RevisionSourcePresentation {
    response: ArticleRevisionCompareResponse;
    rows: RevisionSourceRow[];
    headings: { identity: string; label: string; rowId: string; }[];
    baseBytes: Uint8Array;
    compareBytes: Uint8Array;
}

export async function revisionSourceDigest(bytes: Uint8Array): Promise<string>
{
    const digest = await globalThis.crypto.subtle.digest('SHA-256', Uint8Array.from(bytes));
    return Array.from(new Uint8Array(digest), value => value.toString(16).padStart(2, '0')).join('');
}

export function readRevisionSourceRange(bytes: Uint8Array, range: RevisionByteRange): string
{
    if (!range || !Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length)
        || range.offset < 0 || range.length < 0 || range.end !== range.offset + range.length || range.end > bytes.length)
    {
        throw new Error('revision_compare_source_range_invalid');
    }
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(range.offset, range.end));
}

// Source text comes from authorized readers. Only server-provided byte ranges divide it.
export async function materializeRevisionSourcePresentation(
    response: ArticleRevisionCompareResponse, baseSource: string, compareSource: string
): Promise<RevisionSourcePresentation>
{
    const baseBytes = new TextEncoder().encode(baseSource);
    const compareBytes = new TextEncoder().encode(compareSource);
    const receipt = response.sourceDiff.receipt;
    if (baseBytes.length !== receipt.baseSourceByteCount || compareBytes.length !== receipt.compareSourceByteCount
        || baseBytes.length !== response.planReceipt.basePackageReference.sourceByteLength
        || compareBytes.length !== response.planReceipt.comparePackageReference.sourceByteLength
        || await revisionSourceDigest(baseBytes) !== receipt.baseSourceDigest
        || await revisionSourceDigest(compareBytes) !== receipt.compareSourceDigest)
    {
        throw new Error('revision_compare_source_stale');
    }
    const pieces = (bytes: Uint8Array, range: RevisionByteRange, hunk?: RevisionDiffHunk, side?: 'base' | 'compare'): RevisionSourcePiece[] =>
    {
        readRevisionSourceRange(bytes, range);
        const edits = hunk?.wordEdits.filter(edit => edit.kind !== 0).map(edit => edit[side!]).filter(edit => edit.length > 0) ?? [];
        let cursor = range.offset;
        const output: RevisionSourcePiece[] = [];
        for (const edit of edits)
        {
            if (edit.offset < cursor || edit.end > range.end)
            {
                throw new Error('revision_compare_word_range_invalid');
            }
            if (edit.offset > cursor)
            {
                output.push({ text: readRevisionSourceRange(bytes, { offset: cursor, length: edit.offset - cursor, end: edit.offset }), changed: false });
            }
            output.push({ text: readRevisionSourceRange(bytes, edit), changed: true });
            cursor = edit.end;
        }
        if (cursor < range.end)
        {
            output.push({ text: readRevisionSourceRange(bytes, { offset: cursor, length: range.end - cursor, end: range.end }), changed: false });
        }
        return output;
    };
    const rows: RevisionSourceRow[] = [];
    for (const chunk of response.sourceDiff.chunks)
    {
        for (const [index, hunk] of chunk.hunks.entries())
        {
            if (hunk.kind === 0)
            {
                const groups = response.sourceDiff.contextGroups.filter(group => group.base.offset >= hunk.base.offset
                    && group.base.end <= hunk.base.end && group.compare.offset >= hunk.compare.offset && group.compare.end <= hunk.compare.end);
                if (groups.length === 0 && hunk.base.length > 0)
                {
                    throw new Error('revision_compare_context_missing');
                }
                for (const group of groups)
                {
                    rows.push({ id: `${response.planReceipt.planDigest}:context:${group.contentDigest}`, kind: 0,
                        base: pieces(baseBytes, group.base), compare: pieces(compareBytes, group.compare),
                        baseRange: group.base, compareRange: group.compare,
                        baseLine: group.baseStartLine + 1, compareLine: group.compareStartLine + 1,
                        collapsed: group.collapsed, headingIdentities: [] });
                }
            }
            else
            {
                rows.push({ id: `${response.planReceipt.planDigest}:${chunk.contentDigest}:${index}`, kind: hunk.kind,
                    base: pieces(baseBytes, hunk.base, hunk, 'base'), compare: pieces(compareBytes, hunk.compare, hunk, 'compare'),
                    baseRange: hunk.base, compareRange: hunk.compare, baseLine: hunk.baseStartLine + 1,
                    compareLine: hunk.compareStartLine + 1, collapsed: false, headingIdentities: hunk.headingIdentities });
            }
        }
    }
    if (new Set(rows.map(row => row.id)).size !== rows.length)
    {
        throw new Error('revision_compare_range_identity_invalid');
    }
    const headings = [...response.sourceDiff.baseHeadings.map(heading => ({ heading, side: 'base' as const })),
        ...response.sourceDiff.compareHeadings.map(heading => ({ heading, side: 'compare' as const }))].map(({ heading, side }) =>
    {
        const row = rows.find(value => heading.source.offset >= value[`${side}Range`].offset
            && heading.source.offset < value[`${side}Range`].end);
        if (!row)
        {
            throw new Error('revision_compare_heading_range_invalid');
        }
        return { identity: `${side}:${heading.identityDigest}:${heading.source.offset}`, label: readRevisionSourceRange(side === 'base' ? baseBytes : compareBytes, heading.source), rowId: row.id };
    });
    return { response, rows, headings, baseBytes, compareBytes };
}
