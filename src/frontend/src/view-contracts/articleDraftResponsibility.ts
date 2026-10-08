import type { ArticleRevisionResponsibilitySnapshotResponse } from '@/api/authoring';
import { validateArticleDocumentContext, type ArticleDocumentContext } from '@/services/authoring/articleDocumentContext';
import { calculateOpenArticleDocumentDigest as digest } from '@/services/authoring/openArticleDocumentRegistry';
import type { ArticleResponsibilityPublicView } from '@/view-contracts/articleResponsibility';

export type ArticleDraftResponsibilitySource = Pick<ArticleRevisionResponsibilitySnapshotResponse,
    'inheritSiteAuthor' | 'authors' | 'reviewer' | 'sources' | 'updateSummary' | 'updateReason'
    | 'effectiveAt' | 'conclusionImpact' | 'responsiblePersonConfirmed'>;

export type ArticleDraftResponsibilitySnapshot = Readonly<{
    schema: 'fsusblog.article-draft-responsibility.v1';
    contextDigest: string;
    sourceRevision: number;
    responsibilityDigest: string;
    status: 'ready' | 'missing' | 'incomplete';
    reasons: readonly string[];
    authors: ArticleResponsibilityPublicView['authors'];
    reviewer: ArticleResponsibilityPublicView['reviewer'];
    sources: ArticleResponsibilityPublicView['sources'];
    update: ArticleResponsibilityPublicView['update'];
    snapshotDigest: string;
}>;

export type ArticleDraftResponsibilityDisclosure = Readonly<{
    context: ArticleDocumentContext;
    responsibilityDigest: string;
    snapshot: ArticleDraftResponsibilitySnapshot;
}>;

const producedSnapshots = new WeakSet<ArticleDraftResponsibilitySnapshot>();
const trim = (value: string | null | undefined): string | null => value?.trim() ? value.trim() : null;

// Display filtering mirrors ArticleResponsibilityGovernance.PublicUrl, without DNS/reachability claims.
function publicUrl(value: string | null): string | null
{
    try
    {
        const url = new URL(value?.trim() ?? '');
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hostname === 'localhost')
        {
            return null;
        }
        const host = url.hostname;
        const octets = host.split('.').map(Number);
        if (octets.length === 4 && octets.every(Number.isInteger)
            && (octets[0] === 10 || octets[0] === 127
                || (octets[0] === 169 && octets[1] === 254)
                || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
                || (octets[0] === 192 && octets[1] === 168)))
        {
            return null;
        }
        const ipv6 = host.replaceAll('[', '').replaceAll(']', '').toLowerCase();
        const prefix = Number.parseInt(ipv6.split(':')[0], 16);
        const mappedPrefix = ipv6.startsWith('::ffff:') ? Number.parseInt(ipv6.split(':').at(-2) ?? '', 16) : null;
        if (ipv6 === '::1' || (host.startsWith('[') && (prefix & 0xffc0) === 0xfe80)
            || (host.startsWith('[') && (prefix & 0xffc0) === 0xfec0)
            || (mappedPrefix !== null && mappedPrefix >>> 8 === 127))
        {
            return null;
        }
        return url.href;
    }
    catch
    {
        return null;
    }
}

