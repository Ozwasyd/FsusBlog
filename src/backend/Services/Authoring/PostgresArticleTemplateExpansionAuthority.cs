using FsusBlog.Server.Entities;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// PostgreSQL read authority for expansion inputs that must come from current durable state:
/// the acting principal's display name and the reusable-asset pins recorded in the plan.
/// </summary>
public sealed class PostgresArticleTemplateExpansionAuthority(ISqlSugarClient db)
    : IArticleTemplateExpansionAuthority
{
    public async Task<string> ResolveActorDisplayNameAsync(
        long adminPrincipalId,
        CancellationToken cancellationToken = default)
    {
        AdminPrincipal? principal = await db.Queryable<AdminPrincipal>()
            .Where(principal => principal.Id == adminPrincipalId)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (principal is null
            || !string.Equals(principal.Status, AdminPrincipalStatus.Active, StringComparison.Ordinal))
        {
            throw new ArticleTemplateExpansionException("article_template_expansion_actor_unavailable");
        }
        string display = string.IsNullOrWhiteSpace(principal.DisplayName)
            ? principal.Handle
            : principal.DisplayName.Trim();
        if (display.Length == 0 || display.Length > 96)
        {
            throw new ArticleTemplateExpansionException("article_template_expansion_actor_display_invalid");
        }
        return display;
    }

    public async Task<IReadOnlyList<ArticleTemplateAssetPin>> PinAssetsAsync(
        IReadOnlyList<Guid> assetIds,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(assetIds);
        if (assetIds.Count == 0)
        {
            return Array.AsReadOnly(Array.Empty<ArticleTemplateAssetPin>());
        }

        List<ContentAsset> assets = await db.Queryable<ContentAsset>()
            .Where(asset => assetIds.Contains(asset.AssetId))
            .ToListAsync(cancellationToken).ConfigureAwait(false);
        if (assets.Count != assetIds.Distinct().Count())
        {
            throw new ArticleTemplateExpansionException("article_template_asset_reference_stale");
        }

        return Array.AsReadOnly(
            [.. assets
                .OrderBy(static asset => asset.AssetId)
                .Select(static asset => new ArticleTemplateAssetPin(
                    asset.AssetId,
                    asset.State,
                    asset.StorageClass,
                    asset.Sha256,
                    DateTime.SpecifyKind(asset.UpdatedAtUtc, DateTimeKind.Utc)))]);
    }
}
