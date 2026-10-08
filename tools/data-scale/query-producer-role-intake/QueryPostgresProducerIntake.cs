using System.Data;
using System.Data.Common;

using FsusBlog.Server.Services.Fixtures.DataScale;

namespace FsusBlog.QueryEvidence;

/// <summary>
/// Test-only consumer of the original PostgreSQL producer, resolved-input and
/// authenticated checkpoint APIs. It reads no SQL and supplies no native IDs,
/// allocation receipts, expected cases or alternate physical writer.
/// </summary>
internal static class QueryPostgresProducerIntake
{
    /// <summary>
    /// Delegates production and persistence to the original same-task handoff.
    /// Its callback consumes the original live objects and rereads allocation
    /// evidence without retaining the key or granting query admission.
    /// </summary>
    internal static Task<QueryPostgresProducerInspection> ProduceAndInspectResolvedAsync(
        DbConnection connection, ArticleScalePlan plan,
        IReadOnlyList<ArticleScaleArticleGraph> factoryBatch, ArticleScaleResolvedGraphBatch resolvedBatch,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, long> externalIdentities,
        string runId, string runtimeIdentity, string sourceCommit, string factoryBatchReference,
        ReadOnlyMemory<byte> taskKey, DataScaleBatchCheckpointStore store,
        CancellationToken cancellationToken, DataScaleArticleTaxonomySchema? taxonomySchema = null)
    {
        return DataScalePostgresArticleProducer.ProduceAndConsumeResolvedAsync<QueryPostgresProducerInspection>(
            connection, plan, factoryBatch, resolvedBatch, schema, externalIdentities,
            runId, runtimeIdentity, sourceCommit, factoryBatchReference, taskKey, store,
            async (production, originalPlan, originalResolved, liveConnection, currentIdentity, key, allocationEvidence, token) =>
            {
                QueryPostgresProducerInspection inspection = Inspect(production, originalPlan, originalResolved,
                    liveConnection, currentIdentity, key.Span);
                await store.VerifyNativeAllocationEvidenceAsync(allocationEvidence, production.NativeAllocation,
                    production.NativeBindings, token).ConfigureAwait(false);
                return inspection with { NativeAllocationEvidenceDigest = allocationEvidence };
            }, cancellationToken, taxonomySchema);
    }

