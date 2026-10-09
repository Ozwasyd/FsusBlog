import type { ArticlePackageCandidateReview } from '@/api/types/articlePackageCandidateReview';

/** Reserved allocation only; the central frame/route owner has not activated this pair. */
export const articlePackageCandidateReviewReservedFrames = Object.freeze({ request: 288, response: 289 });

export interface ArticlePackageCandidateReviewContextExpectation
{
    readonly identity: string;
    readonly lifecycleVersion: number;
    readonly generation: number;
    readonly mappingRevision: number;
    readonly scopeRevision: number;
}

export interface ArticlePackageCandidateReviewRequestedTarget
{
    readonly portableArticle: string;
    readonly requestedTargetArticleId: number;
    readonly expectedTargetRevision: string;
}

/** Caller assertions only. No owner, session or approved scope can be supplied here. */
export interface ArticlePackageCandidateReviewReadRequest
{
    readonly requestId: string;
    readonly archiveBytes: string;
    readonly requestedMode: 'CreateNew' | 'UpdateRequested';
    readonly callerPolicyDigest: string;
    readonly callerPermissionContextDigest: string;
    readonly createdAtUtc: string;
    readonly expiresAtUtc: string;
    readonly requestedTargets: readonly ArticlePackageCandidateReviewRequestedTarget[] | null;
    readonly pageIndex: number;
    readonly pageSize: number;
    readonly expectedPlanDigest: string | null;
    readonly expectedContext: ArticlePackageCandidateReviewContextExpectation | null;
}

export interface ArticlePackageCandidateReviewReadResponse
{
    readonly requestId: string;
    readonly review: ArticlePackageCandidateReview;
    readonly context: ArticlePackageCandidateReviewContextExpectation;
}

const maxPayloadBytes = 1048576 - 16;
const invalidWire = 'article_package_candidate_review_wire_invalid';
const authorities = Object.freeze([
    'archive_intake', 'complete_package_schema', 'canonical_source_and_property_provenance',
    'fsusui_syntax_dependencies', 'persisted_relation_and_embed_plan', 'frozen_public_projection_retention',
    'asset_and_dependency_resolution', 'rights_responsibility_taxonomy_privacy',
    'current_actor_site_target_permissions', 'current_target_revision_and_identity', 'execution_qualification'
]);
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
type JsonObject = Record<string, unknown>;

function refuse(): never
{
    throw new Error(invalidWire);
}

/** Confined payload parser: JSON.parse alone loses duplicate keys and unsafe number spellings. */
function parseClosedPayload(payload: Uint8Array): unknown
{
    if (payload.byteLength < 1 || payload.byteLength > maxPayloadBytes)
    {
        return refuse();
    }
    let source: string;
    try
    {
        source = utf8.decode(payload);
    }
    catch
    {
        return refuse();
    }
    let offset = 0;
    let nodes = 0;
    function space(): void
    {
        while (offset < source.length && /[ \t\r\n]/u.test(source[offset]!))
        {
            offset++;
        }
    }
    function string(): string
    {
        const start = offset++;
        let escaped = false;
        while (offset < source.length)
        {
            const character = source[offset++]!;
            if (!escaped && character === '"')
            {
                let value: unknown;
                try
                {
                    value = JSON.parse(source.slice(start, offset));
                }
                catch
                {
                    return refuse();
                }
                if (typeof value !== 'string' || !validUnicode(value))
                {
                    return refuse();
                }
                return value;
            }
            if (!escaped && character.charCodeAt(0) < 32)
            {
                return refuse();
            }
            escaped = !escaped && character === '\\';
        }
        return refuse();
    }
    function value(depth: number): unknown
    {
        space();
        if (++nodes > 20000 || depth > 6)
        {
            return refuse();
        }
        const character = source[offset];
        if (character === '"')
        {
            return string();
        }
        if (character === '{' || character === '[')
        {
            const object = character === '{';
            offset++;
            const result: JsonObject | unknown[] = object ? Object.create(null) as JsonObject : [];
            const names = new Set<string>();
            space();
            const end = object ? '}' : ']';
            let count = 0;
            if (source[offset] !== end)
            {
                while (true)
                {
                    if (++count > (object ? 15 : 1000))
                    {
                        return refuse();
                    }
                    space();
                    if (object)
                    {
                        if (source[offset] !== '"')
                        {
                            return refuse();
                        }
                        const name = string();
                        space();
                        if (names.has(name) || source[offset++] !== ':')
                        {
                            return refuse();
                        }
                        names.add(name);
                        (result as JsonObject)[name] = value(depth + 1);
                    }
                    else
                    {
                        (result as unknown[]).push(value(depth + 1));
                    }
                    space();
                    if (source[offset] !== ',')
                    {
                        break;
                    }
                    offset++;
                }
            }
            if (source[offset++] !== end)
            {
                return refuse();
            }
            return result;
        }
        for (const [literal, result] of [['true', true], ['false', false], ['null', null]] as const)
        {
            if (source.startsWith(literal, offset))
            {
                offset += literal.length;
                return result;
            }
        }
        const match = /^(?:0|[1-9][0-9]*)/u.exec(source.slice(offset));
        if (!match)
        {
            return refuse();
        }
        offset += match[0].length;
        const number = Number(match[0]);
        return Number.isSafeInteger(number) ? number : refuse();
    }
    const result = value(0);
    space();
    return offset === source.length ? result : refuse();
}

