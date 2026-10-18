using System.Buffers;
using System.Collections.ObjectModel;
using System.IO.Pipelines;
using System.Security.Cryptography;
using System.Text;

using FsusBlog.Server.Infrastructure.Memory.Transient;

namespace FsusBlog.Server.Infrastructure.PublicAot;

/// <summary>
/// Immutable, publication-time compiled UTF-8 template for per-request CSP nonces.
/// Request-time rendering only walks precomputed slot offsets and never scans HTML.
/// </summary>
public sealed class CspNonceUtf8Template
{
    public const string Placeholder = "%%FSUSBLOG_CSP_NONCE%%";

    private static readonly UTF8Encoding s_strictUtf8 = new(false, true);
    private readonly byte[] _templateBytes;
    private readonly int[] _slotOffsets;
    private readonly ReadOnlyCollection<string> _staticInlineSha256Sources;

    private CspNonceUtf8Template(
        byte[] templateBytes,
        int[] slotOffsets,
        string artifactIdentity,
        string templateDigest,
        string[] staticInlineSha256Sources)
    {
        _templateBytes = templateBytes;
        _slotOffsets = slotOffsets;
        _staticInlineSha256Sources = Array.AsReadOnly(staticInlineSha256Sources);
        ArtifactIdentity = artifactIdentity;
        TemplateDigest = templateDigest;
        LengthWithoutNonce = templateBytes.Length - (slotOffsets.Length * s_strictUtf8.GetByteCount(Placeholder));
        ResidentBytes = templateBytes.LongLength
            + ((long)slotOffsets.Length * sizeof(int))
            + ((long)staticInlineSha256Sources.Length * IntPtr.Size)
            + staticInlineSha256Sources.Sum(static value => (long)value.Length * sizeof(char))
            + ((long)artifactIdentity.Length * sizeof(char))
            + ((long)templateDigest.Length * sizeof(char))
            + 64;
        ResidentArrayCount = 3;
        ResidentObjectCount = 6 + staticInlineSha256Sources.Length;
        long slotBytes = (long)slotOffsets.Length * sizeof(int);
        long hashIndexBytes = (long)staticInlineSha256Sources.Length * IntPtr.Size;
        LohEligibleArrayCount = (templateBytes.LongLength >= 85_000 ? 1 : 0)
            + (slotBytes >= 85_000 ? 1 : 0)
            + (hashIndexBytes >= 85_000 ? 1 : 0);
        LohEligibleArrayBytes = (templateBytes.LongLength >= 85_000 ? templateBytes.LongLength : 0)
            + (slotBytes >= 85_000 ? slotBytes : 0)
            + (hashIndexBytes >= 85_000 ? hashIndexBytes : 0);
    }

    public string ArtifactIdentity
    {
        get;
    }

    public string TemplateDigest
    {
        get;
    }

    public int SlotCount => _slotOffsets.Length;

    public int LengthWithoutNonce
    {
        get;
    }

    public long ResidentBytes
    {
        get;
    }

    public int ResidentArrayCount
    {
        get;
    }

    public int ResidentObjectCount
    {
        get;
    }

    public int LohEligibleArrayCount
    {
        get;
    }

    public long LohEligibleArrayBytes
    {
        get;
    }

    public IReadOnlyList<string> StaticInlineSha256Sources => _staticInlineSha256Sources;

    internal ReadOnlyMemory<byte> IntegrityBytes => _templateBytes;

