using System.Data.Common;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>Frozen canonical physical input; no native allocation or complete seed qualification.</summary>
internal sealed class DataScaleArticleBatchAuthority
{
    internal DataScaleArticlePhysicalBatch Batch
    {
        get;
    }
    private readonly string _runId;
    private readonly string _runtime;
    private readonly string _source;
    private readonly string _namespace;
    private readonly string _reference;
    private readonly string _planDigest;
    private readonly string _graphDigest;
    private readonly string _bindingsDigest;
    private readonly string _physicalDigest;
    private readonly string _keysDigest;

    internal DataScaleArticleBatchAuthority(ArticleScalePlan plan,
        IReadOnlyList<ArticleScaleArticleGraph> graphs,
        IReadOnlyDictionary<string, ArticleScaleGraphIdentityBindings> identities,
        IReadOnlyDictionary<ArticleScaleRowKind, DataScaleEntityTransportBinding> schema,
        IReadOnlyDictionary<string, long> externalIdentities,
        string runId, string runtimeIdentity, string sourceCommit, string factoryBatchReference,
        string expectedGraphDigest, ArticleScaleResolvedGraphBatch? resolvedBatch = null,
        DataScaleArticleTaxonomySchema? taxonomySchema = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(runId);
        ArgumentException.ThrowIfNullOrWhiteSpace(runtimeIdentity);
        ArgumentException.ThrowIfNullOrWhiteSpace(factoryBatchReference);
        if (runId.Length > 256 || runtimeIdentity.Length > 256 || factoryBatchReference.Length > 2048)
        {
            throw new InvalidOperationException("batch_identity_bound_exceeded");
        }
        if (sourceCommit.Length != 40 || sourceCommit.AsSpan().ContainsAnyExcept("0123456789abcdef"))
        {
            throw new InvalidOperationException("batch_source_commit_invalid");
        }
        DataScaleArticlePhysicalBatch compiled = DataScaleArticlePhysicalProjection.Compile(
            plan, graphs, identities, schema, externalIdentities, resolvedBatch, taxonomySchema);
        _graphDigest = ComputeGraphDigest(graphs);
        if (_graphDigest != expectedGraphDigest)
        {
            throw new InvalidOperationException("batch_factory_graph_digest_mismatch");
        }
        Batch = compiled with
        {
            Tables = Array.AsReadOnly(compiled.Tables.Select(table => table with
            {
                Columns = Array.AsReadOnly(table.Columns.ToArray()),
                Rows = Array.AsReadOnly(table.Rows.Select(row => (IReadOnlyList<object?>)Array.AsReadOnly(row.ToArray())).ToArray())
            }).ToArray()),
            PrimaryKeyColumns = new System.Collections.ObjectModel.ReadOnlyDictionary<string, int>(
                new Dictionary<string, int>(compiled.PrimaryKeyColumns, StringComparer.Ordinal)),
            DeferredColumns = new System.Collections.ObjectModel.ReadOnlyDictionary<string, IReadOnlyList<int>>(
                compiled.DeferredColumns.ToDictionary(pair => pair.Key,
                    pair => (IReadOnlyList<int>)Array.AsReadOnly(pair.Value.ToArray()), StringComparer.Ordinal)),
            CompositePrimaryKeyColumns = new System.Collections.ObjectModel.ReadOnlyDictionary<string, IReadOnlyList<int>>(
                compiled.CompositePrimaryKeyColumns.ToDictionary(pair => pair.Key,
                    pair => (IReadOnlyList<int>)Array.AsReadOnly(pair.Value.ToArray()), StringComparer.Ordinal)),
            OwnedRowScopes = new System.Collections.ObjectModel.ReadOnlyDictionary<string, DataScaleOwnedRowScope>(
                compiled.OwnedRowScopes.ToDictionary(pair => pair.Key,
                    pair => pair.Value with { Values = Array.AsReadOnly(pair.Value.Values.ToArray()) }, StringComparer.Ordinal)),
            ExternalReferences = Array.AsReadOnly(compiled.ExternalReferences.Select(reference => reference with
            {
                Values = Array.AsReadOnly(reference.Values.ToArray())
            }).ToArray()),
            LogicalReferences = Array.AsReadOnly(compiled.LogicalReferences.ToArray()),
            LogicalRowCounts = new System.Collections.ObjectModel.ReadOnlyDictionary<string, long>(
                new Dictionary<string, long>(compiled.LogicalRowCounts, StringComparer.Ordinal))
        };
        _physicalDigest = DataScalePhysicalBatchReadback.ExpectedDigest(Batch);
        _bindingsDigest = Digest(identities.OrderBy(pair => pair.Key, StringComparer.Ordinal)
            .SelectMany(pair => new[] { pair.Key, pair.Value.Digest }));
        _keysDigest = Digest(Batch.Tables.OrderBy(table => table.Table, StringComparer.Ordinal).SelectMany(table =>
            new[] { table.Table }.Concat(DataScalePhysicalBatchReadback.KeyColumns(Batch, table.Table).Select(key => table.Columns[key].Name))
                .Concat(Batch.CompositePrimaryKeyColumns.Count == 0
                    ? table.Rows.Select(row => Convert.ToInt64(row[Batch.PrimaryKeyColumns[table.Table]], CultureInfo.InvariantCulture))
                        .Order().Select(id => id.ToString(CultureInfo.InvariantCulture))
                    : table.Rows.Select(row => DataScalePhysicalBatchReadback.KeyToken(row,
                        DataScalePhysicalBatchReadback.KeyColumns(Batch, table.Table))).Order(StringComparer.Ordinal))));
        _runId = runId;
        _runtime = runtimeIdentity;
        _source = sourceCommit;
        _namespace = plan.Namespace;
        _reference = factoryBatchReference;
        _planDigest = ArticleScalePlanDigest.Compute(plan);
    }

    internal DataScaleBatchCheckpointIdentity Identity(DbConnection connection, DataScaleBulkProvider provider)
        => new(_runId, _runtime, _source, _namespace, provider.ToString(),
            Digest([connection.GetType().FullName!, connection.DataSource, connection.Database, connection.ServerVersion]),
            _planDigest, _reference, _graphDigest, _bindingsDigest, _physicalDigest, _keysDigest);

    internal static string ComputeGraphDigest(IReadOnlyList<ArticleScaleArticleGraph> graphs)
        => Digest(graphs.OrderBy(graph => graph.ArticleOrdinal).SelectMany(graph =>
            new[] { graph.SemanticArticleId, graph.ArticleDigest }));

    private static string Digest(IEnumerable<string> values)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (string value in values.Prepend("data-scale-batch-binding.v1"))
        {
            byte[] bytes = Encoding.UTF8.GetBytes(value);
            hash.AppendData(Encoding.ASCII.GetBytes(bytes.Length.ToString(CultureInfo.InvariantCulture) + ":"));
            hash.AppendData(bytes);
        }
        return "sha256:" + Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }
}
