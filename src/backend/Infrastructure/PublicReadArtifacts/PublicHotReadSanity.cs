using System.Buffers;
using System.Buffers.Binary;
using System.IO.Compression;
using System.Security.Cryptography;
using System.Text;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public readonly record struct PublicArtifactIntegrityTag(ulong High, ulong Low)
{
    public bool IsEmpty => High == 0 && Low == 0;
}

internal enum PublicArtifactIntegrityRouteKind : byte
{
    Article = 1,
    List = 2,
    Category = 3,
    Tag = 4,
    Html = 5
}

internal readonly record struct PublicArtifactIntegrityContext(
    PublicArtifactIntegrityRouteKind RouteKind,
    PublicListKind ListKind = default,
    int TargetId = 0,
    ushort Page = 0,
    byte Size = 0,
    string RouteKey = "")
{
    internal static PublicArtifactIntegrityContext ForArticle(int articleId)
        => new(PublicArtifactIntegrityRouteKind.Article, TargetId: articleId);

    internal static PublicArtifactIntegrityContext ForList(in PublicListKey key)
        => new(PublicArtifactIntegrityRouteKind.List, key.Kind, key.TargetId, key.Page, key.Size);

    internal static PublicArtifactIntegrityContext ForCategory()
        => new(PublicArtifactIntegrityRouteKind.Category);

    internal static PublicArtifactIntegrityContext ForTag()
        => new(PublicArtifactIntegrityRouteKind.Tag);

    internal static PublicArtifactIntegrityContext ForHtml(string routeKey)
        => new(PublicArtifactIntegrityRouteKind.Html, RouteKey: routeKey);
}

internal static class PublicHotReadArtifactIntegrity
{
    internal const string Algorithm = "hmac-sha256-128-process-memory-v2";
    private const int StackUtf8Bytes = 256;
    private static readonly byte[] s_processKey = RandomNumberGenerator.GetBytes(32);
    private static readonly ThreadLocal<IncrementalHash> s_threadHasher = new(
        static () => IncrementalHash.CreateHMAC(HashAlgorithmName.SHA256, s_processKey),
        trackAllValues: false);

    internal static PublicBinaryArtifact Seal(
        PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context)
        => artifact with
        {
            FrameIntegrityTag = SealIfMissing(
                artifact.Frame,
                artifact.FrameIntegrityTag,
                artifact,
                context,
                string.Empty,
                artifact.ETag),
            BrotliIntegrityTag = SealIfMissing(
                artifact.BrotliFrame,
                artifact.BrotliIntegrityTag,
                artifact,
                context,
                "br",
                artifact.BrotliETag),
            GzipIntegrityTag = SealIfMissing(
                artifact.GzipFrame,
                artifact.GzipIntegrityTag,
                artifact,
                context,
                "gzip",
                artifact.GzipETag)
        };

    internal static PublicHtmlArtifact Seal(
        PublicHtmlArtifact artifact,
        in PublicArtifactIntegrityContext context)
        => artifact with
        {
            IntegrityTag = SealIfMissing(
                artifact.Bytes,
                artifact.IntegrityTag,
                artifact,
                context,
                "html"),
            TemplateIntegrityTag = SealIfMissing(
                artifact.CspNonceTemplate?.IntegrityBytes ?? default,
                artifact.TemplateIntegrityTag,
                artifact,
                context,
                "csp-nonce-template")
        };

    internal static bool IsValid(
        in PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context)
        => IsValid(
                artifact.Frame,
                artifact.FrameIntegrityTag,
                artifact,
                context,
                string.Empty,
                artifact.ETag)
            && IsValid(
                artifact.BrotliFrame,
                artifact.BrotliIntegrityTag,
                artifact,
                context,
                "br",
                artifact.BrotliETag)
            && IsValid(
                artifact.GzipFrame,
                artifact.GzipIntegrityTag,
                artifact,
                context,
                "gzip",
                artifact.GzipETag);

    internal static bool IsValid(
        in PublicBinaryArtifactVariant variant,
        in PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context)
        => IsValid(
            variant.Frame,
            variant.IntegrityTag,
            artifact,
            context,
            variant.ContentEncoding,
            variant.ETag);

    internal static bool IsValid(
        in PublicHtmlArtifact artifact,
        in PublicArtifactIntegrityContext context)
        => IsValid(artifact.Bytes, artifact.IntegrityTag, artifact, context, "html")
            && IsValid(
                artifact.CspNonceTemplate?.IntegrityBytes ?? default,
                artifact.TemplateIntegrityTag,
                artifact,
                context,
                "csp-nonce-template");

