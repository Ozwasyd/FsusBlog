const { bindTemporalBusinessFields } = await import(new URL('../temporal-business-fields.mjs', import.meta.url));
const { resolveTemporalRolesForProducer } = await import(new URL('../../test/temporal-role-resolver.mjs', import.meta.url));

// Field ownership only: all temporal offsets and states stay in the sole catalog.
export const demoTemporalFieldMappings = Object.freeze([
    ['article.createtime', 'article.created'],
    ['article.metadata-updated-at', 'article.metadata-updated'],
    ['article.published-at', 'article.published'],
    ['article.last-published-at', 'article.published'],
    ['article-revision.created-at', 'article.revision'],
    ['article-publication.published-at', 'article.publication'],
    ['article-rights-policy.created-at', 'article.created'],
    ['article-rights-snapshot.created-at', 'article.revision'],
    ['comment.create-time', 'comment.created'],
    ['comment.moderated-at', 'comment.moderated'],
    ['comment-revision.created-at', 'comment.created'],
    ['profile.created-at', 'profile.created'],
    ['audit.occurred-at', 'audit.occurred']
].map(([field, roleId]) => Object.freeze({ field, roleId })));

/** Consume one demo coordinate's canonical artifact; never substitute old dates. */
export function bindDemoTemporalBusinessFields(input)
{
    if (input?.temporalContext?.producerId !== 'development-demo')
    {
        throw new Error('demo temporal binding requires development-demo context');
    }
    return bindTemporalBusinessFields({ ...input, fieldMappings: demoTemporalFieldMappings });
}

/** Prepare canonical ingress before any cleanup or business write is attempted. */
export function prepareDemoTemporalBinding(context)
{
    const artifact = resolveTemporalRolesForProducer({
        temporalContext: context.temporalContext,
        namespace: context.namespace,
        fixtureId: 'development-demo',
        planDigest: context.plan?.variantPlanDigest
    });
    const binding = bindDemoTemporalBusinessFields({
        temporalContext: context.temporalContext,
        artifact,
        expected: {
            artifactDigest: artifact.contentDigest,
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
