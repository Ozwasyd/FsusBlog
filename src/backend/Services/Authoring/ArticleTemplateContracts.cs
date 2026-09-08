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
public static class ArticleTemplateContract
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

    internal static void ValidateReceipt(ArticleTemplateWriteReceipt receipt)
    {
        if (receipt.ReceiptId == Guid.Empty
            || receipt.RequestId == Guid.Empty
            || receipt.ActorAdminPrincipalId <= 0
            || receipt.TemplateId == Guid.Empty
            || receipt.ScopeRevision != receipt.PreviousScopeRevision + 1
            || receipt.TemplateRevision != receipt.PreviousTemplateRevision + 1
            || receipt.OccurredAtUtc.Kind != DateTimeKind.Utc
            || receipt.AuditReference == Guid.Empty
            || !Enum.IsDefined(receipt.Permission)
            || !Enum.IsDefined(receipt.Status)
            || !Enum.IsDefined(receipt.DeleteDisposition))
        {
            throw new ArticleTemplateValidationException("article_template_receipt_invalid");
        }
        ValidateDigest(receipt.CommandDigest, receipt.CommandDigest, "article_template_command_digest_invalid");
        ValidateDigest(receipt.PermissionDigest, receipt.PermissionDigest, "article_template_permission_digest_invalid");
        ValidateDigest(receipt.DefinitionDigest, receipt.DefinitionDigest, "article_template_definition_digest_invalid");
        if (receipt.DefaultsDigest.Length != 0)
        {
            ValidateDigest(receipt.DefaultsDigest, receipt.DefaultsDigest, "article_template_defaults_digest_invalid");
        }
        if (receipt.VersionDigest.Length != 0)
        {
            ValidateDigest(receipt.VersionDigest, receipt.VersionDigest, "article_template_version_digest_invalid");
        }
        ValidateDigest(receipt.AuditDigest, ComputeAuditDigest(receipt), "article_template_audit_digest_invalid");
        ValidateDigest(receipt.ContentDigest, ComputeReceiptDigest(receipt), "article_template_receipt_digest_invalid");
    }

    private static void ValidatePropertyDefault(ArticleTemplatePropertyDefault propertyDefault)
    {
        ArgumentNullException.ThrowIfNull(propertyDefault);
        if (propertyDefault.DefinitionId == Guid.Empty || !Enum.IsDefined(propertyDefault.ValueKind))
        {
            throw new ArticleTemplateValidationException("article_template_property_default_identity_invalid");
        }
        if (propertyDefault.OptionIds.Count > MaxOptionsPerPropertyDefault
            || propertyDefault.OptionIds.Any(static id => id == Guid.Empty)
            || propertyDefault.OptionIds.Distinct().Count() != propertyDefault.OptionIds.Count
            || !propertyDefault.OptionIds.SequenceEqual(propertyDefault.OptionIds.Order()))
        {
            throw new ArticleTemplateValidationException("article_template_property_option_defaults_invalid");
        }

        bool select = propertyDefault.ValueKind is ArticleTemplatePropertyValueKind.SingleSelect
            or ArticleTemplatePropertyValueKind.MultiSelect;
        if (select)
        {
            int expectedMinimum = propertyDefault.ValueKind == ArticleTemplatePropertyValueKind.SingleSelect ? 1 : 0;
            int expectedMaximum = propertyDefault.ValueKind == ArticleTemplatePropertyValueKind.SingleSelect ? 1 : MaxOptionsPerPropertyDefault;
            if (propertyDefault.CanonicalValue is not null
                || propertyDefault.OptionIds.Count < expectedMinimum
                || propertyDefault.OptionIds.Count > expectedMaximum)
            {
                throw new ArticleTemplateValidationException("article_template_property_select_default_invalid");
            }
        }
        else if (propertyDefault.OptionIds.Count != 0
            || string.IsNullOrEmpty(propertyDefault.CanonicalValue)
            || propertyDefault.CanonicalValue.Length > MaxPropertyValueCharacters
            || ContainsDisallowedControlCharacter(propertyDefault.CanonicalValue))
        {
            throw new ArticleTemplateValidationException("article_template_property_scalar_default_invalid");
        }
    }

    private static void ValidateOptionalProfile(ArticleTemplateProfileReference? profile, string code)
    {
        if (profile is { ProfileId: var profileId, Revision: var revision }
            && (profileId == Guid.Empty || revision <= 0))
        {
            throw new ArticleTemplateValidationException(code);
        }
    }

    private static void ValidatePositiveDistinctSorted(IReadOnlyList<int> values, int maximum, string code)
    {
        if (values.Count > maximum)
        {
            throw new ArticleTemplateBudgetExceededException(code);
        }
        if (values.Any(static value => value <= 0)
            || values.Distinct().Count() != values.Count
            || !values.SequenceEqual(values.Order()))
        {
            throw new ArticleTemplateValidationException(code);
        }
    }

    private static void ValidateRequiredPlainText(string value, int maximum, string code)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            throw new ArticleTemplateValidationException(code);
        }
        ValidateOptionalPlainText(value, maximum, code);
    }

    private static void ValidateOptionalPlainText(string? value, int maximum, string code)
    {
        if (value is not null
            && (value.Length > maximum || ContainsDisallowedControlCharacter(value)))
        {
            throw new ArticleTemplateValidationException(code);
        }
    }

    private static bool ContainsDisallowedControlCharacter(string value)
        => value.Any(static character => char.IsControl(character)
            && character is not '\n' and not '\r' and not '\t');

    private static bool ContainsAnyOrdinalIgnoreCase(string value, params string[] needles)
        => needles.Any(needle => value.Contains(needle, StringComparison.OrdinalIgnoreCase));

    private static void ValidateUtcTimeline(DateTime createdAtUtc, DateTime updatedAtUtc)
    {
        if (createdAtUtc.Kind != DateTimeKind.Utc
            || updatedAtUtc.Kind != DateTimeKind.Utc
            || updatedAtUtc < createdAtUtc)
        {
            throw new ArticleTemplateValidationException("article_template_timestamp_invalid");
        }
    }

    private static void ValidateDigest(string actual, string expected, string code)
    {
        if (actual.Length != 64
            || actual.Any(static character => !Uri.IsHexDigit(character) || char.IsUpper(character))
            || !CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(actual),
                Encoding.ASCII.GetBytes(expected)))
        {
            throw new ArticleTemplateValidationException(code);
        }
    }

    private static void AppendProfile(List<object?> values, ArticleTemplateProfileReference? profile)
    {
        values.Add(profile?.ProfileId);
        values.Add(profile?.Revision);
    }

    private static string ComputeDigest(params object?[] values)
    {
        using IncrementalHash hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        Span<byte> length = stackalloc byte[4];
        foreach (object? value in values)
        {
            byte[] bytes = value switch
            {
                null => [],
                byte[] raw => raw,
                Guid guid => guid.ToByteArray(),
                DateTime dateTime => Encoding.UTF8.GetBytes(dateTime.ToUniversalTime().Ticks.ToString(CultureInfo.InvariantCulture)),
                IFormattable formattable => Encoding.UTF8.GetBytes(formattable.ToString(null, CultureInfo.InvariantCulture) ?? string.Empty),
                _ => Encoding.UTF8.GetBytes(value.ToString() ?? string.Empty)
            };
            System.Buffers.Binary.BinaryPrimitives.WriteInt32LittleEndian(length, bytes.Length);
            hash.AppendData(length);
            hash.AppendData(bytes);
        }
        return Convert.ToHexStringLower(hash.GetHashAndReset());
    }
}

