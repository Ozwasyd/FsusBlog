using System.Collections.Immutable;

using Npgsql;

using SqlSugar;

namespace FsusBlog.Server.Services.Articles;

public static partial class ArticleLifecycleTransitionWriter
{
    /// <summary>
    /// Reads and locks real original revision/provenance facts for an exact bounded frozen set.
    /// Locks use numeric article order; results retain the caller's exact frozen order. References
    /// are resolved from original native rows, never parsed as numeric revision IDs or grants.
    /// </summary>
    internal static async Task<ImmutableArray<BulkRevisionFacts>> ReadLockedBulkRevisionSetAsync(
        ISqlSugarClient database, NpgsqlTransaction transaction,
        ImmutableArray<(int ArticleId, string ExpectedReference)> ordered, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (ordered.IsDefaultOrEmpty || ordered.Length > 10_000 || ordered.Any(static item => item.ArticleId <= 0)
            || ordered.Select(static item => item.ArticleId).Distinct().Count() != ordered.Length)
            throw BulkRevisionFailure("frozen_set_invalid");
        foreach (var item in ordered)
            RequireBulkRevisionReferenceShape(item.ExpectedReference);
        RequireBulkRevisionTransaction(database, transaction);
        var actual = new Dictionary<int, BulkRevisionFacts>(ordered.Length);
        foreach (var item in ordered.OrderBy(static item => item.ArticleId))
        {
            BulkRevisionFacts facts = await ReadBulkRevisionFactsAsync(database, transaction, item.ArticleId,
                lockRows: true, cancellationToken).ConfigureAwait(false);
            if (ComputeBulkRevisionReference(facts) != item.ExpectedReference)
                throw BulkRevisionFailure("frozen_reference_changed");
            actual.Add(item.ArticleId, facts);
        }
        RequireBulkRevisionTransaction(database, transaction);
        cancellationToken.ThrowIfCancellationRequested();
        return [.. ordered.Select(item => actual[item.ArticleId])];
    }
}
