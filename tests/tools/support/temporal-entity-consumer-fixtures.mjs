const { defaultTimeoutPolicyDigest, digestCanonical, qualificationTemporalContext } = await import(new URL('../../../tools/test/temporal-context.mjs', import.meta.url));
const { resolveTemporalRolesForProducer } = await import(new URL('../../../tools/test/temporal-role-resolver.mjs', import.meta.url));

const planDigest = `sha256:${'c'.repeat(64)}`;

export function consumerContext(producerId = 'development-demo')
{
    return qualificationTemporalContext({ sourceCommit: 'a'.repeat(40), sourceFingerprint: `sha256:${'b'.repeat(64)}`,
        producerId, schedulerRunId: 'entity-consumer-control', businessEpochUtc: '2026-06-04T00:00:00.000Z',
        locale: 'en-US', uiLocale: 'en-US', timeoutPolicyDigest: defaultTimeoutPolicyDigest() });
}

/** Isolated ordinary input control, never a repaired demo seed or runtime observation. */
export function consumerEntityPlan(producerId = 'development-demo')
{
    const instant = (instantUtc) => ({ applicability: 'instant', instantUtc });
    const absent = (applicability) => ({ applicability, instantUtc: null });
    const coordinate = (entityKind, semanticIdentity, ordinal, articleIdentity = null) => ({ entityKind,
        semanticIdentity, operationIdentity: 'created', ordinal, revisionNumber: null, publicationNumber: null,
        publicationRevisionNumber: null, articleIdentity });
    const article = { coordinate: { ...coordinate('article', 'control-published', 1), revisionNumber: 1,
        publicationNumber: 1, publicationRevisionNumber: 1 }, state: 'published',
    stateFacts: { hasRevision: true, hasPublication: true }, facts: {
        'article.created': instant('2026-06-01T09:00:00.000Z'), 'article.revision': instant('2026-06-01T10:00:00.000Z'),
        'article.metadata-updated': instant('2026-06-01T10:00:00.000Z'),
        'article.publication': instant('2026-06-01T10:00:00.000Z'), 'article.published': instant('2026-06-01T10:00:00.000Z') } };
    const scheduled = { coordinate: coordinate('article', 'control-scheduled', 2), state: 'scheduled',
        stateFacts: { hasRevision: false, hasPublication: false }, facts: {
            'article.created': instant('2026-06-01T09:00:00.000Z'), 'article.revision': absent('not-generated'),
            'article.metadata-updated': instant('2026-06-01T09:00:00.000Z'),
            'article.publication': absent('not-generated'), 'article.published': absent('null') } };
    const scale = producerId === 'scale-data';
    const comments = [
        { coordinate: { ...coordinate('comment', 'approved', 1, 'control-published'), revisionNumber: scale ? null : 1 },
            state: 'approved', stateFacts: { hasRevision: !scale, hasEditTime: false, hasModerationTime: !scale }, facts: {
                'comment.created': instant('2026-06-01T11:00:00.000Z'), 'comment.edited': absent('null'),
                'comment.moderated': scale ? absent('null') : instant('2026-06-01T11:05:00.000Z') } },
        { coordinate: { ...coordinate('comment', 'pending', 2, 'control-published'), revisionNumber: scale ? null : 1 },
            state: scale ? 'approved' : 'pending', stateFacts: { hasRevision: !scale, hasEditTime: false, hasModerationTime: false },
            facts: { 'comment.created': instant('2026-06-02T11:00:00.000Z'),
                'comment.edited': absent('null'), 'comment.moderated': absent('null') } }
    ];
    const audits = scale ? [] : [
        { coordinate: coordinate('audit', 'audit-security', 1), state: 'recorded', stateFacts: {},
            facts: { 'audit.occurred': instant('2026-06-01T12:00:00.000Z') } },
        { coordinate: coordinate('audit', 'audit-moderation', 2), state: 'recorded', stateFacts: {},
            facts: { 'audit.occurred': instant('2026-06-02T12:00:00.000Z') } }
    ];
    return { schema: 'fsusblog.temporal-entity-plan.v1', sourcePlanDigest: planDigest,
        distribution: { kind: scale ? 'scale' : 'demo', tier: scale ? 'scale-s' : null, ordinalBase: 1,
            counts: { article: 2, comment: 2, audit: audits.length }, stateCounts: {
                article: { draft: 0, scheduled: 1, published: 1, archived: 0, deleted: 0 },
                comment: { approved: scale ? 2 : 1, pending: scale ? 0 : 1, rejected: 0, deleted: 0 },
                audit: { recorded: audits.length } }, rootNested: comments.map((comment) => ({
                commentIdentity: comment.coordinate.semanticIdentity, parentIdentity: null, rootIdentity: null })) },
        entities: [article, scheduled, ...comments, ...audits] };
}

export function consumerInput(producerId = 'development-demo', entityPlan = consumerEntityPlan(producerId))
{
    const temporalContext = consumerContext(producerId);
    const artifact = resolveTemporalRolesForProducer({ temporalContext, namespace: 'ordinary',
        fixtureId: 'entity-consumer-control', planDigest, entityPlan });
    return { temporalContext, artifact, expected: { artifactDigest: artifact.contentDigest,
        entityPlanDigest: digestCanonical(entityPlan), producerId, runId: temporalContext.schedulerRunId,
        namespace: 'ordinary', fixtureId: 'entity-consumer-control', planDigest, shapeId: artifact.shape.id } };
}