function validUnicode(value: string): boolean
{
    for (let index = 0; index < value.length; index++)
    {
        const unit = value.charCodeAt(index);
        if (unit >= 0xd800 && unit <= 0xdfff)
        {
            if (unit > 0xdbff || ++index >= value.length || value.charCodeAt(index) < 0xdc00 || value.charCodeAt(index) > 0xdfff)
            {
                return false;
            }
        }
    }
    return true;
}

function closed(value: unknown, names: readonly string[]): value is JsonObject
{
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));
}

function integer(value: unknown, minimum: number, maximum: number): value is number
{
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum;
}

function digest(value: unknown): value is string
{
    return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function revision(value: unknown): value is string
{
    return typeof value === 'string' && /^[1-9][0-9]{0,18}$/u.test(value)
        && (value.length < 19 || value <= '9223372036854775807');
}

function portable(value: unknown): value is string
{
    return typeof value === 'string' && /^article:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
        && value !== 'article:00000000-0000-0000-0000-000000000000';
}

function requestId(value: unknown): value is string
{
    return typeof value === 'string' && value.length > 0 && value.length <= 128 && validUnicode(value)
        && !/^[\t\n\v\f\r \u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]*$/u.test(value);
}

function utc(value: unknown): string | null
{
    if (typeof value !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,7})?Z$/u.test(value)
        || value.slice(0, 4) === '0000')
    {
        return null;
    }
    const seconds = `${value.slice(0, 19)}Z`;
    const parsed = new Date(seconds);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== seconds.slice(0, 19))
    {
        return null;
    }
    return `${value.slice(0, 19)}.${(value.length === 20 ? '' : value.slice(20, -1)).padEnd(7, '0')}Z`;
}

function interval(value: JsonObject): boolean
{
    const created = utc(value.createdAtUtc);
    const expires = utc(value.expiresAtUtc);
    return created !== null && expires !== null && expires > created;
}

function context(value: unknown): boolean
{
    return closed(value, ['identity', 'lifecycleVersion', 'generation', 'mappingRevision', 'scopeRevision'])
        && typeof value.identity === 'string' && value.identity.startsWith('fsus-site:') && digest(value.identity.slice(10))
        && integer(value.lifecycleVersion, 1, 1) && integer(value.generation, 1, 16)
        && integer(value.mappingRevision, 1, 1024) && integer(value.scopeRevision, 1, value.mappingRevision);
}

function archive(value: unknown): boolean
{
    if (typeof value !== 'string' || value.length < 4 || value.length > 699052 || value.length % 4 !== 0)
    {
        return false;
    }
    const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    const bytes = value.length / 4 * 3 - padding;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let index = 0; index < value.length - padding; index++)
    {
        if (!alphabet.includes(value[index]!))
        {
            return false;
        }
    }
    const last = alphabet.indexOf(value[value.length - padding - 1]!);
    return bytes > 0 && bytes <= 524288 && (padding === 0 || (last & (padding === 2 ? 15 : 3)) === 0);
}

