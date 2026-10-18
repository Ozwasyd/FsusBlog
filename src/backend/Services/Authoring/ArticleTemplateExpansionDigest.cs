using FsusBlog.Shared.Contracts.ArticleProperties;

namespace FsusBlog.Server.Services.Authoring;

public static partial class ArticleTemplateContract
{
    /// <summary>Bounded expanded Markdown source produced by the closed expansion engine.</summary>
    public const int MaxExpandedSourceBytes = MaxSourceBytes + 64 * (MaxNameCharacters + 96) * 4;

    /// <summary>Deterministic pin of every plan-relevant input byte sequence.</summary>
    public static string ComputeExpansionInputDigest(ArticleTemplateExpansionInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        return ComputeDigest(
            input.TemplateId,
            input.VersionId,
            input.Actor.AdminPrincipalId,
            input.Title,
            input.BusinessTimeUtc.UtcTicks,
            input.TimeZoneId,
            input.LocaleCode);
    }

    /// <summary>
    /// Canonical plan digest. IssuedAtUtc/ExpiresAtUtc are issuance metadata and stay outside
    /// the digest so an independent verifier can recompute an identical value from current
    /// authorities; expiry is checked separately against the issuer clock.
    /// </summary>
    public static string ComputeExpansionPlanDigest(ArticleTemplateExpansionPlan plan)
    {
        ArgumentNullException.ThrowIfNull(plan);
        var values = new List<object?>
        {
            SchemaVersion,
            "article-template-typed-definition-pins-v1",
            plan.Input.TemplateId,
            plan.Input.VersionId,
            plan.VersionNumber,
            plan.TemplateRevision,
            (int)plan.Scope.Kind,
            plan.Scope.OwnerAdminPrincipalId,
            plan.Input.Actor.AdminPrincipalId,
            ComputePermissionDigest(plan.Input.Actor),
            ComputeExpansionInputDigest(plan.Input),
            plan.ExpandedSourceDigest,
            plan.DefaultsDigest,
            plan.Warnings.Count
        };
        values.AddRange(plan.Warnings.Cast<object?>());
        ArticleTemplateExpansionDependencies dependencies = plan.Dependencies;
        values.Add(dependencies.CategoryId);
        values.Add(dependencies.TagIds.Count);
        values.AddRange(dependencies.TagIds.Cast<object?>());
        values.Add(dependencies.AssetPins.Count);
        foreach (ArticleTemplateAssetPin pin in dependencies.AssetPins)
        {
            values.Add(pin.AssetId);
            values.Add(pin.State);
            values.Add(pin.StorageClass);
            values.Add(pin.Sha256);
            values.Add(pin.UpdatedAtUtc.Ticks);
        }
        values.Add(dependencies.PropertyDefaults.Count);
        foreach (ArticleTemplatePropertyDefault propertyDefault in dependencies.PropertyDefaults)
        {
            values.Add(propertyDefault.DefinitionId);
            values.Add((int)propertyDefault.ValueKind);
            values.Add(propertyDefault.CanonicalValue);
            values.Add(propertyDefault.OptionIds.Count);
            values.AddRange(propertyDefault.OptionIds.Cast<object?>());
        }
        values.Add(dependencies.PropertyPins.Count);
        foreach (ArticleTemplatePropertyPin pin in dependencies.PropertyPins)
        {
            values.Add(pin.Owner.UserId);
            values.Add(pin.Owner.SiteScope);
            values.Add(pin.DefinitionId);
            values.Add(pin.SchemaRevision);
            values.Add(pin.DefinitionDigest);
            values.Add((int)pin.ValueType);
            values.Add((int)pin.Cardinality);
            values.Add((int)pin.Status);
            values.Add(pin.ConstraintDigest);
            values.Add(pin.OptionsDigest);
            values.Add(pin.PolicyDigest);
            ArticlePropertyValueEntry value = pin.ValidatedValue;
            values.Add(value.DefinitionId);
            values.Add(value.DefinitionSchemaRevision);
            values.Add(value.DefinitionDigest);
            values.Add(value.ValueDigest);
            // Recompute from the typed payload so a supplied value digest cannot hide tamper.
            values.Add(ArticlePropertyValueDigest.ComputeValue(new ArticlePropertyValueInput(
                value.DefinitionId, value.DefinitionSchemaRevision, value.DefinitionDigest,
                value.Presence, value.Value), value.DefaultApplied));
        }
        AppendProfile(values, dependencies.RightsProfile);
        AppendProfile(values, dependencies.ResponsibilityProfile);
        AppendProfile(values, dependencies.PrepublishProfile);
        return ComputeDigest([.. values]);
    }
}