    /// <summary>
    /// Links one actual bounded producer batch to its independently supplied
    /// current identity. Missing resolved input refuses diagnostic fallback.
    /// Native keys are borrowed for the original validator and never retained.
    /// </summary>
    internal static QueryPostgresProducerInspection Inspect(
        DataScalePostgresArticleProduction? production,
        ArticleScalePlan? plan,
        ArticleScaleResolvedGraphBatch? resolvedBatch,
        DbConnection? connection,
        DataScaleBatchCheckpointIdentity? currentIdentity,
        ReadOnlySpan<byte> taskKey)
    {
        var blockers = new List<string>();
        if (production is null)
        {
            blockers.Add("postgres_article_production_missing");
        }
        if (plan is null)
        {
            blockers.Add("article_canonical_plan_missing");
        }
        if (resolvedBatch is null)
        {
            blockers.Add("article_resolved_graph_batch_missing");
        }
        if (connection is null)
        {
            blockers.Add("article_current_postgres_connection_missing");
        }
        if (currentIdentity is null)
        {
            blockers.Add("article_current_checkpoint_identity_missing");
        }
        if (taskKey.IsEmpty)
        {
            blockers.Add("article_checkpoint_authentication_key_missing");
        }

        bool matched = false;
        if (blockers.Count == 0)
        {
            Require(connection!.GetType().FullName == "Npgsql.NpgsqlConnection"
                && connection.State == ConnectionState.Open, "article_current_postgres_connection_mismatch");
            ArticleScalePlanValidator.Validate(plan!, plan!.Artifacts).ThrowIfInvalid();
            Require(production!.Graphs.Count is > 0 and <= 1000
                && production.NativeAllocation.Count is > 0 and <= 32
                && production.NativeAllocation.Sum(item => (long)item.RoleIds.Count) <= 50_000,
                "article_producer_batch_bound_invalid");
            Require(resolvedBatch!.Coverage.PlanDigest == ArticleScalePlanDigest.Compute(plan),
                "article_resolved_coverage_plan_mismatch");

            ArticleScaleArticleGraph[] graphs = production.Graphs.ToArray();
            Require(graphs.Select(graph => graph.ArticleOrdinal).Distinct().Count() == graphs.Length
                && graphs.Select(graph => graph.ArticleOrdinal).Order().SequenceEqual(resolvedBatch.ArticleOrdinals)
                && production.NativeBindings.Count == graphs.Length
                && graphs.Select(graph => graph.SemanticArticleId).ToHashSet(StringComparer.Ordinal)
                    .SetEquals(production.NativeBindings.Keys), "article_producer_resolved_roster_mismatch");

            // Original factory owns the role roster, shared-content aliases and
            // resealing with resolved content/temporal/assignment inputs. Do not
            // infer IDs from ordinals or impose uniqueness across native aliases.
            IReadOnlyList<ArticleScaleNativeRoleRequirement> roles = CanonicalArticleGraphFactory.DescribeNativeRoles(plan, graphs);
            Dictionary<string, long> allocated = production.NativeAllocation.SelectMany(item => item.RoleIds)
                .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
            Require(roles.SelectMany(role => role.SemanticRoles).ToHashSet(StringComparer.Ordinal).SetEquals(allocated.Keys),
                "article_producer_native_allocation_roster_mismatch");
            Require(roles.All(group => group.SemanticRoles.Select(role => allocated[role]).Distinct().Count() == 1),
                "article_producer_native_alias_coordinate_mismatch");
            foreach (ArticleScaleArticleGraph graph in graphs)
            {
                ArticleScaleGraphIdentityBindings identities = production.NativeBindings[graph.SemanticArticleId];
                Require(identities.Ids.All(pair => allocated.TryGetValue(pair.Key, out long id) && id == pair.Value),
                    "article_producer_native_allocation_coordinate_mismatch");
                ArticleScaleArticleGraph resealed = CanonicalArticleGraphFactory.BuildArticleGraph(plan, graph.ArticleOrdinal,
                    graph.Variant, ArticleScaleVariantContractCatalog.Get(graph.Variant), identities, resolvedBatch);
                Require(resealed.ArticleDigest == graph.ArticleDigest, "article_producer_resolved_graph_mismatch");
            }

            DataScaleBatchCheckpointIdentity observed = production.Authority.Identity(connection, DataScaleBulkProvider.PostgreSql);
            Require(observed == currentIdentity
                && observed.GraphDigest == DataScaleArticleBatchAuthority.ComputeGraphDigest(graphs)
                && observed.PlanDigest == resolvedBatch.Coverage.PlanDigest,
                "article_producer_current_checkpoint_identity_mismatch");
            // The original v2 digest includes native composite keys, complete
            // owned row scopes and external taxonomy references. Reuse it rather
            // than hashing a partial first-row projection or inventing a schema.
            Require(DataScalePhysicalBatchReadback.ExpectedDigest(production.Authority.Batch) == observed.PhysicalDigest,
                "article_producer_frozen_physical_scope_mismatch");
            Require(production.Execution.Transport.State == DataScaleBulkCommitState.Committed
                && production.Execution.Checkpoint is not null, "article_producer_committed_checkpoint_missing");
            // Authentication exceptions retain the original first failure. No
            // retry, stage normalization or checkpoint reconstruction is allowed.
            production.Execution.Checkpoint!.Validate(currentIdentity!, taskKey, DataScaleBatchCheckpointStage.Committed);
            matched = true;
        }

        // These exact invariants are absent from the current native component
        // contract. Committed authenticated batches are not complete seed/query
        // admission. The handoff's persisted allocation evidence is raw data;
        // its verified digest does not supply a sealed allocation admission receipt.
        blockers.Add("article_native_allocation_persistence_receipt_missing");
        blockers.Add("article_query_epoch_fixture_generation_and_seed_receipt_binding_missing");
        blockers.Add("article_whole_plan_materialization_receipt_missing");
        blockers.Add("article_signed_audit_and_complete_seed_acceptance_missing");
        blockers.Add("article_actual_publication_result_and_current_invocation_missing");
        return new QueryPostgresProducerInspection(production, resolvedBatch, currentIdentity, matched, blockers.AsReadOnly());
    }

    private static void Require(bool condition, string code)
    {
        if (!condition)
        {
            throw new InvalidOperationException(code);
        }
    }
}

/// <summary>
/// Actual component references and linkage diagnostics. Matching bounded input,
/// native allocation and authenticated checkpoint does not establish full-plan
/// materialization, business epoch, publication acceptance or release evidence.
/// </summary>
internal sealed record QueryPostgresProducerInspection(
    DataScalePostgresArticleProduction? Production,
    ArticleScaleResolvedGraphBatch? ResolvedBatch,
    DataScaleBatchCheckpointIdentity? CurrentIdentity,
    bool ComponentBindingsMatched,
    IReadOnlyList<string> Blockers)
{
    /// <summary>Original store-verified raw evidence reference; never an admission receipt.</summary>
    internal string? NativeAllocationEvidenceDigest { get; init; }

    internal bool CanExecuteQueries => false;
    internal bool Qualification => false;
    internal bool ReleaseEvidenceEligible => false;

    /// <summary>Original runner must refuse these missing physical invariants.</summary>
    internal void ThrowBeforeQueryExecution()
    {
        throw new InvalidOperationException(
            $"query_postgres_producer_intake_blocked: {string.Join("; ", Blockers)}");
    }
}