    internal static CspNonceUtf8Template? Compile(string html, string artifactIdentity)
    {
        ArgumentNullException.ThrowIfNull(html);
        if (html.Length == 0)
        {
            return null;
        }

        if (html.Contains(Placeholder, StringComparison.Ordinal))
        {
            throw new InvalidOperationException("CSP nonce placeholder is only emitted by the artifact compiler.");
        }

        var output = new StringBuilder(html.Length + 192);
        var staticHashes = new List<string>();
        int position = 0;
        int headCount = 0;
        int slotCount = 0;
        while (position < html.Length)
        {
            int tagStart = html.IndexOf('<', position);
            if (tagStart < 0)
            {
                output.Append(html, position, html.Length - position);
                break;
            }

            output.Append(html, position, tagStart - position);
            if (html.AsSpan(tagStart).StartsWith("<!--", StringComparison.Ordinal))
            {
                int commentEnd = html.IndexOf("-->", tagStart + 4, StringComparison.Ordinal);
                if (commentEnd < 0)
                {
                    throw new InvalidOperationException("CSP nonce HTML contains an unterminated comment.");
                }

                output.Append(html, tagStart, commentEnd + 3 - tagStart);
                position = commentEnd + 3;
                continue;
            }

            int tagEnd = FindTagEnd(html, tagStart + 1);

            ReadOnlySpan<char> tag = html.AsSpan(tagStart, tagEnd - tagStart + 1);
            if (!TryReadStartTagName(tag, out ReadOnlySpan<char> tagName, out int attributesStart))
            {
                output.Append(tag);
                position = tagEnd + 1;
                continue;
            }

            ParsedAttributes attributes = ParseAttributes(tag, attributesStart);
            if (attributes.NonceCount > 0)
            {
                throw new InvalidOperationException("CSP nonce HTML must not contain pre-rendered or duplicate nonce attributes.");
            }

            if (tagName.Equals("meta", StringComparison.OrdinalIgnoreCase)
                && string.Equals(attributes.PropertyValue, "csp-nonce", StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("CSP nonce metadata is compiler-owned and must not be pre-rendered.");
            }

            bool executable = tagName.Equals("script", StringComparison.OrdinalIgnoreCase)
                || tagName.Equals("style", StringComparison.OrdinalIgnoreCase);
            if (executable)
            {
                if (attributes.IsSelfClosing)
                {
                    throw new InvalidOperationException("Self-closing script/style tags are not supported by the CSP nonce compiler.");
                }

                int insertAt = tagStart + 1 + tagName.Length;
                output.Append(html, tagStart, insertAt - tagStart);
                output.Append(" nonce=\"");
                output.Append(Placeholder);
                output.Append('"');
                output.Append(html, insertAt, tagEnd - insertAt + 1);
                slotCount++;

                (int closeStart, int closeEnd) = FindClosingTag(html, tagEnd + 1, tagName);
                if (!attributes.HasSrc)
                {
                    AddStaticInlineHash(html.AsSpan(tagEnd + 1, closeStart - tagEnd - 1), staticHashes);
                }

                output.Append(html, tagEnd + 1, closeEnd - tagEnd);
                position = closeEnd + 1;
                continue;
            }
            else
            {
                output.Append(tag);
            }

            if (tagName.Equals("head", StringComparison.OrdinalIgnoreCase))
            {
                if (attributes.IsSelfClosing)
                {
                    throw new InvalidOperationException("Self-closing head tags are not supported by the CSP nonce compiler.");
                }

                headCount++;
                if (headCount > 1)
                {
                    throw new InvalidOperationException("CSP nonce HTML contains multiple head elements.");
                }

                output.Append('\n');
                output.Append("    <meta property=\"csp-nonce\" nonce=\"");
                output.Append(Placeholder);
                output.Append("\" />");
                slotCount++;
            }

            position = tagEnd + 1;
        }

        if (slotCount == 0)
        {
            return null;
        }

        byte[] templateBytes = s_strictUtf8.GetBytes(output.ToString());
        byte[] placeholderBytes = s_strictUtf8.GetBytes(Placeholder);
        int[] slotOffsets = FindSlotOffsets(templateBytes, placeholderBytes, slotCount);
        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(templateBytes, digest);
        return new CspNonceUtf8Template(
            templateBytes,
            slotOffsets,
            artifactIdentity,
            Convert.ToHexStringLower(digest),
            [.. staticHashes]);
    }

    public int GetRenderedLength(int nonceUtf8Length)
    {
        ArgumentOutOfRangeException.ThrowIfNegative(nonceUtf8Length);
        return checked(LengthWithoutNonce + (SlotCount * nonceUtf8Length));
    }

    public void Write(IBufferWriter<byte> writer, ReadOnlySpan<byte> nonceUtf8)
        => Write(writer, nonceUtf8, CancellationToken.None);

    internal void Write(
        IBufferWriter<byte> writer,
        ReadOnlySpan<byte> nonceUtf8,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(writer);
        if (!IsSafeNonce(nonceUtf8))
        {
            throw new InvalidOperationException("CSP nonce must be non-empty base64url data.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        int placeholderLength = s_strictUtf8.GetByteCount(Placeholder);
        int position = 0;
        foreach (int slotOffset in _slotOffsets)
        {
            cancellationToken.ThrowIfCancellationRequested();
            WriteBytes(writer, _templateBytes.AsSpan(position, slotOffset - position));
            cancellationToken.ThrowIfCancellationRequested();
            WriteBytes(writer, nonceUtf8);
            position = slotOffset + placeholderLength;
        }

        cancellationToken.ThrowIfCancellationRequested();
        WriteBytes(writer, _templateBytes.AsSpan(position));
    }

    private static int[] FindSlotOffsets(ReadOnlySpan<byte> template, ReadOnlySpan<byte> placeholder, int expectedCount)
    {
        var offsets = new int[expectedCount];
        int count = 0;
        int position = 0;
        while (position <= template.Length - placeholder.Length)
        {
            int relative = template[position..].IndexOf(placeholder);
            if (relative < 0)
            {
                break;
            }

            if (count == offsets.Length)
            {
                throw new InvalidOperationException("CSP nonce template contains unexpected duplicate slots.");
            }

            int offset = position + relative;
            offsets[count++] = offset;
            position = offset + placeholder.Length;
        }

        if (count != expectedCount)
        {
            throw new InvalidOperationException("CSP nonce template slot validation failed.");
        }

        return offsets;
    }

    private static bool TryReadStartTagName(
        ReadOnlySpan<char> tag,
        out ReadOnlySpan<char> name,
        out int attributesStart)
    {
        name = default;
        attributesStart = 0;
        if (tag.Length < 3 || tag[0] != '<' || tag[1] is '/' or '!' or '?')
        {
            return false;
        }

        int end = 1;
        while (end < tag.Length && IsNameCharacter(tag[end]))
        {
            end++;
        }

        if (end == 1)
        {
            return false;
        }

        name = tag[1..end];
        attributesStart = end;
        return true;
    }

    private static ParsedAttributes ParseAttributes(ReadOnlySpan<char> tag, int position)
    {
        var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        int nonceCount = 0;
        bool hasSrc = false;
        bool isSelfClosing = false;
        string? propertyValue = null;
        int end = tag.Length - 1;
        while (position < end)
        {
            while (position < end && char.IsWhiteSpace(tag[position]))
            {
                position++;
            }

            if (position >= end)
            {
                break;
            }

            if (tag[position] == '/')
            {
                position++;
                while (position < end && char.IsWhiteSpace(tag[position]))
                {
                    position++;
                }

                if (position != end)
                {
                    throw new InvalidOperationException("CSP nonce HTML contains a malformed self-closing tag.");
                }

                isSelfClosing = true;
                break;
            }

            int nameStart = position;
            while (position < end && IsAttributeNameCharacter(tag[position]))
            {
                position++;
            }

            if (position == nameStart)
            {
                throw new InvalidOperationException("CSP nonce HTML contains a malformed attribute.");
            }

            ReadOnlySpan<char> name = tag[nameStart..position];
            if (!names.Add(name.ToString()))
            {
                throw new InvalidOperationException($"CSP nonce HTML contains a duplicate {name.ToString()} attribute.");
            }

            bool securitySensitiveValue = name.Equals("nonce", StringComparison.OrdinalIgnoreCase)
                || name.Equals("property", StringComparison.OrdinalIgnoreCase);
            while (position < end && char.IsWhiteSpace(tag[position]))
            {
                position++;
            }

            ReadOnlySpan<char> value = default;
            if (position < end && tag[position] == '=')
            {
                position++;
                while (position < end && char.IsWhiteSpace(tag[position]))
                {
                    position++;
                }

                if (position >= end)
                {
                    throw new InvalidOperationException("CSP nonce HTML contains a missing attribute value.");
                }

                if (tag[position] is '\'' or '"')
                {
                    char quote = tag[position++];
                    int valueStart = position;
                    while (position < end && tag[position] != quote)
                    {
                        position++;
                    }

                    if (position >= end)
                    {
                        throw new InvalidOperationException("CSP nonce HTML contains an unterminated attribute value.");
                    }

                    value = tag[valueStart..position];
                    position++;
                }
                else
                {
                    if (securitySensitiveValue)
                    {
                        throw new InvalidOperationException("CSP nonce security attributes must use quoted values.");
                    }

                    int valueStart = position;
                    while (position < end && !char.IsWhiteSpace(tag[position]) && tag[position] != '>')
                    {
                        if (tag[position] is '"' or '\'' or '=' or '`' or '<')
                        {
                            throw new InvalidOperationException(
                                "CSP nonce HTML contains an invalid unquoted attribute value.");
                        }

                        position++;
                    }

                    value = tag[valueStart..position];
                }
            }

            if (name.Equals("nonce", StringComparison.OrdinalIgnoreCase))
            {
                nonceCount++;
            }
            else if (name.Equals("src", StringComparison.OrdinalIgnoreCase))
            {
                hasSrc = true;
            }
            else if (name.Equals("property", StringComparison.OrdinalIgnoreCase))
            {
                propertyValue = value.ToString();
            }
        }

        return new ParsedAttributes(nonceCount, hasSrc, isSelfClosing, propertyValue);
    }

    private static (int Start, int End) FindClosingTag(
        string html,
        int contentStart,
        ReadOnlySpan<char> tagName)
    {
        string closingPrefix = string.Concat("</", tagName.ToString());
        int search = contentStart;
        while (search < html.Length)
        {
            int closeStart = html.IndexOf(closingPrefix, search, StringComparison.OrdinalIgnoreCase);
            if (closeStart < 0)
            {
                break;
            }

            int nameEnd = closeStart + closingPrefix.Length;
            if (nameEnd < html.Length && (char.IsWhiteSpace(html[nameEnd]) || html[nameEnd] == '>'))
            {
                int closeEnd = FindTagEnd(html, nameEnd);
                for (int position = nameEnd; position < closeEnd; position++)
                {
                    if (!char.IsWhiteSpace(html[position]))
                    {
                        throw new InvalidOperationException(
                            $"CSP nonce HTML contains a malformed closing {tagName.ToString()} tag.");
                    }
                }

                return (closeStart, closeEnd);
            }

            search = nameEnd;
        }

        throw new InvalidOperationException($"CSP nonce HTML contains an unclosed {tagName.ToString()} element.");
    }

    private static int FindTagEnd(string html, int position)
    {
        char quote = '\0';
        while (position < html.Length)
        {
            char value = html[position];
            if (quote == '\0')
            {
                if (value is '\'' or '"')
                {
                    quote = value;
                }
                else if (value == '>')
                {
                    return position;
                }
            }
            else if (value == quote)
            {
                quote = '\0';
            }

            position++;
        }

        throw new InvalidOperationException("CSP nonce HTML contains an unterminated tag or quoted attribute.");
    }

    private static void AddStaticInlineHash(ReadOnlySpan<char> content, List<string> hashes)
    {
        byte[] contentBytes = s_strictUtf8.GetBytes(content.ToString());
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(contentBytes, hash);
        hashes.Add(string.Concat("'sha256-", Convert.ToBase64String(hash), "'"));
    }

    private static bool IsSafeNonce(ReadOnlySpan<byte> nonce)
    {
        if (nonce.IsEmpty)
        {
            return false;
        }

        foreach (byte value in nonce)
        {
            if (value is >= (byte)'a' and <= (byte)'z'
                or >= (byte)'A' and <= (byte)'Z'
                or >= (byte)'0' and <= (byte)'9'
                or (byte)'_'
                or (byte)'-')
            {
                continue;
            }

            return false;
        }

        return true;
    }

    private static bool IsNameCharacter(char value)
        => char.IsAsciiLetterOrDigit(value) || value is ':' or '-' or '_';

    private static bool IsAttributeNameCharacter(char value)
        => IsNameCharacter(value) || value == '.';

    private static void WriteBytes(IBufferWriter<byte> writer, ReadOnlySpan<byte> bytes)
    {
        if (bytes.IsEmpty)
        {
            return;
        }

        bytes.CopyTo(writer.GetSpan(bytes.Length));
        writer.Advance(bytes.Length);
    }

    private readonly record struct ParsedAttributes(
        int NonceCount,
        bool HasSrc,
        bool IsSelfClosing,
        string? PropertyValue);
}

internal static class CspNonceHtmlResponseWriter
{
    internal static Task WriteBodyAsync(
        HttpResponse response,
        CspNonceUtf8Template template,
        string nonce,
        CancellationToken cancellationToken)
    {
        Span<byte> nonceBytes = stackalloc byte[64];
        int nonceLength = Encoding.UTF8.GetBytes(nonce.AsSpan(), nonceBytes);
        template.Write(response.BodyWriter, nonceBytes[..nonceLength], cancellationToken);
        return FlushBodyAsync(response, cancellationToken);
    }

    /// <summary>
    /// Borrows caller-admitted nonce scratch under the existing transient operation hold.
    /// The caller must retain exclusive, stable scratch ownership and keep it disjoint from
    /// template and BodyWriter storage through completion. The hold does not exclude aliases.
    /// A valid nonce may be encoded into scratch before an already-canceled token is rejected.
    /// Cancellation therefore does not promise unchanged scratch; the original pool owns clearing.
    /// Original template segments stream directly to BodyWriter; the hold ends only after
    /// the original flush terminates. This overload supplies no pool, budget or template lease.
    /// </summary>
    internal static Task WriteBodyAsync(
        HttpResponse response,
        CspNonceUtf8Template template,
        string nonce,
        TransientBufferLease nonceScratch,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(response);
        ArgumentNullException.ThrowIfNull(template);
        ArgumentNullException.ThrowIfNull(nonceScratch);
        return nonceScratch.ConsumeAsync((memory, token) =>
        {
            ReservedCspNonceScratchWriter.Write(template, nonce, response.BodyWriter, memory.Span, token);
            return new ValueTask(FlushBodyAsync(response, token));
        }, cancellationToken).AsTask();
    }

    private static Task FlushBodyAsync(HttpResponse response, CancellationToken cancellationToken)
    {
        ValueTask<FlushResult> flush = response.BodyWriter.FlushAsync(cancellationToken);
        if (flush.IsCompletedSuccessfully)
        {
            ThrowIfCanceled(flush.Result, cancellationToken);
            return Task.CompletedTask;
        }

        return AwaitFlushAsync(flush, cancellationToken);
    }

    private static async Task AwaitFlushAsync(ValueTask<FlushResult> flush, CancellationToken cancellationToken)
        => ThrowIfCanceled(await flush, cancellationToken);

    private static void ThrowIfCanceled(FlushResult result, CancellationToken cancellationToken)
    {
        if (result.IsCanceled || result.IsCompleted)
        {
            throw new OperationCanceledException(cancellationToken.IsCancellationRequested
                ? cancellationToken
                : new CancellationToken(canceled: true));
        }
    }
}
