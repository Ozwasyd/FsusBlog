using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

using FsusBlog.Server.Contracts.Assets;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Closed storage and validation contract for the one article-template authority.
/// This contract stores source and defaults only; it does not expand variables or create articles.
/// </summary>
public static partial class ArticleTemplateContract
{
    public const int SchemaVersion = 1;
    public const int MaxTemplatesPerScope = 1_000;
    public const int MaxVersionsPerTemplate = 1_000;
    public const int MaxPageSize = 100;
    public const int MaxNameCharacters = 128;
    public const int MaxDescriptionCharacters = 1_024;
    public const int MaxPlaceholderCharacters = 512;
    public const int MaxSourceBytes = 256 * 1_024;
    public const int MaxVariableOccurrences = 64;
    public const int MaxTags = 64;
    public const int MaxPropertyDefaults = 64;
    public const int MaxOptionsPerPropertyDefault = 64;
    public const int MaxAssets = 64;
    public const int MaxPropertyValueCharacters = 2_048;
    public const int MaxVerificationReceipts = 10_000;

    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private static readonly Regex s_rawHtml = new(
        @"<\s*/?\s*[A-Za-z][^>]*>",
        RegexOptions.CultureInvariant | RegexOptions.Compiled,
        TimeSpan.FromMilliseconds(100));

    public static ArticleTemplateScope PersonalScope(long ownerAdminPrincipalId)
        => new(ArticleTemplateScopeKind.Personal, ownerAdminPrincipalId);

    public static ArticleTemplateScope SiteScope()
        => new(ArticleTemplateScopeKind.Site, null);

    public static void ValidateActor(ArticleTemplateActor actor)
    {
        ArgumentNullException.ThrowIfNull(actor);
        if (actor.AdminPrincipalId <= 0 || actor.Permissions.Count > 64)
        {
            throw new ArticleTemplateAccessDeniedException();
        }

        foreach (string permission in actor.Permissions)
        {
            ValidateRequiredPlainText(permission, 128, "article_template_actor_permission_invalid");
        }
    }

    public static void ValidateScope(ArticleTemplateScope scope)
    {
        if (!Enum.IsDefined(scope.Kind))
        {
            throw new ArticleTemplateValidationException("article_template_scope_unknown");
        }

        bool valid = scope.Kind switch
        {
            ArticleTemplateScopeKind.Personal => scope.OwnerAdminPrincipalId is > 0,
            ArticleTemplateScopeKind.Site => scope.OwnerAdminPrincipalId is null,
            _ => false
        };
        if (!valid)
        {
            throw new ArticleTemplateValidationException("article_template_scope_owner_invalid");
        }
    }

    public static void ValidateDefinition(ArticleTemplateDefinition definition)
    {
        ArgumentNullException.ThrowIfNull(definition);
        if (definition.SchemaVersion != SchemaVersion)
        {
            throw new ArticleTemplateValidationException("article_template_schema_version_unknown");
        }
        if (definition.TemplateId == Guid.Empty
            || definition.CurrentVersionId == Guid.Empty
            || definition.CurrentVersionNumber is <= 0 or > MaxVersionsPerTemplate
            || definition.Revision <= 0)
        {
            throw new ArticleTemplateValidationException("article_template_definition_identity_invalid");
        }

        ValidateScope(definition.Scope);
        ValidateRequiredPlainText(definition.Name, MaxNameCharacters, "article_template_name_invalid");
        ValidateOptionalPlainText(definition.Description, MaxDescriptionCharacters, "article_template_description_invalid");
        if (!string.Equals(definition.NameKey, NormalizeNameKey(definition.Name), StringComparison.Ordinal))
        {
            throw new ArticleTemplateValidationException("article_template_name_key_invalid");
        }
        if (!Enum.IsDefined(definition.Status))
        {
            throw new ArticleTemplateValidationException("article_template_status_unknown");
        }
        ValidateUtcTimeline(definition.CreatedAtUtc, definition.UpdatedAtUtc);
        ValidateDigest(definition.ContentDigest, ComputeDefinitionDigest(definition), "article_template_definition_digest_invalid");
    }