function requestShape(value: unknown): value is ArticlePackageCandidateReviewReadRequest
{
    if (!closed(value, ['requestId', 'archiveBytes', 'requestedMode', 'callerPolicyDigest', 'callerPermissionContextDigest',
        'createdAtUtc', 'expiresAtUtc', 'requestedTargets', 'pageIndex', 'pageSize', 'expectedPlanDigest', 'expectedContext'])
        || !requestId(value.requestId) || !archive(value.archiveBytes) || !['CreateNew', 'UpdateRequested'].includes(value.requestedMode as string)
        || !digest(value.callerPolicyDigest) || !digest(value.callerPermissionContextDigest) || !interval(value)
        || !integer(value.pageIndex, 0, 999) || !integer(value.pageSize, 1, 50))
    {
        return false;
    }
    if (value.expectedPlanDigest === null && value.expectedContext === null ? value.pageIndex !== 0
        : !digest(value.expectedPlanDigest) || !context(value.expectedContext))
    {
        return false;
    }
    if (value.requestedTargets === null)
    {
        return value.requestedMode === 'CreateNew';
    }
    if (!Array.isArray(value.requestedTargets) || value.requestedTargets.length > 1000)
    {
        return false;
    }
    const identities = new Set<string>();
    const ids = new Set<number>();
    for (const target of value.requestedTargets as unknown[])
    {
        if (!closed(target, ['portableArticle', 'requestedTargetArticleId', 'expectedTargetRevision']) || !portable(target.portableArticle)
            || !integer(target.requestedTargetArticleId, 1, 2147483647) || !revision(target.expectedTargetRevision)
            || identities.has(target.portableArticle) || ids.has(target.requestedTargetArticleId))
        {
            return false;
        }
        identities.add(target.portableArticle);
        ids.add(target.requestedTargetArticleId);
    }
    return value.requestedMode === 'CreateNew' ? value.requestedTargets.length === 0 : value.requestedTargets.length > 0;
}

function reviewShape(value: unknown): value is ArticlePackageCandidateReview
{
    if (!closed(value, ['candidateStatus', 'summary', 'requestedMode', 'policyDigest', 'createdAtUtc', 'expiresAtUtc', 'intervalStatus',
        'planDigest', 'pageIndex', 'pageSize', 'totalTargets', 'targets', 'requiredAuthorities', 'executeDisabled', 'executionReasonCode'])
        || value.candidateStatus !== 'finite_bytes_validated' || !['CreateNew', 'UpdateRequested'].includes(value.requestedMode as string)
        || !digest(value.policyDigest) || !digest(value.planDigest) || !interval(value)
        || !['caller_interval_not_started', 'caller_interval_current', 'caller_interval_expired'].includes(value.intervalStatus as string)
        || !integer(value.pageIndex, 0, 999) || !integer(value.pageSize, 1, 50) || !integer(value.totalTargets, 1, 1000)
        || value.executeDisabled !== true || value.executionReasonCode !== 'article_package_import_authority_unavailable')
    {
        return false;
    }
    const summary = value.summary;
    if (!closed(summary, ['articleCount', 'fileCount', 'schemaVersion', 'canonicalHashVersion', 'propertySchemaVersion',
        'packageBytesDigest', 'manifestSemanticDigest', 'checksumComponentDigest']) || !integer(summary.articleCount, 1, 1000)
        || !integer(summary.fileCount, 3, 1002) || summary.fileCount !== summary.articleCount + 2
        || summary.schemaVersion !== 1 || summary.canonicalHashVersion !== 1 || summary.propertySchemaVersion !== 1
        || !digest(summary.packageBytesDigest) || !digest(summary.manifestSemanticDigest) || !digest(summary.checksumComponentDigest)
        || value.totalTargets !== summary.articleCount)
    {
        return false;
    }
    const start = value.pageIndex * value.pageSize;
    if (start >= value.totalTargets || !Array.isArray(value.targets) || value.targets.length !== Math.min(value.pageSize, value.totalTargets - start))
    {
        return false;
    }
    const create = value.requestedMode === 'CreateNew';
    const identities = new Set<string>();
    const ids = new Set<number>();
    for (const target of value.targets as unknown[])
    {
        if (!closed(target, ['portableArticle', 'requiresNewIdentity', 'requestedTargetArticleId', 'expectedTargetRevision'])
            || !portable(target.portableArticle) || identities.has(target.portableArticle) || target.requiresNewIdentity !== create)
        {
            return false;
        }
        identities.add(target.portableArticle);
        if (create ? target.requestedTargetArticleId !== null || target.expectedTargetRevision !== null
            : !integer(target.requestedTargetArticleId, 1, 2147483647) || !revision(target.expectedTargetRevision) || ids.has(target.requestedTargetArticleId))
        {
            return false;
        }
        if (!create)
        {
            ids.add(target.requestedTargetArticleId as number);
        }
    }
    return Array.isArray(value.requiredAuthorities) && value.requiredAuthorities.length === authorities.length
        && authorities.every((authority, index) => (value.requiredAuthorities as unknown[])[index] === authority);
}