public enum ArticleTemplateScopeKind : short
{
    Personal = 0,
    Site = 1
}

public enum ArticleTemplateStatus : short
{
    Active = 0,
    Retired = 1,
    Deleted = 2
}

public enum ArticleTemplatePermission : short
{
    Read = 0,
    Use = 1,
    Manage = 2
}

public enum ArticleTemplateVariableToken : short
{
    Title = 0,
    Date = 1,
    Author = 2,
    SiteLocale = 3
}

public enum ArticleTemplatePropertyValueKind : short
{
    Text = 0,
    Number = 1,
    Boolean = 2,
    Date = 3,
    SingleSelect = 4,
    MultiSelect = 5,
    ArticleReference = 6,
    Url = 7
}

public enum ArticleTemplateDeleteDisposition : short
{
    NotApplicable = 0,
    TombstonedHistoryPreserved = 1
}

public readonly record struct ArticleTemplateScope(
    ArticleTemplateScopeKind Kind,
    long? OwnerAdminPrincipalId);

public sealed record ArticleTemplateActor
{
    private readonly IReadOnlySet<string> _permissions;

    public ArticleTemplateActor(long adminPrincipalId, IEnumerable<string> permissions)
    {
        ArgumentNullException.ThrowIfNull(permissions);
        AdminPrincipalId = adminPrincipalId;
        _permissions = new HashSet<string>(permissions, StringComparer.Ordinal);
        ArticleTemplateContract.ValidateActor(this);
    }