    public static void ValidateVersion(ArticleTemplateVersion version)
    {
        ArgumentNullException.ThrowIfNull(version);
        if (version.SchemaVersion != SchemaVersion)
        {
            throw new ArticleTemplateValidationException("article_template_version_schema_unknown");
        }
        if (version.TemplateId == Guid.Empty
            || version.VersionId == Guid.Empty
            || version.VersionNumber is <= 0 or > MaxVersionsPerTemplate
            || version.CreatedByAdminPrincipalId <= 0)
        {
            throw new ArticleTemplateValidationException("article_template_version_identity_invalid");
        }
        if (version.CreatedAtUtc.Kind != DateTimeKind.Utc)
        {
            throw new ArticleTemplateValidationException("article_template_timestamp_not_utc");
        }

        ValidateSource(version.Source);
        ValidateDefaults(version.Defaults);
        ValidateDigest(version.DefaultsDigest, ComputeDefaultsDigest(version.Defaults), "article_template_defaults_digest_invalid");
        ValidateDigest(version.ContentDigest, ComputeVersionDigest(version), "article_template_version_digest_invalid");
    }

    public static void ValidateSource(ArticleTemplateSource source)
    {
        ArgumentNullException.ThrowIfNull(source);
        ReadOnlySpan<byte> bytes = source.AsSpan();
        if (bytes.Length > MaxSourceBytes)
        {
            throw new ArticleTemplateBudgetExceededException("article_template_source_budget_exceeded");
        }

        string text;
        try
        {
            text = s_strictUtf8.GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw new ArticleTemplateValidationException("article_template_source_utf8_invalid");
        }
        if (text.IndexOf('\0') >= 0)
        {
            throw new ArticleTemplateValidationException("article_template_source_control_character");
        }
        if (s_rawHtml.IsMatch(text))
        {
            throw new ArticleTemplateValidationException("article_template_html_authority_forbidden");
        }
        if (ContainsAnyOrdinalIgnoreCase(
                text,
                "javascript:",
                "data:text/html",
                "{%",
                "%}",
                "${",
                "{{>",
                "!include",
                "remote-include",
                "remote_include"))
        {
            throw new ArticleTemplateValidationException("article_template_dynamic_source_forbidden");
        }

        IReadOnlyList<ArticleTemplateVariableToken> parsed = ParseVariableTokens(text);
        if (parsed.Count > MaxVariableOccurrences)
        {
            throw new ArticleTemplateBudgetExceededException("article_template_variable_budget_exceeded");
        }
        if (!parsed.SequenceEqual(source.VariableTokens))
        {
            throw new ArticleTemplateValidationException("article_template_variable_projection_invalid");
        }
    }

