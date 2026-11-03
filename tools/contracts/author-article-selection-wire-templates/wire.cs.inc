#nullable enable
using System.Buffers;
using System.Text;

using FsusBlog.Contracts.AuthoringNavigation;

namespace FsusBlog.Core.Cache;

/// <summary>Closed selected-article payloads; the Server facade owns permission and freshness.</summary>
public static partial class PodBinaryCodec
{
    private static readonly UTF8Encoding s_selectionUtf8 = new(false, true);

    public static byte[] EncodeAuthorArticleSelectionRevalidationRequest(AuthorArticleSelectionRevalidationRequest value)
        => EncodeToArray(AuthorArticleSelectionRevalidationContract.RequestPayloadBytes,
            destination => WriteAuthorArticleSelectionRevalidationRequest(value, destination));

    public static void WriteAuthorArticleSelectionRevalidationRequest(
        AuthorArticleSelectionRevalidationRequest value, IBufferWriter<byte> destination)
    {
        if (!AuthorArticleSelectionRevalidationContract.IsValidRequest(value))
            throw new ArgumentException("author_article_selection_request_invalid", nameof(value));
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(value.SchemaVersion);
        writer.WriteInt32(value.ArticleId);
        writer.WriteInt64(value.ServerRevision);
        WriteSelectionGuid(value.RequestId, ref writer);
        writer.WriteBytes(s_selectionUtf8.GetBytes(value.PermissionToken));
    }

    public static bool TryDecodeAuthorArticleSelectionRevalidationRequest(ReadOnlyMemory<byte> source,
        out AuthorArticleSelectionRevalidationRequest value)
    {
        value = default!;
        if (source.Length != AuthorArticleSelectionRevalidationContract.RequestPayloadBytes) return false;
        try
        {
            var reader = new BinaryPodReader(source.Span);
            if (!reader.TryReadInt32(out int version) || !reader.TryReadInt32(out int articleId)
                || !reader.TryReadInt64(out long revision) || !ReadSelectionGuid(ref reader, out Guid requestId)
                || !ReadSelectionText(ref reader, 64, out string token) || !reader.IsConsumed) return false;
            var result = new AuthorArticleSelectionRevalidationRequest(version, articleId, revision, requestId, token);
            if (!AuthorArticleSelectionRevalidationContract.IsValidRequest(result)) return false;
            value = result;
            return true;
        }
        catch (ArgumentException) { return false; }
    }

    public static byte[] EncodeAuthorArticleSelectionRevalidationResponse(AuthorArticleSelectionRevalidationResponse value)
        => EncodeToArray(AuthorArticleSelectionRevalidationContract.MaxResponsePayloadBytes,
            destination => WriteAuthorArticleSelectionRevalidationResponse(value, destination));

    public static void WriteAuthorArticleSelectionRevalidationResponse(
        AuthorArticleSelectionRevalidationResponse value, IBufferWriter<byte> destination)
    {
        if (!AuthorArticleSelectionRevalidationContract.IsValidResponse(value))
            throw new ArgumentException("author_article_selection_response_invalid", nameof(value));
        byte[] site = s_selectionUtf8.GetBytes(value.Owner.SiteScope);
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(value.SchemaVersion);
        writer.WriteByte(value.Current ? (byte)1 : (byte)0);
        writer.WriteInt64(value.Owner.AdminPrincipalId);
        writer.WriteBytes(site);
        writer.WriteInt32(value.ArticleId);
        writer.WriteInt64(value.ServerRevision);
        WriteSelectionGuid(value.RequestId, ref writer);
        writer.WriteByte(value.PermissionToken is null ? (byte)0 : (byte)1);
        if (value.PermissionToken is not null) writer.WriteBytes(s_selectionUtf8.GetBytes(value.PermissionToken));
    }

    public static bool TryDecodeAuthorArticleSelectionRevalidationResponse(ReadOnlyMemory<byte> source,
        out AuthorArticleSelectionRevalidationResponse value)
    {
        value = default!;
        if (source.Length is < 46 or > AuthorArticleSelectionRevalidationContract.MaxResponsePayloadBytes) return false;
        try
        {
            var reader = new BinaryPodReader(source.Span);
            if (!reader.TryReadInt32(out int version) || !reader.TryReadByte(out byte current) || current > 1
                || !reader.TryReadInt64(out long principal) || !ReadSelectionText(ref reader, 512, out string site)
                || !reader.TryReadInt32(out int articleId) || !reader.TryReadInt64(out long revision)
                || !ReadSelectionGuid(ref reader, out Guid requestId) || !reader.TryReadByte(out byte present)
                || present > 1) return false;
            string? token = null;
            if (present == 1)
            {
                if (!ReadSelectionText(ref reader, 64, out string text)) return false;
                token = text;
            }
            if (!reader.IsConsumed) return false;
            var result = new AuthorArticleSelectionRevalidationResponse(version, current == 1,
                new(principal, site), articleId, revision, requestId, token);
            if (!AuthorArticleSelectionRevalidationContract.IsValidResponse(result)) return false;
            value = result;
            return true;
        }
        catch (ArgumentException) { return false; }
    }

    private static void WriteSelectionGuid(Guid value, ref BinaryPodWriter writer)
    {
        Span<byte> bytes = stackalloc byte[16];
        value.TryWriteBytes(bytes, bigEndian: true, out _);
        foreach (byte item in bytes) writer.WriteByte(item);
    }

    private static bool ReadSelectionGuid(ref BinaryPodReader reader, out Guid value)
    {
        value = default;
        if (!reader.TryReadSpan(16, out ReadOnlySpan<byte> bytes)) return false;
        value = new Guid(bytes, bigEndian: true);
        return value != Guid.Empty;
    }

    private static bool ReadSelectionText(ref BinaryPodReader reader, int maxBytes, out string value)
    {
        value = string.Empty;
        if (!reader.TryReadBytes(out ReadOnlySpan<byte> bytes) || bytes.Length > maxBytes) return false;
        value = s_selectionUtf8.GetString(bytes);
        return true;
    }
}