    internal static bool IsSnapshotValid(PublicHotReadSnapshot snapshot)
    {
        foreach (KeyValuePair<int, PublicBinaryArtifact> entry in snapshot.ArticleArtifacts)
        {
            PublicArtifactIntegrityContext context = PublicArtifactIntegrityContext.ForArticle(entry.Key);
            if (!IsBinarySchemaValid(entry.Value, required: true) || !IsValid(entry.Value, context))
            {
                return false;
            }
        }

        foreach (KeyValuePair<PublicListKey, PublicBinaryArtifact> entry in snapshot.ListArtifacts)
        {
            PublicArtifactIntegrityContext context = PublicArtifactIntegrityContext.ForList(entry.Key);
            if (!IsBinarySchemaValid(entry.Value, required: true) || !IsValid(entry.Value, context))
            {
                return false;
            }
        }

        if (!IsOptionalBinaryValid(snapshot.CategoryFrame, PublicArtifactIntegrityContext.ForCategory())
            || !IsOptionalBinaryValid(snapshot.TagFrame, PublicArtifactIntegrityContext.ForTag()))
        {
            return false;
        }

        foreach (KeyValuePair<string, PublicHtmlArtifact> entry in snapshot.HtmlArtifacts)
        {
            PublicArtifactIntegrityContext context = PublicArtifactIntegrityContext.ForHtml(entry.Key);
            if (!IsHtmlSchemaValid(entry.Value) || !IsValid(entry.Value, context))
            {
                return false;
            }
        }

        return true;
    }

    private static bool IsOptionalBinaryValid(
        in PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context)
        => artifact.Frame.IsEmpty
            ? artifact == default
            : IsBinarySchemaValid(artifact, required: true) && IsValid(artifact, context);

    private static bool IsBinarySchemaValid(in PublicBinaryArtifact artifact, bool required)
    {
        if (artifact.Frame.IsEmpty)
        {
            return !required
                && artifact.BrotliFrame.IsEmpty
                && artifact.GzipFrame.IsEmpty;
        }

        if (artifact.Version <= 0
            || string.IsNullOrWhiteSpace(artifact.ETag)
            || string.IsNullOrWhiteSpace(artifact.CacheControl)
            || !PublicHotReadBinaryArtifactFactory.LooksLikeExpectedAedsFrame(
                artifact.Frame.Span,
                artifact.FrameType))
        {
            return false;
        }

        return IsCompressedSchemaValid(
                artifact.BrotliFrame,
                artifact.BrotliETag,
                artifact.Frame,
                brotli: true)
            && IsCompressedSchemaValid(
                artifact.GzipFrame,
                artifact.GzipETag,
                artifact.Frame,
                brotli: false);
    }

