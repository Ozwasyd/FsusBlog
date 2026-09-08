using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Resolves only references owned by current production authorities. Property and reusable
/// policy-profile references remain fail-closed until their declared owners exist.
/// </summary>
public sealed class PostgresArticleTemplateReferenceAuthority(ISqlSugarClient db)
    : IArticleTemplateReferenceAuthority
{
    public async Task ValidateAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplateDefaults defaults,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateActor(actor);
        ArticleTemplateContract.ValidateScope(scope);
        ArticleTemplateContract.ValidateDefaults(defaults);
        cancellationToken.ThrowIfCancellationRequested();

        if (defaults.PropertyDefaults.Count != 0)
        {
            throw new ArticleTemplateReferenceException("article_template_property_authority_unavailable");
        }
        if (defaults.RightsProfile is not null)
        {
            throw new ArticleTemplateReferenceException("article_template_rights_profile_authority_unavailable");
        }
        if (defaults.ResponsibilityProfile is not null)
        {
            throw new ArticleTemplateReferenceException("article_template_responsibility_profile_authority_unavailable");
        }
        if (defaults.PrepublishProfile is not null)
        {
            throw new ArticleTemplateReferenceException("article_template_prepublish_profile_authority_unavailable");
        }

        if (defaults.CategoryId is int categoryId)
        {
            bool categoryExists = await db.Queryable<Category>()
                .Where(category => category.Id == categoryId)
                .AnyAsync(cancellationToken).ConfigureAwait(false);
            if (!categoryExists)
            {
                throw new ArticleTemplateReferenceException("article_template_category_reference_stale");
            }
        }

        if (defaults.TagIds.Count != 0)
        {
            int[] tagIds = [.. defaults.TagIds];
            List<int> existing = await db.Queryable<Tag>()
                .Where(tag => tagIds.Contains(tag.Id))
                .Select(static tag => tag.Id)
                .ToListAsync(cancellationToken).ConfigureAwait(false);
            if (!tagIds.SequenceEqual(existing.Distinct().Order()))
            {
                throw new ArticleTemplateReferenceException("article_template_tag_reference_stale");
            }
        }

        if (defaults.AssetIds.Count != 0)
        {
            Guid[] assetIds = [.. defaults.AssetIds.Select(static asset => asset.Value)];
            List<ContentAsset> assets = await db.Queryable<ContentAsset>()
                .Where(asset => assetIds.Contains(asset.AssetId))
                .ToListAsync(cancellationToken).ConfigureAwait(false);
            if (assets.Count != assetIds.Length)
            {
                throw new ArticleTemplateReferenceException("article_template_asset_reference_stale");
            }

            bool canManageSite = actor.Permissions.Contains(AdminPermissions.SystemConfig);
            foreach (ContentAsset asset in assets)
            {
                bool reusable = string.Equals(asset.State, ContentAssetStates.Active, StringComparison.Ordinal)
                    && string.Equals(asset.StorageClass, "public", StringComparison.Ordinal)
                    && (asset.OwnerAdminPrincipalId is null
                        || asset.OwnerAdminPrincipalId == actor.AdminPrincipalId
                        || canManageSite);
                if (!reusable)
                {
                    throw new ArticleTemplateReferenceException("article_template_asset_reference_not_reusable");
                }
            }
        }
    }
}
