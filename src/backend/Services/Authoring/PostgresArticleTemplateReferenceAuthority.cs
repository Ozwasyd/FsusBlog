using FsusBlog.Server.Contracts.Assets;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Shared.Contracts.ArticleProperties;

using SqlSugar;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Resolves references through their current owners. The host must supply the explicit property
/// owner and canonical validator; absent context and reusable policy profiles remain fail-closed.
/// </summary>
public sealed class PostgresArticleTemplateReferenceAuthority(
    ISqlSugarClient db,
    IArticlePropertyDefinitionStore? propertyDefinitions = null,
    ArticlePropertyValueValidator? propertyValues = null,
    ArticlePropertyDefinitionOwner? propertyOwner = null)
    : IArticleTemplateReferenceAuthority
{
    public async Task ValidateAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplateDefaults defaults,
        CancellationToken cancellationToken = default)
        => _ = await ValidateAndPinAsync(actor, scope, defaults, cancellationToken).ConfigureAwait(false);

    public async Task<IReadOnlyList<ArticleTemplatePropertyPin>> ValidateAndPinAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        ArticleTemplateDefaults defaults,
        CancellationToken cancellationToken = default)
    {
        ArticleTemplateContract.ValidateActor(actor);
        ArticleTemplateContract.ValidateScope(scope);
        ArticleTemplateContract.ValidateDefaults(defaults);
        cancellationToken.ThrowIfCancellationRequested();

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
        return await ValidatePropertiesAsync(actor, scope, defaults.PropertyDefaults, cancellationToken)
            .ConfigureAwait(false);
    }

    private async Task<IReadOnlyList<ArticleTemplatePropertyPin>> ValidatePropertiesAsync(
        ArticleTemplateActor actor,
        ArticleTemplateScope scope,
        IReadOnlyList<ArticleTemplatePropertyDefault> defaults,
        CancellationToken cancellationToken)
    {
        if (defaults.Count == 0)
        {
            return Array.Empty<ArticleTemplatePropertyPin>();
        }
        if (propertyDefinitions is null || propertyValues is null || propertyOwner is not { } owner)
        {
            throw new ArticleTemplateReferenceException("article_template_property_authority_unavailable");
        }
        if (owner.UserId != scope.OwnerAdminPrincipalId)
        {
            throw new ArticleTemplateReferenceException("article_template_property_owner_scope_mismatch");
        }
        try
        {
            var propertyActor = new ArticlePropertyDefinitionActor(actor.AdminPrincipalId, actor.Permissions);
            IReadOnlyList<ArticlePropertyDefinition> definitions = await propertyDefinitions.GetManyAsync(
                propertyActor, owner, defaults.Select(static value => value.DefinitionId).ToArray(), cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (!definitions.Select(static definition => definition.DefinitionId).Order()
                    .SequenceEqual(defaults.Select(static value => value.DefinitionId)))
            {
                throw new ArticleTemplateReferenceException("article_template_property_definition_unavailable");
            }
            var byId = definitions.ToDictionary(static definition => definition.DefinitionId);
            var inputs = new List<ArticlePropertyValueInput>(defaults.Count);
            foreach (ArticleTemplatePropertyDefault value in defaults)
            {
                ArticlePropertyDefinition definition = byId[value.DefinitionId];
                ArticlePropertyDefinitionContract.ValidateDefinition(definition);
                if (definition.Owner != owner || definition.Status != ArticlePropertyDefinitionStatus.Active
                    || (int)definition.ValueType != (int)value.ValueKind)
                {
                    throw new ArticleTemplateReferenceException("article_template_property_definition_stale_or_mismatched");
                }
                ArticlePropertyDefaultValue payload = definition.ValueType switch
                {
                    ArticlePropertyValueType.SingleSelect or ArticlePropertyValueType.MultiSelect =>
                        new(ArticlePropertyDefaultKind.OptionIds, OptionIds: value.OptionIds),
                    ArticlePropertyValueType.ArticleReference =>
                        new(ArticlePropertyDefaultKind.ArticleIds, ArticleIds: Array.Empty<long>()),
                    _ => new(ArticlePropertyDefaultKind.Scalar, Scalar: value.CanonicalValue)
                };
                // Reuse the definition owner's canonical shape/constraints and the validator's
                // existing conversion. No template-specific scalar or reference parser exists.
                ArticlePropertyDefinitionContract.ValidateArticleValuePayload(definition, payload);
                inputs.Add(new ArticlePropertyValueInput(definition.DefinitionId, definition.SchemaRevision,
                    definition.ContentDigest, ArticlePropertyValuePresence.Present,
                    ArticlePropertyValueValidator.FromPayload(definition.ValueType, payload)));
            }
            IReadOnlyList<ArticlePropertyValueEntry> values = await propertyValues.ValidateInputsAsync(
                propertyActor, owner, inputs, cancellationToken).ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            return Array.AsReadOnly(values.Select(value =>
            {
                ArticlePropertyDefinition definition = byId[value.DefinitionId];
                return new ArticleTemplatePropertyPin(owner, definition.DefinitionId, definition.SchemaRevision,
                    definition.ContentDigest, definition.ValueType, definition.Cardinality, definition.Status,
                    ArticlePropertyDefinitionContract.ComputeConstraintDigest(definition.Constraints),
                    ArticlePropertyDefinitionContract.ComputeOptionsDigest(definition.Options),
                    ArticlePropertyDefinitionContract.ComputePolicyDigest(definition.ReferencePolicy, definition.UrlPolicy),
                    value);
            }).ToArray());
        }
        catch (ArticlePropertyDefinitionAccessDeniedException)
        {
            throw new ArticleTemplateAccessDeniedException();
        }
        catch (ArticlePropertyDefinitionValidationException)
        {
            throw new ArticleTemplateReferenceException("article_template_property_default_invalid_or_stale");
        }
        catch (ArticlePropertyDefinitionIntegrityException)
        {
            throw new ArticleTemplateReferenceException("article_template_property_definition_integrity_invalid");
        }
    }
}
