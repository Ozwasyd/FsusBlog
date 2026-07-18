using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Core.Common;

namespace FsusBlog.Core.Integrity;

public sealed record ArticleRightsCanonicalInput(
    int ArticleId,
    long ArticleRevisionId,
    int RevisionNo,
    string LicenseType,
    string? CopyrightHolder,
    int? CopyrightYear,
    string? RightsStatement,
    string? AttributionTemplate,
    string CopyPolicy,
    int MaxExcerptChars,
    bool AllowCodeCopy,
    bool ShowPublicBadge,
    string? CanonicalUrl,
    string ContentCanonicalHash);

public sealed record ArticleRightsAttributionValues(
    string Title,
    string Url,
    string Holder,
    string Year,
    string License,
    string Proof);

public static class ArticleRightsCanonicalHashV1
{
    public const int HashVersion = 1;
    public const string DomainSeparator = "fsusblog.rights.article-policy.v1";
    public const string HashAlgorithm = "sha256";

    public static string ComputeHashHex(ArticleRightsCanonicalInput input)
    {
        byte[] payload = ArticleRightsCanonicalPayloadV1.BuildPayloadBytes(input);
        byte[] hash = SHA256.HashData(payload);
        return HashAlgorithm + ":" + Convert.ToHexString(hash).ToLowerInvariant();
    }
}

public static class ArticleRightsCanonicalPayloadV1
{
    public static byte[] BuildPayloadBytes(ArticleRightsCanonicalInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        ValidateInput(input);

        var writer = new ArrayBufferWriter<byte>(EstimatePayloadBytes(input));
        WritePayload(writer, input);
        return writer.WrittenSpan.ToArray();
    }

    public static string BuildPayloadUtf8(ArticleRightsCanonicalInput input)
        => Encoding.UTF8.GetString(BuildPayloadBytes(input));

    public static void WritePayload(IBufferWriter<byte> writer, ArticleRightsCanonicalInput input)
    {
        ArgumentNullException.ThrowIfNull(writer);
        ArgumentNullException.ThrowIfNull(input);
        ValidateInput(input);

        AppendRawLine(writer, ArticleRightsCanonicalHashV1.DomainSeparator);
        AppendIntLine(writer, "hashVersion", ArticleRightsCanonicalHashV1.HashVersion);
        AppendIntLine(writer, "articleId", input.ArticleId);
        AppendLongLine(writer, "articleRevisionId", input.ArticleRevisionId);
        AppendIntLine(writer, "revisionNo", input.RevisionNo);
        AppendStringLine(writer, "licenseType", input.LicenseType);
        AppendStringLine(writer, "copyrightHolder", input.CopyrightHolder);
        AppendNullableIntLine(writer, "copyrightYear", input.CopyrightYear);
        AppendStringLine(writer, "rightsStatement", input.RightsStatement);
        AppendStringLine(writer, "attributionTemplate", input.AttributionTemplate);
        AppendStringLine(writer, "copyPolicy", input.CopyPolicy);
        AppendIntLine(writer, "maxExcerptChars", input.MaxExcerptChars);
        AppendBoolLine(writer, "allowCodeCopy", input.AllowCodeCopy);
        AppendBoolLine(writer, "showPublicBadge", input.ShowPublicBadge);
        AppendStringLine(writer, "canonicalUrl", input.CanonicalUrl);
        AppendHashLine(writer, "contentCanonicalHash", input.ContentCanonicalHash);
    }

