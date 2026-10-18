using System.Globalization;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Services.Authoring;

public static partial class ArticleTemplateContract
{
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
        else if (propertyDefault.ValueKind == ArticleTemplatePropertyValueKind.ArticleReference)
        {
            // This representation declares only an empty set. A string is never interpreted as IDs.
            if (propertyDefault.CanonicalValue is not null || propertyDefault.OptionIds.Count != 0)
            {
                throw new ArticleTemplateReferenceException("article_template_property_reference_source_identity_unavailable");
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