    public long AdminPrincipalId
    {
        get;
    }
    public IReadOnlySet<string> Permissions => _permissions;
}

public sealed class ArticleTemplateSource
{
    private readonly byte[] _bytes;

    private ArticleTemplateSource(byte[] bytes, IReadOnlyList<ArticleTemplateVariableToken> tokens)
    {
        _bytes = bytes;
        VariableTokens = tokens;
    }

    public IReadOnlyList<ArticleTemplateVariableToken> VariableTokens
    {
        get;
    }
    public int Length => _bytes.Length;

    public static ArticleTemplateSource FromUtf8(string source)
    {
        ArgumentNullException.ThrowIfNull(source);
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(source);
        var result = new ArticleTemplateSource(
            bytes,
            ArticleTemplateContract.ParseVariableTokens(source));
        ArticleTemplateContract.ValidateSource(result);
        return result;
    }

    public static ArticleTemplateSource FromBytes(ReadOnlySpan<byte> source)
    {
        byte[] bytes = source.ToArray();
        string text;
        try
        {
            text = new UTF8Encoding(false, true).GetString(bytes);
        }
        catch (DecoderFallbackException)
        {
            throw new ArticleTemplateValidationException("article_template_source_utf8_invalid");
        }
        var result = new ArticleTemplateSource(
            bytes,
            ArticleTemplateContract.ParseVariableTokens(text));
        ArticleTemplateContract.ValidateSource(result);
        return result;
    }

    public ReadOnlySpan<byte> AsSpan() => _bytes;
    public byte[] ToArray() => [.. _bytes];
    public string GetText() => new UTF8Encoding(false, true).GetString(_bytes);
}

public sealed class ArticleTemplatePropertyDefault
{
    public ArticleTemplatePropertyDefault(
        Guid definitionId,
        ArticleTemplatePropertyValueKind valueKind,
        string? canonicalValue,
        IEnumerable<Guid>? optionIds = null)
    {
        DefinitionId = definitionId;
        ValueKind = valueKind;
        CanonicalValue = canonicalValue;
        OptionIds = Array.AsReadOnly(
            (optionIds ?? []).Distinct().Order().ToArray());
    }

    public Guid DefinitionId
    {
        get;
    }
    public ArticleTemplatePropertyValueKind ValueKind
    {
        get;
    }
    public string? CanonicalValue
    {
        get;
    }
    public IReadOnlyList<Guid> OptionIds
    {
        get;
    }
}

public readonly record struct ArticleTemplateProfileReference(Guid ProfileId, long Revision);

public sealed class ArticleTemplateDefaults
{
    public ArticleTemplateDefaults(
        string? titlePlaceholder = null,
        string? summaryPlaceholder = null,
        int? categoryId = null,
        IEnumerable<int>? tagIds = null,
        IEnumerable<ArticleTemplatePropertyDefault>? propertyDefaults = null,
        IEnumerable<AssetId>? assetIds = null,
        ArticleTemplateProfileReference? rightsProfile = null,
        ArticleTemplateProfileReference? responsibilityProfile = null,
        ArticleTemplateProfileReference? prepublishProfile = null)
    {
        TitlePlaceholder = titlePlaceholder;
        SummaryPlaceholder = summaryPlaceholder;
        CategoryId = categoryId;
        TagIds = Array.AsReadOnly((tagIds ?? []).Distinct().Order().ToArray());
        PropertyDefaults = Array.AsReadOnly(
            (propertyDefaults ?? []).OrderBy(static item => item.DefinitionId).ToArray());
        AssetIds = Array.AsReadOnly(
            (assetIds ?? []).Distinct().OrderBy(static item => item.Value).ToArray());
        RightsProfile = rightsProfile;
        ResponsibilityProfile = responsibilityProfile;
        PrepublishProfile = prepublishProfile;
        ArticleTemplateContract.ValidateDefaults(this);
    }

