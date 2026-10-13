#nullable enable
using System.Buffers;
using System.Text;

using FsusBlog.Contracts.ArticleCapture;

namespace FsusBlog.Core.Cache;

/// <summary>Capture payloads use the original POD primitives; DTO validation grants no authority.</summary>
public static partial class PodBinaryCodec
{
    private static readonly UTF8Encoding s_captureUtf8 = new(false, true);

    public static byte[] EncodeArticleInboxCaptureRequest(ArticleInboxCaptureRequest value)
        => EncodeToArray(ArticleInboxCaptureContract.MaxRequestPayloadBytes,
            destination => WriteArticleInboxCaptureRequest(value, destination));

    public static void WriteArticleInboxCaptureRequest(ArticleInboxCaptureRequest value, IBufferWriter<byte> destination)
    {
        if (!ArticleInboxCaptureContract.IsValidRequest(value))
            throw new ArgumentException("article_inbox_capture_request_invalid", nameof(value));
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(value.SchemaVersion);
        WriteCaptureGuid(value.RequestId, ref writer);
        writer.WriteBytes(s_captureUtf8.GetBytes(value.ExpectedSiteScope));
        writer.WriteBytes(s_captureUtf8.GetBytes(value.Title));
        writer.WriteBytes(s_captureUtf8.GetBytes(value.MarkdownContent));
    }

    public static bool TryDecodeArticleInboxCaptureRequest(ReadOnlyMemory<byte> source, out ArticleInboxCaptureRequest value)
    {
        value = default!;
        if (source.Length < 34 || source.Length > ArticleInboxCaptureContract.MaxRequestPayloadBytes) return false;
        try
        {
            var reader = new BinaryPodReader(source.Span);
            if (!reader.TryReadInt32(out int schema) || !ReadCaptureGuid(ref reader, out Guid requestId)
                || !ReadCaptureText(ref reader, 512, out string site) || !ReadCaptureText(ref reader, 1_024, out string title)
                || !ReadCaptureText(ref reader, 800_000, out string markdown) || !reader.IsConsumed) return false;
            var result = new ArticleInboxCaptureRequest(schema, requestId, site, title, markdown);
            if (!ArticleInboxCaptureContract.IsValidRequest(result)) return false;
            value = result;
            return true;
        }
        catch (ArgumentException) { return false; }
    }

    public static byte[] EncodeArticleInboxCaptureResponse(ArticleInboxCaptureResponse value)
        => EncodeToArray(ArticleInboxCaptureContract.MaxResponsePayloadBytes,
            destination => WriteArticleInboxCaptureResponse(value, destination));

    public static void WriteArticleInboxCaptureResponse(ArticleInboxCaptureResponse value, IBufferWriter<byte> destination)
    {
        if (!ArticleInboxCaptureContract.IsValidResponse(value))
            throw new ArgumentException("article_inbox_capture_response_invalid", nameof(value));
        var writer = new BinaryPodWriter(destination);
        writer.WriteInt32(value.SchemaVersion);
        WriteCaptureGuid(value.RequestId, ref writer);
        writer.WriteInt64(value.AuthenticatedAdminPrincipalId);
        writer.WriteBytes(s_captureUtf8.GetBytes(value.RequestSiteScope));
        writer.WriteByte(value.Receipt is null ? (byte)0 : (byte)1);
        if (value.Receipt is not { } receipt) return;
        WriteCaptureGuid(receipt.ReceiptId, ref writer);
        WriteCaptureGuid(receipt.RequestId, ref writer);
        writer.WriteInt64(receipt.OwnerAdminPrincipalId);
        writer.WriteInt32(receipt.ArticleId);
        writer.WriteInt64(receipt.DraftId);
        writer.WriteInt64(receipt.DraftServerRevision);
        writer.WriteInt64(receipt.RevisionId);
        writer.WriteInt32(receipt.RevisionNo);
        writer.WriteBytes(s_captureUtf8.GetBytes(receipt.OutboxEventId));
        WriteCaptureGuid(receipt.AuditReference, ref writer);
        writer.WriteBytes(s_captureUtf8.GetBytes(receipt.AuditDigest));
        writer.WriteBytes(s_captureUtf8.GetBytes(receipt.SourceDigest));
        writer.WriteBytes(s_captureUtf8.GetBytes(receipt.ContentDigest));
        writer.WriteInt64(receipt.OccurredAtUtcTicks);
        writer.WriteByte(receipt.IsIdempotentReplay ? (byte)1 : (byte)0);
    }

    public static bool TryDecodeArticleInboxCaptureResponse(ReadOnlyMemory<byte> source, out ArticleInboxCaptureResponse value)
    {
        value = default!;
        if (source.Length < 34 || source.Length > ArticleInboxCaptureContract.MaxResponsePayloadBytes) return false;
        try
        {
            var reader = new BinaryPodReader(source.Span);
            if (!reader.TryReadInt32(out int schema) || !ReadCaptureGuid(ref reader, out Guid requestId)
                || !reader.TryReadInt64(out long actor) || !ReadCaptureText(ref reader, 512, out string site)
                || !reader.TryReadByte(out byte present) || present > 1) return false;
            ArticleInboxCaptureReceipt? receipt = null;
            if (present == 1)
            {
                if (!ReadCaptureGuid(ref reader, out Guid receiptId) || !ReadCaptureGuid(ref reader, out Guid originalRequest)
                    || !reader.TryReadInt64(out long owner) || !reader.TryReadInt32(out int article)
                    || !reader.TryReadInt64(out long draft) || !reader.TryReadInt64(out long draftRevision)
                    || !reader.TryReadInt64(out long revision) || !reader.TryReadInt32(out int revisionNo)
                    || !ReadCaptureText(ref reader, 32, out string outbox) || !ReadCaptureGuid(ref reader, out Guid audit)
                    || !ReadCaptureText(ref reader, 64, out string auditDigest) || !ReadCaptureText(ref reader, 64, out string sourceDigest)
                    || !ReadCaptureText(ref reader, 64, out string contentDigest) || !reader.TryReadInt64(out long ticks)
                    || !reader.TryReadByte(out byte replay) || replay > 1) return false;
                receipt = new(receiptId, originalRequest, owner, article, draft, draftRevision, revision,
                    revisionNo, outbox, audit, auditDigest, sourceDigest, contentDigest, ticks, replay == 1);
            }
            if (!reader.IsConsumed) return false;
            var result = new ArticleInboxCaptureResponse(schema, requestId, actor, site, receipt);
            if (!ArticleInboxCaptureContract.IsValidResponse(result)) return false;
            value = result;
            return true;
        }
        catch (ArgumentException) { return false; }
    }

    private static void WriteCaptureGuid(Guid value, ref BinaryPodWriter writer)
    {
        Span<byte> bytes = stackalloc byte[16];
        value.TryWriteBytes(bytes, bigEndian: true, out _);
        foreach (byte item in bytes) writer.WriteByte(item);
    }

    private static bool ReadCaptureGuid(ref BinaryPodReader reader, out Guid value)
    {
        value = default;
        if (!reader.TryReadSpan(16, out ReadOnlySpan<byte> bytes)) return false;
        value = new Guid(bytes, bigEndian: true);
        return value != Guid.Empty;
    }

    private static bool ReadCaptureText(ref BinaryPodReader reader, int maxBytes, out string value)
    {
        value = string.Empty;
        if (!reader.TryReadBytes(out ReadOnlySpan<byte> bytes) || bytes.Length > maxBytes) return false;
        value = s_captureUtf8.GetString(bytes);
        return true;
    }
}
