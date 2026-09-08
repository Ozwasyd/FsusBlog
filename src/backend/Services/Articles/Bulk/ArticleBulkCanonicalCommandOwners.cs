using System.Collections.Frozen;
using System.Collections.Immutable;

namespace FsusBlog.Server.Services.Articles.Bulk;

internal enum ArticleBulkCommandAdapterAvailability
{
    Unavailable,
    Available
}

internal sealed record ArticleBulkCanonicalCommandOwner(
    string Id,
    ArticleBulkCommandAdapterAvailability AdapterAvailability,
    ImmutableArray<string> OperationIds);

/// <summary>
/// Sole bidirectional declaration between the bulk registry and canonical single-article owners.
/// Availability describes a receipt-bearing bulk adapter, not whether related domain code exists.
/// </summary>
internal static class ArticleBulkCanonicalCommandOwners
{
    private static readonly ImmutableArray<ArticleBulkCanonicalCommandOwner> s_current =
    [
        Owner("article-category-command", ["category.add", "category.remove"]),
        Owner("article-content-check-command", ["content-check.run"]),
        Owner(
            "article-lifecycle-command",
            ["lifecycle.archive", "lifecycle.draft-to-inbox", "lifecycle.inbox-to-draft", "lifecycle.restore"]),
        Owner("article-property-command", ["property.clear", "property.set"]),
        Owner("article-relation-reindex-command", ["relation.reindex"]),
        Owner("article-schedule-command", ["schedule.change"]),
        Owner("article-tag-command", ["tag.add", "tag.remove"]),
        Owner("author-search-reindex-command", ["search.reindex"])
    ];

    internal static ImmutableArray<ArticleBulkCanonicalCommandOwner> Current => s_current;

    internal static FrozenDictionary<string, ImmutableArray<string>> CreateOperationMap(
        IEnumerable<ArticleBulkCanonicalCommandOwner> owners)
    {
        ArticleBulkCanonicalCommandOwner[] materialized = [.. owners];
        if (materialized.Length == 0
            || materialized.Select(static owner => owner.Id).Distinct(StringComparer.Ordinal).Count()
                != materialized.Length
            || materialized.Any(static owner => string.IsNullOrWhiteSpace(owner.Id)
                || owner.OperationIds.IsDefaultOrEmpty
                || owner.OperationIds.Distinct(StringComparer.Ordinal).Count() != owner.OperationIds.Length))
        {
            throw new ArticleBulkContractException("article-bulk.command-owner-catalog-invalid");
        }

        return materialized.ToFrozenDictionary(
            static owner => owner.Id,
            static owner => owner.OperationIds.Order(StringComparer.Ordinal).ToImmutableArray(),
            StringComparer.Ordinal);
    }

    internal static void ValidateExact(
        IEnumerable<ArticleBulkOperation> operations,
        IEnumerable<ArticleBulkCanonicalCommandOwner> owners)
    {
        ArticleBulkOperation[] registered = [.. operations];
        FrozenDictionary<string, ImmutableArray<string>> ownerMap = CreateOperationMap(owners);
        string[] ownedOperationIds =
        [
            .. ownerMap.Values.SelectMany(static operationIds => operationIds).Order(StringComparer.Ordinal)
        ];
        string[] registeredOperationIds =
        [
            .. registered.Select(static operation => operation.Id).Order(StringComparer.Ordinal)
        ];
        if (!ownedOperationIds.SequenceEqual(registeredOperationIds, StringComparer.Ordinal)
            || registered.Any(operation => !ownerMap.TryGetValue(operation.CommandOwner, out var operationIds)
                || !operationIds.Contains(operation.Id, StringComparer.Ordinal)))
        {
            throw new ArticleBulkContractException("article-bulk.command-owner-mismatch");
        }
    }

    private static ArticleBulkCanonicalCommandOwner Owner(
        string id,
        ImmutableArray<string> operationIds)
        => new(id, ArticleBulkCommandAdapterAvailability.Unavailable, operationIds);
}
