using System.Data.Common;
using System.Reflection;

using SqlSugar;

using DbType = System.Data.DbType;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

internal sealed record DataScalePostgresArticleProduction(
    IReadOnlyList<DataScaleNativeIdentityObservation> NativeAllocation,
    IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> NativeBindings,
    IReadOnlyList<ArticleScaleArticleGraph> Graphs,
    DataScaleArticleBatchAuthority Authority,
    DataScaleArticleBatchExecution Execution);

/// <summary>
/// Actual native sequence → existing factory sealing → shared physical transaction pipeline.
/// It creates no publication receipt or derived output. Original allocation observations/maps
/// must be durably receipted by the task owner before the first product-row transaction.
/// </summary>
internal static class DataScalePostgresArticleProducer
{
    /// <summary>
    /// Same-task test/evidence handoff of an actual resolved ProduceAsync result. The original
    /// callbacks/store persist allocation evidence before rows and authenticate the exact
    /// committed checkpoint before consumption. This adds no admission record or qualification.
    /// Missing upstream resolved values must remain missing; this port generates none.
    /// </summary>
    internal static async Task<TResult> ProduceAndConsumeResolvedAsync<TResult>(
        DbConnection connection, ArticleScalePlan plan, IReadOnlyList<ArticleScaleArticleGraph> factoryBatch,
        ArticleScaleResolvedGraphBatch resolvedBatch,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, long> externalIdentities,
        string runId, string runtimeIdentity, string sourceCommit, string factoryBatchReference,
        ReadOnlyMemory<byte> taskKey, DataScaleBatchCheckpointStore store,
        Func<DataScalePostgresArticleProduction, ArticleScalePlan, ArticleScaleResolvedGraphBatch,
            DbConnection, DataScaleBatchCheckpointIdentity, ReadOnlyMemory<byte>, string, CancellationToken, Task<TResult>> consume,
        CancellationToken cancellationToken, DataScaleArticleTaxonomySchema? taxonomySchema = null)
    {
        ArgumentNullException.ThrowIfNull(resolvedBatch);
        ArgumentNullException.ThrowIfNull(consume);
        ArgumentNullException.ThrowIfNull(store);
        if (taskKey.Length is < 32 or > 4096)
        {
            throw new InvalidOperationException("checkpoint_task_key_invalid");
        }
        byte[] key = taskKey.ToArray();
        string? allocationEvidence = null;
        async Task Persist(IReadOnlyList<DataScaleNativeIdentityObservation> observations,
            IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> bindings, CancellationToken token)
        {
            allocationEvidence = await store.PersistNativeAllocationEvidenceAsync(observations, bindings, token).ConfigureAwait(false);
            await store.VerifyNativeAllocationEvidenceAsync(allocationEvidence, observations, bindings, token).ConfigureAwait(false);
        }
        DataScalePostgresArticleProduction production = await ProduceAsync(connection, plan, factoryBatch, schema,
            externalIdentities, runId, runtimeIdentity, sourceCommit, factoryBatchReference, key,
            Persist, store.PersistAsync, cancellationToken, resolvedBatch, taxonomySchema).ConfigureAwait(false);
        if (production.Execution.Transport.State != DataScaleBulkCommitState.Committed
            || production.Execution.Checkpoint?.Stage != DataScaleBatchCheckpointStage.Committed)
        {
            throw new InvalidOperationException("resolved_producer_handoff_requires_committed_checkpoint");
        }
        // Observe from the executed original authority and live connection, never from the
        // checkpoint being verified. No new run/runtime/epoch/seed fields are constructed.
        DataScaleBatchCheckpointIdentity current = production.Authority.Identity(connection, DataScaleBulkProvider.PostgreSql);
        DataScaleBatchCheckpoint persisted = await store.ReadAsync(production.Execution.Checkpoint.Signature, current,
            key, cancellationToken).ConfigureAwait(false);
        persisted.Validate(current, key, DataScaleBatchCheckpointStage.Committed);
        await store.VerifyNativeAllocationEvidenceAsync(allocationEvidence!, production.NativeAllocation,
            production.NativeBindings, cancellationToken).ConfigureAwait(false);
        return await consume(production, plan, resolvedBatch, connection, current, key, allocationEvidence!,
            cancellationToken).ConfigureAwait(false);
    }