    public static void ValidateDefaults(ArticleTemplateDefaults defaults)
    {
        ArgumentNullException.ThrowIfNull(defaults);
        ValidateOptionalPlainText(defaults.TitlePlaceholder, MaxPlaceholderCharacters, "article_template_title_default_invalid");
        ValidateOptionalPlainText(defaults.SummaryPlaceholder, MaxPlaceholderCharacters, "article_template_summary_default_invalid");
        if (defaults.CategoryId is <= 0)
        {
            throw new ArticleTemplateValidationException("article_template_category_id_invalid");
        }
        ValidatePositiveDistinctSorted(defaults.TagIds, MaxTags, "article_template_tag_defaults_invalid");

        if (defaults.PropertyDefaults.Count > MaxPropertyDefaults)
        {
            throw new ArticleTemplateBudgetExceededException("article_template_property_default_budget_exceeded");
        }
        var propertyIds = new HashSet<Guid>();
        foreach (ArticleTemplatePropertyDefault propertyDefault in defaults.PropertyDefaults)
        {
            ValidatePropertyDefault(propertyDefault);
            if (!propertyIds.Add(propertyDefault.DefinitionId))
            {
                throw new ArticleTemplateValidationException("article_template_property_default_duplicate");
            }
        }
        if (!defaults.PropertyDefaults.SequenceEqual(
                defaults.PropertyDefaults.OrderBy(static item => item.DefinitionId)))
        {
            throw new ArticleTemplateValidationException("article_template_property_defaults_not_canonical");
        }

        if (defaults.AssetIds.Count > MaxAssets)
        {
            throw new ArticleTemplateBudgetExceededException("article_template_asset_budget_exceeded");
        }
        Guid[] assetIds = [.. defaults.AssetIds.Select(static item => item.Value)];
        if (assetIds.Any(static value => value == Guid.Empty)
            || assetIds.Distinct().Count() != assetIds.Length
            || !assetIds.SequenceEqual(assetIds.Order()))
        {
            throw new ArticleTemplateValidationException("article_template_asset_defaults_invalid");
        }

        ValidateOptionalProfile(defaults.RightsProfile, "article_template_rights_profile_invalid");
        ValidateOptionalProfile(defaults.ResponsibilityProfile, "article_template_responsibility_profile_invalid");
        ValidateOptionalProfile(defaults.PrepublishProfile, "article_template_prepublish_profile_invalid");
    }

    public static IReadOnlyList<ArticleTemplateVariableToken> ParseVariableTokens(string text)
    {
        ArgumentNullException.ThrowIfNull(text);
        var result = new List<ArticleTemplateVariableToken>();
        int offset = 0;
        while (offset < text.Length)
        {
            int open = text.IndexOf("{{", offset, StringComparison.Ordinal);
            int unexpectedClose = text.IndexOf("}}", offset, StringComparison.Ordinal);
            if (unexpectedClose >= 0 && (open < 0 || unexpectedClose < open))
            {
                throw new ArticleTemplateValidationException("article_template_variable_syntax_invalid");
            }
            if (open < 0)
            {
                break;
            }
            if (open + 2 < text.Length && text[open + 2] == '{')
            {
                throw new ArticleTemplateValidationException("article_template_expression_forbidden");
            }
            int close = text.IndexOf("}}", open + 2, StringComparison.Ordinal);
            if (close < 0 || (close + 2 < text.Length && text[close + 2] == '}'))
            {
                throw new ArticleTemplateValidationException("article_template_variable_syntax_invalid");
            }
            string tokenName = text[(open + 2)..close].Trim();
            result.Add(tokenName switch
            {
                "title" => ArticleTemplateVariableToken.Title,
                "date" => ArticleTemplateVariableToken.Date,
                "author" => ArticleTemplateVariableToken.Author,
                "site_locale" => ArticleTemplateVariableToken.SiteLocale,
                _ => throw new ArticleTemplateValidationException("article_template_variable_unknown")
            });
            offset = close + 2;
        }
        return Array.AsReadOnly(result.ToArray());
    }

    public static string NormalizeName(string name)
    {
        ArgumentNullException.ThrowIfNull(name);
        string normalized = name.Trim().Normalize(NormalizationForm.FormC);
        ValidateRequiredPlainText(normalized, MaxNameCharacters, "article_template_name_invalid");
        return normalized;
    }

    public static string NormalizeNameKey(string name)
        => NormalizeName(name).ToUpperInvariant();

    public static string? NormalizeDescription(string? description)
    {
        if (description is null)
        {
            return null;
        }
        string normalized = description.Trim().Normalize(NormalizationForm.FormC);
        ValidateOptionalPlainText(normalized, MaxDescriptionCharacters, "article_template_description_invalid");
        return normalized.Length == 0 ? null : normalized;
    }

    public static string ComputeDefinitionDigest(ArticleTemplateDefinition definition)
        => ComputeDigest(
            definition.SchemaVersion,
            definition.TemplateId,
            (int)definition.Scope.Kind,
            definition.Scope.OwnerAdminPrincipalId,
            definition.Name,
            definition.NameKey,
            definition.Description,
            (int)definition.Status,
            definition.Revision,
            definition.CurrentVersionId,
            definition.CurrentVersionNumber,
            definition.CreatedAtUtc.Ticks,
            definition.UpdatedAtUtc.Ticks);

