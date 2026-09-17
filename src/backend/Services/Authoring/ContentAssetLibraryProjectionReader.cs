using System.Data.Common;

using FsusBlog.Server.Contracts.Assets;

using Microsoft.Extensions.DependencyInjection;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

internal enum ContentAssetLibraryProjectionSort
{
    UpdatedDescending,
    CreatedDescending,
    ReferenceCountDescending
}

internal sealed record ContentAssetLibraryProjectionQuery(
    int Offset = 0,
    int Limit = 50,
    string? State = null,
    string? MediaType = null,
    long? OwnerAdminPrincipalId = null,
    bool? Referenced = null,
    ContentAssetLibraryProjectionSort Sort = ContentAssetLibraryProjectionSort.UpdatedDescending);

internal sealed record ContentAssetLibraryProjectionItem(
    AssetId AssetId,
    AssetStorageKey StorageKey,
    string PublicUrl,
    string StorageClass,
    string MediaType,
    string Extension,
    long ByteLength,
    string? Sha256,
    int? Width,
    int? Height,
    long? OwnerAdminPrincipalId,
    string State,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    long ReferenceCount,
    long SourceCount,
    string? AltText);

internal sealed record ContentAssetReferenceSourceProjection(
    string SourceKind,
    string SourceKey,
    int? ArticleId,
    int ReferenceCount,
    string? AltText,
    DateTime UpdatedAtUtc);

internal sealed record ContentAssetLibraryProjectionPage(
    int Offset,
    int Limit,
    bool HasMore,
    IReadOnlyList<ContentAssetLibraryProjectionItem> Items);

internal sealed record ContentAssetLibraryProjectionDetail(
    ContentAssetLibraryProjectionItem Asset,
    IReadOnlyList<ContentAssetReferenceSourceProjection> Sources);

internal static class ContentAssetLibraryProjectionCandidateWiring
{
    internal static IServiceCollection AddContentAssetLibraryProjectionCandidate(this IServiceCollection services)
    {
        services.AddScoped<ContentAssetLibraryProjectionReader>();
        return services;
    }
}

/// <summary>
/// Unactivated admin projection over the canonical content asset tables. The
/// final cutover can bind this reader without changing its query semantics.
/// </summary>
internal sealed class ContentAssetLibraryProjectionReader(ISqlSugarClient db)
{
    private const int MaxPageSize = 100;
    private readonly PublicAssetUrlCodec _urlCodec = new();

