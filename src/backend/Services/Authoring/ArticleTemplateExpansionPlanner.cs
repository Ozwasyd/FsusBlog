namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Builds immutable expansion plans. Planning re-validates template permission, stable
/// references, and current authority state; it never writes article or draft state and never
/// substitutes references by name.
/// </summary>
public sealed class ArticleTemplateExpansionPlanner(
    IArticleTemplatePersistence persistence,
    IArticleTemplatePermissionAuthority permissionAuthority,
    IArticleTemplateReferenceAuthority referenceAuthority,
    IArticleTemplateExpansionAuthority expansionAuthority,
    TimeProvider timeProvider) : IArticleTemplateExpansionPlanner
{
    internal static readonly TimeSpan s_planTimeToLive = TimeSpan.FromMinutes(15);

    public async Task<ArticleTemplateExpansionPlan> PlanAsync(
        ArticleTemplateExpansionInput input,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(input);

        ArticleTemplateDefinition definition = await persistence.GetAsync(
                input.TemplateId, cancellationToken).ConfigureAwait(false)
            ?? throw new ArticleTemplateNotFoundException();
        if (definition.Status != ArticleTemplateStatus.Active)
        {
            throw new ArticleTemplateAccessDeniedException();
        }
        permissionAuthority.EnsureAllowed(input.Actor, definition.Scope, ArticleTemplatePermission.Use);

        ArticleTemplateVersion version = await persistence.GetVersionAsync(
                input.TemplateId, input.VersionId, cancellationToken).ConfigureAwait(false)
            ?? throw new ArticleTemplateNotFoundException();
        if (version.TemplateId != definition.TemplateId)
        {
            throw new ArticleTemplateIntegrityException("article_template_expansion_version_binding_invalid");
        }

        // Stable references re-validated against current authorities before planning.
        IReadOnlyList<ArticleTemplatePropertyPin> propertyPins = await referenceAuthority
            .ValidateAndPinAsync(input.Actor, definition.Scope, version.Defaults, cancellationToken)
            .ConfigureAwait(false);
        if (!propertyPins.Select(static pin => pin.DefinitionId)
                .SequenceEqual(version.Defaults.PropertyDefaults.Select(static value => value.DefinitionId)))
        {
            throw new ArticleTemplateReferenceException("article_template_property_pins_invalid");
        }
        string actorDisplayName = await expansionAuthority
            .ResolveActorDisplayNameAsync(input.Actor.AdminPrincipalId, cancellationToken)
            .ConfigureAwait(false);
        IReadOnlyList<ArticleTemplateAssetPin> assetPins = await expansionAuthority.PinAssetsAsync(
            [.. version.Defaults.AssetIds.Select(static asset => asset.Value)],
            cancellationToken).ConfigureAwait(false);

        string Resolve(ArticleTemplateVariableToken token)
            => token switch
            {
                ArticleTemplateVariableToken.Title => ArticleTemplateExpansionEngine.EscapeValue(
                    input.Title ?? throw new ArticleTemplateExpansionException("article_template_expansion_title_required")),
                ArticleTemplateVariableToken.Date => ArticleTemplateExpansionEngine.FormatBusinessDate(
                    input.BusinessTimeUtc, input.TimeZoneId),
                ArticleTemplateVariableToken.Author => ArticleTemplateExpansionEngine.EscapeValue(actorDisplayName),
                ArticleTemplateVariableToken.SiteLocale => input.LocaleCode,
                _ => throw new ArticleTemplateValidationException("article_template_variable_unknown")
            };

        byte[] expanded = ArticleTemplateExpansionEngine.Expand(version.Source, Resolve);

        DateTime issued = CanonicalTimestamp();
        ArticleTemplateExpansionDependencies dependencies = new(
            version.Defaults.CategoryId,
            version.Defaults.TagIds,
            assetPins,
            version.Defaults.PropertyDefaults,
            version.Defaults.RightsProfile,
            version.Defaults.ResponsibilityProfile,
            version.Defaults.PrepublishProfile,
            propertyPins);
        return new ArticleTemplateExpansionPlan(
            input,
            version.VersionId,
            version.VersionNumber,
            definition.Revision,
            definition.Scope,
            expanded,
            ComputeSha256(expanded),
            version.Defaults,
            version.DefaultsDigest,
            dependencies,
            Array.Empty<string>(),
            issued,
            issued.Add(s_planTimeToLive));
    }

    internal static string ComputeSha256(byte[] payload)
        => Convert.ToHexStringLower(System.Security.Cryptography.SHA256.HashData(payload));

    private DateTime CanonicalTimestamp()
    {
        DateTime now = timeProvider.GetUtcNow().UtcDateTime;
        return new DateTime(now.Ticks - now.Ticks % TimeSpan.TicksPerMicrosecond, DateTimeKind.Utc);
    }
}