    private static bool IsCompressedSchemaValid(
        ReadOnlyMemory<byte> compressed,
        string etag,
        ReadOnlyMemory<byte> expected,
        bool brotli)
    {
        if (compressed.IsEmpty)
        {
            return string.IsNullOrEmpty(etag);
        }

        if (string.IsNullOrWhiteSpace(etag))
        {
            return false;
        }

        try
        {
            if (brotli)
            {
                byte[] output = new byte[expected.Length];
                return BrotliDecoder.TryDecompress(compressed.Span, output, out int written)
                    && written == output.Length
                    && output.AsSpan().SequenceEqual(expected.Span);
            }

            using var source = new MemoryStream(compressed.ToArray(), writable: false);
            using var gzip = new GZipStream(source, CompressionMode.Decompress, leaveOpen: false);
            byte[] decoded = new byte[expected.Length];
            int offset = 0;
            while (offset < decoded.Length)
            {
                int read = gzip.Read(decoded, offset, decoded.Length - offset);
                if (read == 0)
                {
                    break;
                }
                offset += read;
            }

            return offset == decoded.Length
                && gzip.ReadByte() == -1
                && decoded.AsSpan().SequenceEqual(expected.Span);
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    private static bool IsHtmlSchemaValid(in PublicHtmlArtifact artifact)
    {
        if (artifact.Bytes.IsEmpty
            || !artifact.ContentType.StartsWith("text/html", StringComparison.OrdinalIgnoreCase)
            || string.IsNullOrWhiteSpace(artifact.ETag)
            || string.IsNullOrWhiteSpace(artifact.CacheControl))
        {
            return false;
        }

        if (artifact.CspNonceTemplate is not { } template)
        {
            return artifact.TemplateIntegrityTag.IsEmpty;
        }

        Span<byte> digest = stackalloc byte[32];
        SHA256.HashData(artifact.Bytes.Span, digest);
        return template.SlotCount > 0
            && template.ArtifactIdentity.EndsWith(Convert.ToHexStringLower(digest), StringComparison.Ordinal);
    }

    private static PublicArtifactIntegrityTag SealIfMissing(
        ReadOnlyMemory<byte> payload,
        PublicArtifactIntegrityTag current,
        in PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context,
        string contentEncoding,
        string etag)
        => payload.IsEmpty || !current.IsEmpty
            ? current
            : Compute(payload.Span, artifact, context, contentEncoding, etag);

    private static PublicArtifactIntegrityTag SealIfMissing(
        ReadOnlyMemory<byte> payload,
        PublicArtifactIntegrityTag current,
        in PublicHtmlArtifact artifact,
        in PublicArtifactIntegrityContext context,
        string representation)
        => payload.IsEmpty || !current.IsEmpty
            ? current
            : Compute(payload.Span, artifact, context, representation);

    private static bool IsValid(
        ReadOnlyMemory<byte> payload,
        PublicArtifactIntegrityTag expected,
        in PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context,
        string contentEncoding,
        string etag)
        => payload.IsEmpty
            ? expected.IsEmpty
            : !expected.IsEmpty
                && Compute(payload.Span, artifact, context, contentEncoding, etag) == expected;

    private static bool IsValid(
        ReadOnlyMemory<byte> payload,
        PublicArtifactIntegrityTag expected,
        in PublicHtmlArtifact artifact,
        in PublicArtifactIntegrityContext context,
        string representation)
        => payload.IsEmpty
            ? expected.IsEmpty
            : !expected.IsEmpty
                && Compute(payload.Span, artifact, context, representation) == expected;

    private static PublicArtifactIntegrityTag Compute(
        ReadOnlySpan<byte> payload,
        in PublicBinaryArtifact artifact,
        in PublicArtifactIntegrityContext context,
        string contentEncoding,
        string etag)
    {
        IncrementalHash hasher = Begin(context);
        try
        {
            AppendInt64(hasher, artifact.Version);
            AppendInt32(hasher, (ushort)artifact.FrameType);
            AppendString(hasher, contentEncoding);
            AppendString(hasher, etag);
            AppendString(hasher, artifact.CacheControl);
            hasher.AppendData(payload);
            return Finish(hasher);
        }
        catch
        {
            Reset(hasher);
            throw;
        }
    }

    private static PublicArtifactIntegrityTag Compute(
        ReadOnlySpan<byte> payload,
        in PublicHtmlArtifact artifact,
        in PublicArtifactIntegrityContext context,
        string representation)
    {
        IncrementalHash hasher = Begin(context);
        try
        {
            AppendString(hasher, representation);
            AppendString(hasher, artifact.ContentType);
            AppendString(hasher, artifact.ETag);
            AppendString(hasher, artifact.CacheControl);
            AppendString(hasher, artifact.RendererVersion);
            AppendString(hasher, artifact.FrontendAssetVersion);
            if (artifact.CspNonceTemplate is { } template)
            {
                AppendString(hasher, template.ArtifactIdentity);
                AppendString(hasher, template.TemplateDigest);
                AppendInt32(hasher, template.SlotCount);
                AppendInt32(hasher, template.LengthWithoutNonce);
            }
            hasher.AppendData(payload);
            return Finish(hasher);
        }
        catch
        {
            Reset(hasher);
            throw;
        }
    }

    private static IncrementalHash Begin(in PublicArtifactIntegrityContext context)
    {
        IncrementalHash hasher = s_threadHasher.Value
            ?? throw new InvalidOperationException("public hot-read integrity hasher is unavailable");
        AppendString(hasher, Algorithm);
        AppendInt32(hasher, (byte)context.RouteKind);
        AppendInt32(hasher, (byte)context.ListKind);
        AppendInt32(hasher, context.TargetId);
        AppendInt32(hasher, context.Page);
        AppendInt32(hasher, context.Size);
        AppendString(hasher, context.RouteKey);
        return hasher;
    }

    private static PublicArtifactIntegrityTag Finish(IncrementalHash hasher)
    {
        Span<byte> digest = stackalloc byte[32];
        int written = hasher.GetHashAndReset(digest);
        if (written != digest.Length)
        {
            throw new CryptographicException("public hot-read HMAC length mismatch");
        }
        return new(
            BinaryPrimitives.ReadUInt64LittleEndian(digest),
            BinaryPrimitives.ReadUInt64LittleEndian(digest[sizeof(ulong)..]));
    }

    private static void Reset(IncrementalHash hasher)
    {
        Span<byte> discard = stackalloc byte[32];
        _ = hasher.GetHashAndReset(discard);
    }

    private static void AppendInt64(IncrementalHash hasher, long value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(long)];
        BinaryPrimitives.WriteInt64LittleEndian(bytes, value);
        hasher.AppendData(bytes);
    }

    private static void AppendInt32(IncrementalHash hasher, int value)
    {
        Span<byte> bytes = stackalloc byte[sizeof(int)];
        BinaryPrimitives.WriteInt32LittleEndian(bytes, value);
        hasher.AppendData(bytes);
    }

    private static void AppendString(IncrementalHash hasher, string value)
    {
        int byteCount = Encoding.UTF8.GetByteCount(value);
        AppendInt32(hasher, byteCount);
        if (byteCount == 0)
        {
            return;
        }

        if (byteCount <= StackUtf8Bytes)
        {
            Span<byte> bytes = stackalloc byte[StackUtf8Bytes];
            int written = Encoding.UTF8.GetBytes(value, bytes);
            hasher.AppendData(bytes[..written]);
            return;
        }

        byte[] rented = ArrayPool<byte>.Shared.Rent(byteCount);
        try
        {
            int written = Encoding.UTF8.GetBytes(value, rented);
            hasher.AppendData(rented.AsSpan(0, written));
        }
        finally
        {
            CryptographicOperations.ZeroMemory(rented.AsSpan(0, byteCount));
            ArrayPool<byte>.Shared.Return(rented);
        }
    }
}
