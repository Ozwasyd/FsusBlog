const { bindTemporalEntityBusinessFields, bindTemporalEntityBatchBusinessFields, iterateTemporalEntityBusinessBatches } = await import(new URL('../temporal-business-fields.mjs', import.meta.url));
const { resolveTemporalBusinessFieldStream } = await import(new URL('../temporal-business-stream.mjs', import.meta.url));
const { createTemporalBusinessRecordSource } = await import(new URL('../temporal-business-source.mjs', import.meta.url));
const { digestCanonical } = await import(new URL('../../test/temporal-context.mjs', import.meta.url));
const { resolveTemporalRolesForProducer } = await import(new URL('../../test/temporal-role-resolver.mjs', import.meta.url));

// Field ownership only: all temporal offsets and states stay in the sole catalog.
export const demoTemporalFieldMappings = Object.freeze([
    ['article.createtime', 'article.created'],
    ['article.metadata-updated-at', 'article.metadata-updated'],
    ['article.published-at', 'article.published'],
    ['article.last-published-at', 'article.published'],
    ['article-revision.created-at', 'article.revision', 'hasRevision'],
    ['article-publication.published-at', 'article.publication', 'hasPublication'],
    ['article-rights-policy.created-at', 'article.created', 'hasPublication'],
    ['article-rights-snapshot.created-at', 'article.revision', 'hasPublication', true],
    ['comment.create-time', 'comment.created'],
    ['comment.moderated-at', 'comment.moderated'],
    ['comment-revision.created-at', 'comment.created', 'hasRevision'],
    ['profile.created-at', 'profile.created'],
    ['audit.occurred-at', 'audit.occurred']
].map(([field, roleId, rowPresence, publicationRevision]) => Object.freeze({ field, roleId,
    entityKind: roleId.split('.')[0], ...(rowPresence ? { rowPresence } : {}),
    ...(field === 'comment-revision.created-at' ? { creationRevision: true } : {}),
    ...(publicationRevision ? { publicationRevision } : {}) })));

/** Consume one demo coordinate's canonical artifact; never substitute old dates. */
export function bindDemoTemporalBusinessFields(input)
{
    if (input?.temporalContext?.producerId !== 'development-demo')
    {
        throw new Error('demo temporal binding requires development-demo context');
    }
    const bind = input?.artifact?.schema === 'fsusblog.resolved-temporal-entity-batch.v2'
        ? bindTemporalEntityBatchBusinessFields : bindTemporalEntityBusinessFields;
    return bind({ ...input, fieldMappings: demoTemporalFieldMappings });
}

/** Consume original globally validated v2 batches without buffering a whole entity plan. */
export function resolveDemoTemporalBusinessStream(input)
{
    if (input?.temporalContext?.producerId !== 'development-demo')
    {
        throw new Error('demo temporal stream requires development-demo context');
    }
    return resolveTemporalBusinessFieldStream({ ...input, fieldMappings: demoTemporalFieldMappings });
}

/** Join actual producer rows into canonical input; no endpoint or seed fallback. */
export function resolveDemoTemporalBusinessRows(input)
{
    const source = createTemporalBusinessRecordSource(input);
    return resolveDemoTemporalBusinessStream({ ...input, source });
}

/** Explicit source-factory ingress for the registered demo fixture coordinate. */
export function prepareDemoTemporalStream(context, options)
{
    return resolveDemoTemporalBusinessStream({ ...options, temporalContext: context.temporalContext,
        fixtureIdentity: { producerId: 'development-demo', runId: context.runIdentity, namespace: context.namespace,
            fixtureId: 'development-demo', planDigest: context.plan?.variantPlanDigest } });
}

/** Keep entity/history order across transport packets from one verified artifact. */
export function iterateDemoTemporalBusinessBatches(input, options = {})
{
    options.signal?.throwIfAborted();
    return iterateTemporalEntityBusinessBatches(bindDemoTemporalBusinessFields(input), options);
}

/** Prepare canonical ingress before any cleanup or business write is attempted. */
export function prepareDemoTemporalBinding(context)
{
    const entityPlan = structuredClone(context.entityPlan);
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context.temporalContext,
        namespace: context.namespace,
        fixtureId: 'development-demo',
        planDigest: context.plan?.variantPlanDigest,
        entityPlan
    });
    const entityPlanDigest = digestCanonical(entityPlan);
    const binding = bindDemoTemporalBusinessFields({
        temporalContext: context.temporalContext,
        artifact,
        expected: {
            artifactDigest: artifact.contentDigest,
            entityPlanDigest,
            producerId: 'development-demo',
            runId: context.runIdentity,
            namespace: context.namespace,
            fixtureId: 'development-demo',
            planDigest: context.plan?.variantPlanDigest,
            shapeId: artifact.shape.id
        }
    });
    return Object.freeze({ artifact, binding });
}