    internal static async Task<DataScalePostgresArticleProduction> ProduceAsync(
        DbConnection connection, ArticleScalePlan plan, IReadOnlyList<ArticleScaleArticleGraph> factoryBatch,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, long> externalIdentities,
        string runId, string runtimeIdentity, string sourceCommit, string factoryBatchReference,
        ReadOnlyMemory<byte> taskKey,
        Func<IReadOnlyList<DataScaleNativeIdentityObservation>, IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings>, CancellationToken, Task> persistNativeAllocation,
        Func<DataScaleBatchCheckpoint, CancellationToken, Task> persistCheckpoint,
        CancellationToken cancellationToken, ArticleScaleResolvedGraphBatch? resolvedBatch = null,
        DataScaleArticleTaxonomySchema? taxonomySchema = null)
    {
        ArgumentNullException.ThrowIfNull(persistNativeAllocation);
        ArgumentNullException.ThrowIfNull(persistCheckpoint);
        // Refuse unusable authentication before consuming native sequences; copy the
        // original caller key so mutation during awaited persistence cannot change it.
        if (taskKey.Length is < 32 or > 4096)
        {
            throw new InvalidOperationException("checkpoint_task_key_invalid");
        }
        taskKey = taskKey.ToArray();
        factoryBatch = Array.AsReadOnly(factoryBatch.ToArray());
        schema = new System.Collections.ObjectModel.ReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding>(
            schema.ToDictionary(pair => pair.Key, pair => pair.Value with
            {
                Columns = new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(
                    new Dictionary<string, string>(pair.Value.Columns, StringComparer.Ordinal))
            }));
        externalIdentities = new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(
            new Dictionary<string, long>(externalIdentities, StringComparer.Ordinal));
        if (taxonomySchema is not null)
        {
            DataScaleEntityTransportBinding Freeze(DataScaleEntityTransportBinding binding) => binding with
            {
                Columns = new System.Collections.ObjectModel.ReadOnlyDictionary<string, string>(
                    new Dictionary<string, string>(binding.Columns, StringComparer.Ordinal))
            };
            taxonomySchema = new(Freeze(taxonomySchema.ArticleTag), Freeze(taxonomySchema.Category), Freeze(taxonomySchema.Tag));
        }
        if (resolvedBatch is not null)
        {
            if (resolvedBatch.Coverage.PlanDigest != ArticleScalePlanDigest.Compute(plan)
                || !factoryBatch.Select(graph => graph.ArticleOrdinal).Order().SequenceEqual(resolvedBatch.ArticleOrdinals))
            {
                throw new InvalidOperationException("native_article_resolved_roster_mismatch");
            }
            foreach (ArticleScaleArticleGraph graph in factoryBatch)
            {
                ArticleScaleArticleGraph expected = CanonicalArticleGraphFactory.BuildArticleGraph(plan, graph.ArticleOrdinal,
                    graph.Variant, ArticleScaleVariantContractCatalog.Get(graph.Variant), null, resolvedBatch);
                if (expected.ArticleDigest != graph.ArticleDigest)
                {
                    throw new InvalidOperationException("native_article_presealing_input_mismatch");
                }
            }
        }
        IReadOnlyList<ArticleScaleNativeRoleRequirement> requirements = CanonicalArticleGraphFactory.DescribeNativeRoles(plan, factoryBatch);
        // Compile a diagnostic-ID snapshot only to validate all canonical roles/schema/context
        // before native sequence effects. These diagnostic IDs are never written to the database.
        var diagnosticIds = requirements.SelectMany((group, index) => group.SemanticRoles.Select(role => (Role: role, Id: index + 1L)))
            .ToDictionary(pair => pair.Role, pair => pair.Id, StringComparer.Ordinal);
        var preflightBindings = factoryBatch.ToDictionary(graph => graph.SemanticArticleId, graph =>
            new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), graph.SemanticArticleId,
                diagnosticIds.Where(pair => pair.Key == graph.SemanticArticleId
                    || pair.Key.StartsWith(graph.SemanticArticleId + "/", StringComparison.Ordinal))
                    .ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal)), StringComparer.Ordinal);
        ArticleScaleArticleGraph[] preflightGraphs = factoryBatch.Select(graph => CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, graph.ArticleOrdinal, graph.Variant, ArticleScaleVariantContractCatalog.Get(graph.Variant),
            preflightBindings[graph.SemanticArticleId], resolvedBatch)).ToArray();
        _ = new DataScaleArticleBatchAuthority(plan, preflightGraphs, preflightBindings, schema, externalIdentities,
            runId, runtimeIdentity, sourceCommit, factoryBatchReference, DataScaleArticleBatchAuthority.ComputeGraphDigest(preflightGraphs), resolvedBatch, taxonomySchema);
        var requests = new List<DataScaleNativeIdentityTableRequest>();
        foreach (var model in DataScaleArticlePhysicalProjection.EntityModels.Where(model => model.Kind != ArticleScaleRowKind.ArticleBody))
        {
            DataScaleEntityTransportBinding binding = schema[model.Kind];
            string table = (string)model.Entity.GetCustomAttributesData().Single(attribute => attribute.AttributeType == typeof(SugarTable))
                .ConstructorArguments[0].Value!;
            PropertyInfo[] properties = model.Entity.GetProperties().Where(property => property.GetCustomAttribute<SugarColumn>()?.IsIgnore != true).ToArray();
            PropertyInfo key = properties.Single(property => property.GetCustomAttribute<SugarColumn>()?.IsPrimaryKey == true);
            if (binding.Table != table || key.GetCustomAttribute<SugarColumn>()?.IsIdentity != true
                || !properties.Select(property => property.Name).ToHashSet(StringComparer.Ordinal).SetEquals(binding.Columns.Keys))
            {
                throw new InvalidOperationException("native_article_prepared_schema_or_model_mismatch");
            }
            requests.Add(new(binding.Table, new(binding.Columns[key.Name], key.PropertyType == typeof(int) ? DbType.Int32 : DbType.Int64),
                requirements.Where(group => group.Kind == model.Kind)
                    .Select(group => new DataScaleNativeIdentityRoleGroup(group.AllocationRole, group.SemanticRoles)).ToArray()));
        }
        IReadOnlyList<DataScaleNativeIdentityObservation> allocation;
        await using (DbTransaction reserve = await connection.BeginTransactionAsync(System.Data.IsolationLevel.Serializable, cancellationToken).ConfigureAwait(false))
        {
            allocation = await DataScalePostgresIdentityReservation.ReserveAsync(connection, reserve, requests, cancellationToken).ConfigureAwait(false);
            await reserve.CommitAsync(cancellationToken).ConfigureAwait(false);
        }
        Dictionary<string, long> ids = allocation.SelectMany(item => item.RoleIds).ToDictionary(pair => pair.Key, pair => pair.Value, StringComparer.Ordinal);
        var bindings = factoryBatch.ToDictionary(graph => graph.SemanticArticleId, graph =>
            new ArticleScaleGraphIdentityBindings(ArticleScalePlanDigest.Compute(plan), graph.SemanticArticleId,
                requirements.SelectMany(group => group.SemanticRoles).Where(role => role == graph.SemanticArticleId
                    || role.StartsWith(graph.SemanticArticleId + "/", StringComparison.Ordinal))
                    .ToDictionary(role => role, role => ids[role], StringComparer.Ordinal)), StringComparer.Ordinal);
        // Failure here consumes sequence gaps only. No product rows have been written.
        await persistNativeAllocation(allocation, bindings, cancellationToken).ConfigureAwait(false);
        ArticleScaleArticleGraph[] graphs = factoryBatch.Select(graph => CanonicalArticleGraphFactory.BuildArticleGraph(
            plan, graph.ArticleOrdinal, graph.Variant, ArticleScaleVariantContractCatalog.Get(graph.Variant), bindings[graph.SemanticArticleId], resolvedBatch)).ToArray();
        var authority = new DataScaleArticleBatchAuthority(plan, graphs, bindings, schema, externalIdentities,
            runId, runtimeIdentity, sourceCommit, factoryBatchReference, DataScaleArticleBatchAuthority.ComputeGraphDigest(graphs), resolvedBatch, taxonomySchema);
        DataScaleArticleBatchExecution execution = await DataScaleArticleBatchWriter.WriteAsync(connection, DataScaleBulkProvider.PostgreSql,
            authority, null, taskKey, persistCheckpoint, cancellationToken).ConfigureAwait(false);
        return new(allocation, bindings, Array.AsReadOnly(graphs), authority, execution);
    }
}