    internal async Task<ContentAssetLibraryProjectionPage> ListAsync(
        ContentAssetLibraryProjectionQuery query,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(query);
        if (query.Offset < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(query), "Asset projection offset cannot be negative.");
        }
        if (query.Limit is < 1 or > MaxPageSize)
        {
            throw new ArgumentOutOfRangeException(nameof(query), $"Asset projection limit must be between 1 and {MaxPageSize}.");
        }
        if (query.State is not null && !ContentAssetStates.IsValid(query.State))
        {
            throw new ArgumentException("Asset projection state is invalid.", nameof(query));
        }
        if (query.OwnerAdminPrincipalId is <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(query), "Asset projection owner must be positive.");
        }

        string? mediaType = NormalizeMediaType(query.MediaType);
        var predicates = new List<string>();
        var parameters = new List<SugarParameter>
        {
            new("@Offset", query.Offset),
            new("@FetchLimit", query.Limit + 1)
        };
        if (query.State is not null)
        {
            predicates.Add("asset.state = @State");
            parameters.Add(new SugarParameter("@State", query.State));
        }
        if (mediaType is not null)
        {
            predicates.Add("asset.media_type = @MediaType");
            parameters.Add(new SugarParameter("@MediaType", mediaType));
        }
        if (query.OwnerAdminPrincipalId.HasValue)
        {
            predicates.Add("asset.owner_admin_principal_id = @OwnerAdminPrincipalId");
            parameters.Add(new SugarParameter("@OwnerAdminPrincipalId", query.OwnerAdminPrincipalId.Value));
        }
        if (query.Referenced.HasValue)
        {
            predicates.Add(query.Referenced.Value
                ? "COALESCE(stats.reference_count, 0) > 0"
                : "COALESCE(stats.reference_count, 0) = 0");
        }

        string whereClause = predicates.Count == 0 ? string.Empty : "WHERE " + string.Join(" AND ", predicates);
        string orderClause = query.Sort switch
        {
            ContentAssetLibraryProjectionSort.UpdatedDescending => "asset.updated_at_utc DESC, asset.id ASC",
            ContentAssetLibraryProjectionSort.CreatedDescending => "asset.created_at_utc DESC, asset.id ASC",
            ContentAssetLibraryProjectionSort.ReferenceCountDescending => "COALESCE(stats.reference_count, 0) DESC, asset.id ASC",
            _ => throw new ArgumentOutOfRangeException(nameof(query), "Asset projection sort is invalid.")
        };
        string sql = $$"""
            WITH reference_stats AS (
                SELECT
                    reference.asset_id,
                    SUM(reference.reference_count) AS reference_count,
                    COUNT(*) AS source_count,
                    MIN(reference.alt_text) FILTER (
                        WHERE reference.alt_text IS NOT NULL AND reference.alt_text <> ''
                    ) AS alt_text
                FROM content_asset_reference reference
                GROUP BY reference.asset_id
            )
            SELECT
                asset.id,
                asset.storage_key,
                asset.storage_class,
                asset.media_type,
                asset.extension,
                asset.byte_length,
                asset.sha256,
                asset.width,
                asset.height,
                asset.owner_admin_principal_id,
                asset.state,
                asset.created_at_utc,
                asset.updated_at_utc,
                COALESCE(stats.reference_count, 0) AS reference_count,
                COALESCE(stats.source_count, 0) AS source_count,
                stats.alt_text
            FROM content_asset asset
            LEFT JOIN reference_stats stats ON stats.asset_id = asset.id
            {{whereClause}}
            ORDER BY {{orderClause}}
            OFFSET @Offset
            LIMIT @FetchLimit;
            """;

        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(sql, parameters.ToArray());
        var items = new List<ContentAssetLibraryProjectionItem>(query.Limit + 1);
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            items.Add(ReadItem(reader));
        }

        bool hasMore = items.Count > query.Limit;
        if (hasMore)
        {
            items.RemoveAt(items.Count - 1);
        }

        return new ContentAssetLibraryProjectionPage(query.Offset, query.Limit, hasMore, items);
    }

    internal async Task<ContentAssetLibraryProjectionDetail?> GetAsync(
        AssetId assetId,
        CancellationToken cancellationToken = default)
    {
        using var reader = (DbDataReader)await db.Ado.GetDataReaderAsync(
            """
            SELECT
                asset.id,
                asset.storage_key,
                asset.storage_class,
                asset.media_type,
                asset.extension,
                asset.byte_length,
                asset.sha256,
                asset.width,
                asset.height,
                asset.owner_admin_principal_id,
                asset.state,
                asset.created_at_utc,
                asset.updated_at_utc,
                COALESCE(SUM(reference.reference_count) OVER (PARTITION BY asset.id), 0) AS reference_count,
                COUNT(reference.asset_id) OVER (PARTITION BY asset.id) AS source_count,
                MIN(reference.alt_text) FILTER (
                    WHERE reference.alt_text IS NOT NULL AND reference.alt_text <> ''
                ) OVER (PARTITION BY asset.id) AS alt_text,
                reference.source_kind,
                reference.source_key,
                reference.article_id,
                reference.reference_count AS source_reference_count,
                reference.alt_text AS source_alt_text,
                reference.updated_at_utc AS source_updated_at_utc
            FROM content_asset asset
            LEFT JOIN content_asset_reference reference ON reference.asset_id = asset.id
            WHERE asset.id = @AssetId
            ORDER BY reference.source_kind, reference.source_key;
            """,
            new SugarParameter("@AssetId", assetId.Value));
        ContentAssetLibraryProjectionItem? item = null;
        var sources = new List<ContentAssetReferenceSourceProjection>();
        while (await reader.ReadAsync(cancellationToken).ConfigureAwait(false))
        {
            item ??= ReadItem(reader);
            if (!reader.IsNull("source_kind"))
            {
                sources.Add(new ContentAssetReferenceSourceProjection(
                    reader.ReadString("source_kind"),
                    reader.ReadString("source_key"),
                    reader.IsNull("article_id") ? null : reader.ReadInt32("article_id"),
                    reader.ReadInt32("source_reference_count"),
                    reader.IsNull("source_alt_text") ? null : reader.ReadString("source_alt_text"),
                    reader.ReadDateTime("source_updated_at_utc")));
            }
        }

        return item is null ? null : new ContentAssetLibraryProjectionDetail(item, sources);
    }

    private ContentAssetLibraryProjectionItem ReadItem(DbDataReader reader)
    {
        AssetStorageKey storageKey = AssetStorageKey.Parse(reader.ReadString("storage_key"));
        return new ContentAssetLibraryProjectionItem(
            AssetId.FromGuid(reader.GetGuid(reader.GetOrdinal("id"))),
            storageKey,
            _urlCodec.ToPublicPath(storageKey),
            reader.ReadString("storage_class"),
            reader.ReadString("media_type"),
            reader.ReadString("extension"),
            reader.GetInt64(reader.GetOrdinal("byte_length")),
            reader.IsNull("sha256") ? null : reader.ReadString("sha256"),
            reader.IsNull("width") ? null : reader.ReadInt32("width"),
            reader.IsNull("height") ? null : reader.ReadInt32("height"),
            reader.IsNull("owner_admin_principal_id") ? null : reader.GetInt64(reader.GetOrdinal("owner_admin_principal_id")),
            reader.ReadString("state"),
            reader.ReadDateTime("created_at_utc"),
            reader.ReadDateTime("updated_at_utc"),
            reader.GetInt64(reader.GetOrdinal("reference_count")),
            reader.GetInt64(reader.GetOrdinal("source_count")),
            reader.IsNull("alt_text") ? null : reader.ReadString("alt_text"));
    }

    private static string? NormalizeMediaType(string? value)
    {
        string? normalized = value?.Trim().ToLowerInvariant();
        if (normalized is { Length: > 127 })
        {
            throw new ArgumentOutOfRangeException(nameof(value), "Asset projection media type is too long.");
        }

        return string.IsNullOrEmpty(normalized) ? null : normalized;
    }
}