    private static void ValidateInput(ArticleRightsCanonicalInput input)
    {
        if (input.ArticleId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ArticleId), input.ArticleId, "ArticleId must be positive.");
        }

        if (input.ArticleRevisionId <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.ArticleRevisionId), input.ArticleRevisionId, "ArticleRevisionId must be positive.");
        }

        if (input.RevisionNo <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.RevisionNo), input.RevisionNo, "RevisionNo must be positive.");
        }

        ArgumentException.ThrowIfNullOrWhiteSpace(input.LicenseType);
        ArgumentException.ThrowIfNullOrWhiteSpace(input.CopyPolicy);
        ArgumentException.ThrowIfNullOrWhiteSpace(input.ContentCanonicalHash);

        if (input.MaxExcerptChars < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(input.MaxExcerptChars), input.MaxExcerptChars, "MaxExcerptChars cannot be negative.");
        }

        _ = NormalizeSha256(input.ContentCanonicalHash);
    }

    private static int EstimatePayloadBytes(ArticleRightsCanonicalInput input)
    {
        int stringChars =
            input.LicenseType.Length
            + (input.CopyrightHolder?.Length ?? 0)
            + (input.RightsStatement?.Length ?? 0)
            + (input.AttributionTemplate?.Length ?? 0)
            + input.CopyPolicy.Length
            + (input.CanonicalUrl?.Length ?? 0);
        return Math.Max(512, 384 + (stringChars * 2));
    }

    private static void AppendRawLine(IBufferWriter<byte> writer, string value)
    {
        AppendAscii(writer, value);
        AppendAscii(writer, "\n");
    }

    private static void AppendIntLine(IBufferWriter<byte> writer, string field, int value)
    {
        AppendAscii(writer, field);
        AppendAscii(writer, ":i:");
        AppendAscii(writer, value.ToString(CultureInfo.InvariantCulture));
        AppendAscii(writer, "\n");
    }

    private static void AppendLongLine(IBufferWriter<byte> writer, string field, long value)
    {
        AppendAscii(writer, field);
        AppendAscii(writer, ":i:");
        AppendAscii(writer, value.ToString(CultureInfo.InvariantCulture));
        AppendAscii(writer, "\n");
    }

    private static void AppendNullableIntLine(IBufferWriter<byte> writer, string field, int? value)
    {
        if (value.HasValue)
        {
            AppendIntLine(writer, field, value.Value);
            return;
        }

        AppendAscii(writer, field);
        AppendAscii(writer, ":n\n");
    }

    private static void AppendBoolLine(IBufferWriter<byte> writer, string field, bool value)
    {
        AppendAscii(writer, field);
        AppendAscii(writer, value ? ":b:1\n" : ":b:0\n");
    }

    private static void AppendStringLine(IBufferWriter<byte> writer, string field, string? value)
    {
        AppendAscii(writer, field);

        if (value is null)
        {
            AppendAscii(writer, ":n\n");
            return;
        }

        string normalized = NormalizeText(value);
        byte[] bytes = Encoding.UTF8.GetBytes(normalized);
        string encoded = Convert.ToBase64String(bytes);
        AppendAscii(writer, ":s:");
        AppendAscii(writer, encoded);
        AppendAscii(writer, "\n");
    }

    private static void AppendHashLine(IBufferWriter<byte> writer, string field, string value)
    {
        AppendAscii(writer, field);
        AppendAscii(writer, ":h:");
        AppendAscii(writer, NormalizeSha256(value));
        AppendAscii(writer, "\n");
    }

    private static void AppendAscii(IBufferWriter<byte> writer, string value)
    {
        Span<byte> span = writer.GetSpan(value.Length);
        int written = Encoding.ASCII.GetBytes(value, span);
        writer.Advance(written);
    }

    private static string NormalizeText(string value)
        => NormalizeLineEndings(value).Normalize(NormalizationForm.FormC);

    private static string NormalizeLineEndings(string value)
    {
        if (value.IndexOf('\r') < 0)
        {
            return value;
        }

        var builder = new StringBuilder(value.Length);
        for (int i = 0; i < value.Length; i++)
        {
            char current = value[i];
            if (current != '\r')
            {
                builder.Append(current);
                continue;
            }

            if (i + 1 < value.Length && value[i + 1] == '\n')
            {
                i++;
            }

            builder.Append('\n');
        }

        return builder.ToString();
    }

    private static string NormalizeSha256(string value)
    {
        string candidate = value.Trim();
        if (candidate.StartsWith("sha256:", StringComparison.OrdinalIgnoreCase))
        {
            candidate = candidate["sha256:".Length..];
        }

        if (candidate.Length != 64)
        {
            throw new ArgumentException("Hash must be a sha256 digest with 64 hexadecimal characters.", nameof(value));
        }

        if (!HexText.IsSha256Hex(candidate))
        {
            throw new ArgumentException("Hash must contain only hexadecimal characters.", nameof(value));
        }

        return ArticleRightsCanonicalHashV1.HashAlgorithm + ":" + candidate.ToLowerInvariant();
    }
}

public static class ArticleRightsAttributionTemplateRenderer
{
    public static string Render(string? template, ArticleRightsAttributionValues values)
    {
        ArgumentNullException.ThrowIfNull(values);
        if (string.IsNullOrEmpty(template))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(EstimateCapacity(template, values));
        ReadOnlySpan<char> source = template.AsSpan();
        int index = 0;
        while (index < source.Length)
        {
            int open = source[index..].IndexOf('{');
            if (open < 0)
            {
                builder.Append(source[index..]);
                break;
            }

            open += index;
            builder.Append(source[index..open]);

            int close = source[(open + 1)..].IndexOf('}');
            if (close < 0)
            {
                builder.Append(source[open..]);
                break;
            }

            close += open + 1;
            ReadOnlySpan<char> token = source[(open + 1)..close];
            if (!TryAppendKnownToken(builder, token, values))
            {
                builder.Append(source[open..(close + 1)]);
            }

            index = close + 1;
        }

        return builder.ToString();
    }

    private static int EstimateCapacity(string template, ArticleRightsAttributionValues values)
        => Math.Max(
            template.Length,
            template.Length
            + (values.Title?.Length ?? 0)
            + (values.Url?.Length ?? 0)
            + (values.Holder?.Length ?? 0)
            + (values.Year?.Length ?? 0)
            + (values.License?.Length ?? 0)
            + (values.Proof?.Length ?? 0));

    private static bool TryAppendKnownToken(StringBuilder builder, ReadOnlySpan<char> token, ArticleRightsAttributionValues values)
    {
        if (token.SequenceEqual("title"))
        {
            builder.Append(values.Title);
            return true;
        }

        if (token.SequenceEqual("url"))
        {
            builder.Append(values.Url);
            return true;
        }

        if (token.SequenceEqual("holder"))
        {
            builder.Append(values.Holder);
            return true;
        }

        if (token.SequenceEqual("year"))
        {
            builder.Append(values.Year);
            return true;
        }

        if (token.SequenceEqual("license"))
        {
            builder.Append(values.License);
            return true;
        }

        if (token.SequenceEqual("proof"))
        {
            builder.Append(values.Proof);
            return true;
        }

        return false;
    }
}