/** Projects the existing authoring responsibility fields; never creates a publication/proof coordinate. */
export function createArticleDraftResponsibilitySnapshot(
    context: ArticleDocumentContext,
    source: ArticleDraftResponsibilitySource | null,
    siteAuthor: string
): ArticleDraftResponsibilitySnapshot
{
    if (!validateArticleDocumentContext(context))
    {
        throw new Error('article-draft-responsibility-context-invalid');
    }
    const reasons: string[] = [];
    const person = (value: ArticleDraftResponsibilitySource['reviewer']) =>
    {
        const name = trim(value?.name);
        return name ? Object.freeze({ name, profileUrl: publicUrl(value?.profileUrl ?? null) }) : null;
    };
    const authors = source?.authors.map(person).filter(value => value !== null).slice(0, 8) ?? [];
    if (source?.inheritSiteAuthor && authors.length === 0 && trim(siteAuthor))
    {
        authors.push(Object.freeze({ name: siteAuthor.trim(), profileUrl: null }));
    }
    if (!source)
    {
        reasons.push('responsibility-missing');
    }
    else
    {
        if (authors.length === 0 || source.authors.some(value => !trim(value.name)))
        {
            reasons.push('responsibility-author-incomplete');
        }
        if (!source.responsiblePersonConfirmed)
        {
            reasons.push('responsibility-person-unconfirmed');
        }
    }
    const sources: ArticleResponsibilityPublicView['sources'][number][] = [];
    for (const item of source?.sources ?? [])
    {
        // Shared ArticleEvidenceSource defaults IsPublic to true; explicit false remains private.
        if (item.isPublic === false)
        {
            continue;
        }
        const title = trim(item.title);
        const url = publicUrl(item.url);
        if (!title || !url)
        {
            if (!reasons.includes('responsibility-source-incomplete'))
            {
                reasons.push('responsibility-source-incomplete');
            }
            continue;
        }
        if (sources.length < 100)
        {
            sources.push(Object.freeze({ title, url, sourceType: trim(item.sourceType) ?? 'other',
                accessedOn: item.accessedOn, version: trim(item.version), citationNote: trim(item.citationNote) }));
        }
    }
    const summary = trim(source?.updateSummary);
    const reason = trim(source?.updateReason);
    const impact = trim(source?.conclusionImpact)?.toLowerCase();
    const update = summary || reason || source?.effectiveAt
        ? Object.freeze({ summary: summary ?? '未提供变更摘要', reason: reason ?? '未提供变更原因',
            conclusionImpact: impact && ['none', 'clarified', 'changed'].includes(impact) ? impact : 'unknown' })
        : null;
    const unsigned = {
        schema: 'fsusblog.article-draft-responsibility.v1' as const,
        contextDigest: context.contextDigest, sourceRevision: context.sourceRevision,
        responsibilityDigest: digest({ source, siteAuthor }),
        status: !source ? 'missing' as const : reasons.length ? 'incomplete' as const : 'ready' as const,
        reasons: Object.freeze(reasons), authors: Object.freeze(authors), reviewer: person(source?.reviewer ?? null),
        sources: Object.freeze(sources), update
    };
    const snapshot = Object.freeze({ ...unsigned, snapshotDigest: digest(unsigned) });
    producedSnapshots.add(snapshot);
    return snapshot;
}

/** Admits only an immutable producer projection bound to the caller's current document context. */
export function admitArticleDraftResponsibilitySnapshot(
    value: ArticleDraftResponsibilityDisclosure
): boolean
{
    const { context, responsibilityDigest, snapshot } = value;
    return validateArticleDocumentContext(context) && producedSnapshots.has(snapshot)
        && snapshot.contextDigest === context.contextDigest && snapshot.sourceRevision === context.sourceRevision
        && snapshot.responsibilityDigest === responsibilityDigest;
}

/** Binds a result to current responsibility input, including metadata edits that leave Markdown unchanged. */
export function bindArticleDraftResponsibilitySnapshot(
    context: ArticleDocumentContext,
    source: ArticleDraftResponsibilitySource | null,
    siteAuthor: string,
    snapshot: ArticleDraftResponsibilitySnapshot
): ArticleDraftResponsibilityDisclosure
{
    return Object.freeze({ context, responsibilityDigest: digest({ source, siteAuthor }), snapshot });
}

/** Independently compares display and private-input digests to a fresh projection from the same authority input. */
export function verifyArticleDraftResponsibilitySnapshot(
    snapshot: ArticleDraftResponsibilitySnapshot,
    context: ArticleDocumentContext,
    source: ArticleDraftResponsibilitySource | null,
    siteAuthor: string
): boolean
{
    if (!validateArticleDocumentContext(context))
    {
        return false;
    }
    const expected = createArticleDraftResponsibilitySnapshot(context, source, siteAuthor);
    return digest(snapshot) === digest(expected);
}
