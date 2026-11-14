using System.Globalization;
using System.Text;

namespace FsusBlog.V2.Core.Integrity;

public static class SiteProofPayload
{
    private static readonly UTF8Encoding Utf8 = new(encoderShouldEmitUTF8Identifier: false, throwOnInvalidBytes: true);

    public static byte[] Canonicalize(string kind, string subject, string digestSha256Hex, DateTimeOffset issued,
        IReadOnlyDictionary<string, string> fields)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(kind);
        ArgumentException.ThrowIfNullOrWhiteSpace(subject);
        ArgumentNullException.ThrowIfNull(fields);
        ArgumentNullException.ThrowIfNull(digestSha256Hex);
        var digest = digestSha256Hex.Trim();
        if (digest.Length != 64 || !digest.All(char.IsAsciiHexDigit))
            throw new ArgumentException("The digest must contain 64 hexadecimal digits.", nameof(digestSha256Hex));
        if (fields.Count > 64)
            throw new ArgumentException("Too many signing fields.", nameof(fields));

        var result = new StringBuilder(256 + fields.Count * 96);
        result.Append("fsusblog.integrity.publish-proof.v1\npayloadVersion:i:1\n");
        WriteText(result, "proofKind", Normalize(kind));
        WriteText(result, "subject", Normalize(subject));
        result.Append("digestSha256:h:").Append(digest.ToLowerInvariant()).Append('\n');
        result.Append("issuedAt:t:").Append(issued.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fffffff'Z'", CultureInfo.InvariantCulture)).Append('\n');
        result.Append("fieldCount:i:").Append(fields.Count.ToString(CultureInfo.InvariantCulture)).Append('\n');
        var labels = new HashSet<string>(StringComparer.Ordinal);
        foreach (var (key, value) in fields.OrderBy(pair => pair.Key, StringComparer.Ordinal))
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(key);
            var normalized = Normalize(key);
            if (!labels.Add(normalized))
                throw new ArgumentException("The signing payload contains the same normalized field more than once.", nameof(fields));
            WriteText(result, "fieldKey", normalized);
            WriteText(result, "fieldValue", Normalize(value));
        }
        return Utf8.GetBytes(result.ToString());
    }

    private static void WriteText(StringBuilder output, string label, string value)
    {
        output.Append(label).Append(":s:").Append(Convert.ToBase64String(Utf8.GetBytes(value))).Append('\n');
    }

    private static string Normalize(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        if (value.Length > 8192) throw new ArgumentException("A proof signing field exceeds its limit.", nameof(value));
        return value.Replace("\r\n", "\n", StringComparison.Ordinal).Replace('\r', '\n').Normalize(NormalizationForm.FormC);
    }
}