    public static string ComputeDefaultsDigest(ArticleTemplateDefaults defaults)
    {
        var values = new List<object?>
        {
            SchemaVersion,
            defaults.TitlePlaceholder,
            defaults.SummaryPlaceholder,
            defaults.CategoryId,
            defaults.TagIds.Count
        };
        values.AddRange(defaults.TagIds.Cast<object?>());
        values.Add(defaults.PropertyDefaults.Count);
        foreach (ArticleTemplatePropertyDefault propertyDefault in defaults.PropertyDefaults)
        {
            values.Add(propertyDefault.DefinitionId);
            values.Add((int)propertyDefault.ValueKind);
            values.Add(propertyDefault.CanonicalValue);
            values.Add(propertyDefault.OptionIds.Count);
            values.AddRange(propertyDefault.OptionIds.Cast<object?>());
        }
        values.Add(defaults.AssetIds.Count);
        values.AddRange(defaults.AssetIds.Select(static asset => (object?)asset.Value));
        AppendProfile(values, defaults.RightsProfile);
        AppendProfile(values, defaults.ResponsibilityProfile);
        AppendProfile(values, defaults.PrepublishProfile);
        return ComputeDigest([.. values]);
    }

    public static string ComputeVersionDigest(ArticleTemplateVersion version)
        => ComputeDigest(
            version.SchemaVersion,
            version.TemplateId,
            version.VersionId,
            version.VersionNumber,
            version.CreatedByAdminPrincipalId,
            version.CreatedAtUtc.Ticks,
            version.Source.ToArray(),
            version.DefaultsDigest);

    public static string ComputePermissionDigest(ArticleTemplateActor actor)
        => ComputeDigest(
            actor.AdminPrincipalId,
            actor.Permissions.Count,
            string.Join('\n', actor.Permissions.Order(StringComparer.Ordinal)));

    public static string ComputeCommandDigest(params object?[] values)
        => ComputeDigest(values);

    public static string ComputeReceiptDigest(ArticleTemplateWriteReceipt receipt)
        => ComputeDigest(
            receipt.ReceiptId,
            receipt.RequestId,
            receipt.ActorAdminPrincipalId,
            receipt.CommandKind,
            receipt.CommandDigest,
            receipt.TemplateId,
            receipt.VersionId,
            receipt.VersionNumber,
            (int)receipt.Scope.Kind,
            receipt.Scope.OwnerAdminPrincipalId,
            receipt.PreviousScopeRevision,
            receipt.ScopeRevision,
            receipt.PreviousTemplateRevision,
            receipt.TemplateRevision,
            (int)receipt.Permission,
            receipt.PermissionDigest,
            receipt.DefaultsDigest,
            (int)receipt.Status,
            receipt.DefinitionDigest,
            receipt.VersionDigest,
            (int)receipt.DeleteDisposition,
            receipt.OccurredAtUtc.Ticks,
            receipt.AuditReference,
            receipt.AuditDigest);

    public static string ComputeAuditDigest(ArticleTemplateWriteReceipt receipt)
        => ComputeDigest(
            receipt.AuditReference,
            receipt.RequestId,
            receipt.ActorAdminPrincipalId,
            receipt.CommandKind,
            receipt.CommandDigest,
            receipt.TemplateId,
            receipt.VersionId,
            receipt.VersionNumber,
            (int)receipt.Scope.Kind,
            receipt.Scope.OwnerAdminPrincipalId,
            receipt.PreviousScopeRevision,
            receipt.ScopeRevision,
            receipt.PreviousTemplateRevision,
            receipt.TemplateRevision,
            (int)receipt.Status,
            receipt.DefinitionDigest,
            receipt.VersionDigest,
            (int)receipt.DeleteDisposition,
            receipt.OccurredAtUtc.Ticks);

}