/** Encodes only the typed, closed payload; the existing AEDS helper owns framing and CRC. */
export function encodeArticlePackageCandidateReviewRequest(request: ArticlePackageCandidateReviewReadRequest): Uint8Array
{
    let payload: Uint8Array;
    try
    {
        payload = encoder.encode(JSON.stringify(request));
    }
    catch
    {
        return refuse();
    }
    return requestShape(parseClosedPayload(payload)) ? payload : refuse();
}

export function decodeArticlePackageCandidateReviewRequest(payload: Uint8Array): ArticlePackageCandidateReviewReadRequest
{
    const value = parseClosedPayload(payload);
    return requestShape(value) ? value : refuse();
}

/** Central registry hook only. Correlation still belongs to the caller holding the original read. */
export function decodeArticlePackageCandidateReviewResponse(payload: Uint8Array): ArticlePackageCandidateReviewReadResponse
{
    const value = parseClosedPayload(payload);
    if (!closed(value, ['requestId', 'review', 'context']) || !requestId(value.requestId) || !context(value.context) || !reviewShape(value.review))
    {
        return refuse();
    }
    return value as unknown as ArticlePackageCandidateReviewReadResponse;
}

/** The existing controller retains its active completion identity and owns late-response rejection. */
export function decodeCorrelatedArticlePackageCandidateReviewResponse(
    payload: Uint8Array,
    request: ArticlePackageCandidateReviewReadRequest,
    signal: AbortSignal
): ArticlePackageCandidateReviewReadResponse
{
    if (signal.aborted)
    {
        throw new Error('article_package_import_cancelled');
    }
    const checked = decodeArticlePackageCandidateReviewRequest(encodeArticlePackageCandidateReviewRequest(request));
    const response = decodeArticlePackageCandidateReviewResponse(payload);
    const review = response.review;
    const expected = checked.expectedContext;
    if (response.requestId !== checked.requestId || review.requestedMode !== checked.requestedMode
        || review.policyDigest !== checked.callerPolicyDigest || review.pageIndex !== checked.pageIndex || review.pageSize !== checked.pageSize
        || utc(review.createdAtUtc) !== utc(checked.createdAtUtc) || utc(review.expiresAtUtc) !== utc(checked.expiresAtUtc)
        || checked.expectedPlanDigest !== null && review.planDigest !== checked.expectedPlanDigest
        || expected !== null && (response.context.identity !== expected.identity || response.context.lifecycleVersion !== expected.lifecycleVersion
            || response.context.generation !== expected.generation || response.context.mappingRevision !== expected.mappingRevision
            || response.context.scopeRevision !== expected.scopeRevision)
        || checked.requestedMode === 'UpdateRequested' && (checked.requestedTargets?.length !== review.totalTargets
            || !review.targets.every(target => checked.requestedTargets?.some(hint => hint.portableArticle === target.portableArticle
                && hint.requestedTargetArticleId === target.requestedTargetArticleId && hint.expectedTargetRevision === target.expectedTargetRevision))))
    {
        return refuse();
    }
    if (signal.aborted)
    {
        throw new Error('article_package_import_cancelled');
    }
    return response;
}