    public string? TitlePlaceholder
    {
        get;
    }
    public string? SummaryPlaceholder
    {
        get;
    }
    public int? CategoryId
    {
        get;
    }
    public IReadOnlyList<int> TagIds
    {
        get;
    }
    public IReadOnlyList<ArticleTemplatePropertyDefault> PropertyDefaults
    {
        get;
    }
    public IReadOnlyList<AssetId> AssetIds
    {
        get;
    }
    public ArticleTemplateProfileReference? RightsProfile
    {
        get;
    }
    public ArticleTemplateProfileReference? ResponsibilityProfile
    {
        get;
    }
    public ArticleTemplateProfileReference? PrepublishProfile
    {
        get;
    }
}

public sealed record ArticleTemplateDefinition(
    int SchemaVersion,
    Guid TemplateId,
    ArticleTemplateScope Scope,
    string Name,
    string NameKey,
    string? Description,
    ArticleTemplateStatus Status,
    long Revision,
    Guid CurrentVersionId,
    int CurrentVersionNumber,
    DateTime CreatedAtUtc,
    DateTime UpdatedAtUtc,
    string ContentDigest);

public sealed record ArticleTemplateVersion(
    int SchemaVersion,
    Guid TemplateId,
    Guid VersionId,
    int VersionNumber,
    long CreatedByAdminPrincipalId,
    DateTime CreatedAtUtc,
    ArticleTemplateSource Source,
    ArticleTemplateDefaults Defaults,
    string DefaultsDigest,
    string ContentDigest);

public sealed record ArticleTemplatePageCursor(string NameKey, Guid TemplateId);

public sealed record ArticleTemplatePage(
    IReadOnlyList<ArticleTemplateDefinition> Items,
    ArticleTemplatePageCursor? NextCursor,
    long ScopeRevision);

public sealed record ArticleTemplateVersionPage(
    IReadOnlyList<ArticleTemplateVersion> Items,
    int? NextVersionNumber);

public sealed record ArticleTemplateWriteReceipt(
    Guid ReceiptId,
    Guid RequestId,
    long ActorAdminPrincipalId,
    string CommandKind,
    string CommandDigest,
    Guid TemplateId,
    Guid? VersionId,
    int? VersionNumber,
    ArticleTemplateScope Scope,
    long PreviousScopeRevision,
    long ScopeRevision,
    long PreviousTemplateRevision,
    long TemplateRevision,
    ArticleTemplatePermission Permission,
    string PermissionDigest,
    string DefaultsDigest,
    ArticleTemplateStatus Status,
    string DefinitionDigest,
    string VersionDigest,
    ArticleTemplateDeleteDisposition DeleteDisposition,
    DateTime OccurredAtUtc,
    Guid AuditReference,
    string AuditDigest,
    string ContentDigest,
    bool IsIdempotentReplay = false);

public sealed record CreateArticleTemplateCommand(
    ArticleTemplateActor Actor,
    ArticleTemplateScope Scope,
    Guid TemplateId,
    Guid VersionId,
    Guid RequestId,
    long ExpectedScopeRevision,
    string Name,
    string? Description,
    ArticleTemplateSource Source,
    ArticleTemplateDefaults Defaults);

public sealed record CreateArticleTemplateVersionCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid VersionId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision,
    int ExpectedCurrentVersionNumber,
    ArticleTemplateSource Source,
    ArticleTemplateDefaults Defaults);

public sealed record RenameArticleTemplateCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision,
    string Name,
    string? Description);

public sealed record RetireArticleTemplateCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision);

public sealed record DeleteArticleTemplateCommand(
    ArticleTemplateActor Actor,
    Guid TemplateId,
    Guid RequestId,
    long ExpectedScopeRevision,
    long ExpectedTemplateRevision);

public sealed class ArticleTemplateValidationException(string code) : ArgumentException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleTemplateAccessDeniedException() : UnauthorizedAccessException("article_template_access_denied");

public sealed class ArticleTemplateNotFoundException() : KeyNotFoundException("article_template_not_found");

public sealed class ArticleTemplateConflictException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleTemplateBudgetExceededException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}

public sealed class ArticleTemplateReferenceException(string code) : InvalidOperationException(code)
{
    public string Code { get; } = code;
}
