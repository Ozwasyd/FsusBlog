import { buildQueryCaseRegistry, requireQueryBinding } from './query-case-registry.mjs';
import { computeSha256 } from './runtime-plan.mjs';

/** Compose original-owner expectations. This does not admit or create fixtures. */
export function mapCanonicalQueryExpectedModel({ articles, comments, canaries, binding, registrySchema, threadReplies, relatedReading })
{
    requireQueryBinding(binding);
    if ((threadReplies !== undefined || relatedReading !== undefined) && !registrySchema)
    {
        throw new Error('thread reply inputs require explicit versioned expected model selection');
    }
    if (articles?.schema !== 'fsusblog.data-scale-query-expected-articles.v1'
        || articles.factoryId !== 'fsusblog.canonical-article-graph-factory.v1'
        || articles.sourceCommit !== binding.sourceCommit || articles.businessEpochUtc !== binding.businessEpochUtc
        || articles.dataScaleRunId !== binding.dataScaleRunId || articles.fixtureGeneration !== binding.fixtureGeneration
        || articles.seedReceiptDigest !== binding.seedReceiptDigest
        || !/^sha256:[0-9a-f]{64}$/u.test(articles.planDigest ?? '') || !/^sha256:[0-9a-f]{64}$/u.test(articles.graphDigest ?? '')
        || comments?.sourceCommit !== binding.sourceCommit || comments.businessEpochUtc !== binding.businessEpochUtc
        || comments.dataScaleRunId !== binding.dataScaleRunId || comments.fixtureGeneration !== binding.fixtureGeneration
        || comments.seedReceiptDigest !== binding.seedReceiptDigest || !Array.isArray(comments.visibleComments))
    {
        throw new Error('canonical expected owner or fixture binding unavailable');
    }
    const model = {
        tier: articles.tier,
        articlePlanDigest: articles.planDigest, articleGraphDigest: articles.graphDigest,
        publicArticles: articles.publicArticles, visibleComments: comments.visibleComments,
        categories: articles.categories, tags: articles.tags, canaries,
        ...(registrySchema ? { registrySchema, threadReplies: threadReplies ?? null } : {}),
        ...(relatedReading !== undefined ? { relatedReading } : {})
    };
    if (computeSha256(model) !== binding.expectedModelDigest)
    {
        throw new Error('canonical mapped expected model digest mismatch');
    }
    // The registry validates mapped IDs, relations and exact coordinate fields.
    buildQueryCaseRegistry({ ...model, binding });
    return model;
}
