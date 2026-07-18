using System.Collections.Frozen;
using System.Buffers;
using System.Buffers.Binary;
using System.Diagnostics.Metrics;
using System.IO.Compression;
using System.IO.Pipelines;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Middlewares;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;
using Microsoft.AspNetCore.Hosting;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Options;
using Microsoft.Extensions.Primitives;

namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

public readonly record struct PublicHotReadCounterSnapshot(
    long ArticleHit,
    long ArticleMiss,
    long ListHit,
    long ListMiss,
    long HtmlHit,
    long HtmlMiss,
    long Rejected,
    long Bytes,
    long IdentityVariant,
    long BrotliVariant,
    long GzipVariant,
    long SanityFallback);

public sealed class PublicHotReadCounters
{
    private readonly CounterStripe[] _stripes = BuildStripes();
    private readonly PublicHotReadCounterMode _mode;
    private readonly int _sampleRate;

    public PublicHotReadCounters(IOptions<PublicHotReadOptions>? options = null)
    {
        PublicHotReadOptions value = options?.Value ?? new PublicHotReadOptions();
        _mode = value.CounterMode;
        _sampleRate = Math.Clamp(value.CounterSampleRate, 1, 4096);
    }

    public void ArticleHit(int bytes)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.ArticleHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void ArticleMiss() => Interlocked.Increment(ref PickStripe().ArticleMiss);
    public void ListHit(int bytes)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.ListHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void ListMiss() => Interlocked.Increment(ref PickStripe().ListMiss);
    public void HtmlHit(int bytes)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        Interlocked.Increment(ref stripe.HtmlHit);
        Interlocked.Add(ref stripe.Bytes, bytes);
    }

    public void HtmlMiss() => Interlocked.Increment(ref PickStripe().HtmlMiss);
    public void Rejected() => Interlocked.Increment(ref PickStripe().Rejected);
    public void SanityFallback() => Interlocked.Increment(ref PickStripe().SanityFallback);
    public void VariantSelected(string contentEncoding)
    {
        if (!ShouldRecordHit())
        {
            return;
        }

        CounterStripe stripe = PickStripe();
        if (string.Equals(contentEncoding, "br", StringComparison.Ordinal))
        {
            Interlocked.Increment(ref stripe.BrotliVariant);
        }
        else if (string.Equals(contentEncoding, "gzip", StringComparison.Ordinal))
        {
            Interlocked.Increment(ref stripe.GzipVariant);
        }
        else
        {
            Interlocked.Increment(ref stripe.IdentityVariant);
        }
    }

    public PublicHotReadCounterSnapshot Snapshot()
        => Collect(reset: false);

    public PublicHotReadCounterSnapshot CollectAndReset()
        => Collect(reset: true);

    private PublicHotReadCounterSnapshot Collect(bool reset)
    {
        long articleHit = 0;
        long articleMiss = 0;
        long listHit = 0;
        long listMiss = 0;
        long htmlHit = 0;
        long htmlMiss = 0;
        long rejected = 0;
        long bytes = 0;
        long identityVariant = 0;
        long brotliVariant = 0;
        long gzipVariant = 0;
        long sanityFallback = 0;

        foreach (CounterStripe stripe in _stripes)
        {
            articleHit += reset ? Interlocked.Exchange(ref stripe.ArticleHit, 0) : Volatile.Read(ref stripe.ArticleHit);
            articleMiss += reset ? Interlocked.Exchange(ref stripe.ArticleMiss, 0) : Volatile.Read(ref stripe.ArticleMiss);
            listHit += reset ? Interlocked.Exchange(ref stripe.ListHit, 0) : Volatile.Read(ref stripe.ListHit);
            listMiss += reset ? Interlocked.Exchange(ref stripe.ListMiss, 0) : Volatile.Read(ref stripe.ListMiss);
            htmlHit += reset ? Interlocked.Exchange(ref stripe.HtmlHit, 0) : Volatile.Read(ref stripe.HtmlHit);
            htmlMiss += reset ? Interlocked.Exchange(ref stripe.HtmlMiss, 0) : Volatile.Read(ref stripe.HtmlMiss);
            rejected += reset ? Interlocked.Exchange(ref stripe.Rejected, 0) : Volatile.Read(ref stripe.Rejected);
            bytes += reset ? Interlocked.Exchange(ref stripe.Bytes, 0) : Volatile.Read(ref stripe.Bytes);
            identityVariant += reset ? Interlocked.Exchange(ref stripe.IdentityVariant, 0) : Volatile.Read(ref stripe.IdentityVariant);
            brotliVariant += reset ? Interlocked.Exchange(ref stripe.BrotliVariant, 0) : Volatile.Read(ref stripe.BrotliVariant);
            gzipVariant += reset ? Interlocked.Exchange(ref stripe.GzipVariant, 0) : Volatile.Read(ref stripe.GzipVariant);
            sanityFallback += reset ? Interlocked.Exchange(ref stripe.SanityFallback, 0) : Volatile.Read(ref stripe.SanityFallback);
        }

        return new PublicHotReadCounterSnapshot(
            articleHit,
            articleMiss,
            listHit,
            listMiss,
            htmlHit,
            htmlMiss,
            rejected,
            bytes,
            identityVariant,
            brotliVariant,
            gzipVariant,
            sanityFallback);
    }

    private CounterStripe PickStripe()
    {
        int index = Environment.CurrentManagedThreadId % _stripes.Length;
        return _stripes[index];
    }

    private bool ShouldRecordHit()
        => _mode switch
        {
            PublicHotReadCounterMode.Off => false,
            PublicHotReadCounterMode.Sampled => (Environment.TickCount & int.MaxValue) % _sampleRate == 0,
            _ => true
        };

    private static CounterStripe[] BuildStripes()
    {
        int count = Math.Max(2, Environment.ProcessorCount * 2);
        CounterStripe[] stripes = new CounterStripe[count];
        for (int i = 0; i < stripes.Length; i++)
        {
            stripes[i] = new CounterStripe();
        }

        return stripes;
    }

    [StructLayout(LayoutKind.Explicit, Size = 128)]
    private sealed class CounterStripe
    {
        [FieldOffset(0)] public long ArticleHit;
        [FieldOffset(8)] public long ArticleMiss;
        [FieldOffset(16)] public long ListHit;
        [FieldOffset(24)] public long ListMiss;
        [FieldOffset(32)] public long HtmlHit;
        [FieldOffset(40)] public long HtmlMiss;
        [FieldOffset(48)] public long Rejected;
        [FieldOffset(56)] public long Bytes;
        [FieldOffset(64)] public long IdentityVariant;
        [FieldOffset(72)] public long BrotliVariant;
        [FieldOffset(80)] public long GzipVariant;
        [FieldOffset(88)] public long SanityFallback;
    }
}

public sealed class PublicHotReadMetricFlushWorker(
    PublicHotReadCounters counters,
    PublicHotReadClassifierCounters classifierCounters,
    ILogger<PublicHotReadMetricFlushWorker> logger) : BackgroundService
{
    private static readonly Meter Meter = new("FsusBlog.PublicHotRead", "1.0.0");
    private static readonly Counter<long> ArticleHitCounter = Meter.CreateCounter<long>("fsus.hotread.article.hit");
    private static readonly Counter<long> ArticleMissCounter = Meter.CreateCounter<long>("fsus.hotread.article.miss");
    private static readonly Counter<long> ListHitCounter = Meter.CreateCounter<long>("fsus.hotread.list.hit");
    private static readonly Counter<long> ListMissCounter = Meter.CreateCounter<long>("fsus.hotread.list.miss");
    private static readonly Counter<long> HtmlHitCounter = Meter.CreateCounter<long>("fsus.hotread.html.hit");
    private static readonly Counter<long> HtmlMissCounter = Meter.CreateCounter<long>("fsus.hotread.html.miss");
    private static readonly Counter<long> BytesCounter = Meter.CreateCounter<long>("fsus.hotread.bytes");
    private static readonly Counter<long> IdentityVariantCounter = Meter.CreateCounter<long>("fsus.hotread.encoding.identity");
    private static readonly Counter<long> BrotliVariantCounter = Meter.CreateCounter<long>("fsus.hotread.encoding.br");
    private static readonly Counter<long> GzipVariantCounter = Meter.CreateCounter<long>("fsus.hotread.encoding.gzip");
    private static readonly Counter<long> SanityFallbackCounter = Meter.CreateCounter<long>("fsus.hotread.sanity.fallback");
    private static readonly Counter<long> SensitivePrefixBypassCounter =
        Meter.CreateCounter<long>("fsus.hotread.classifier.sensitive_bypass");
    private static readonly Counter<long> CredentialBypassCounter =
        Meter.CreateCounter<long>("fsus.hotread.classifier.credential_bypass");

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(1));
        try
        {
            while (await timer.WaitForNextTickAsync(stoppingToken).ConfigureAwait(false))
            {
                Flush();
            }
        }
        catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
        {
            Flush();
        }
    }

    private void Flush()
    {
        PublicHotReadCounterSnapshot snapshot = counters.CollectAndReset();
        long sensitivePrefixBypass = classifierCounters.CollectSensitivePrefixBypassAndReset();
        long credentialBypass = classifierCounters.CollectCredentialBypassAndReset();
        AddIfPositive(ArticleHitCounter, snapshot.ArticleHit);
        AddIfPositive(ArticleMissCounter, snapshot.ArticleMiss);
        AddIfPositive(ListHitCounter, snapshot.ListHit);
        AddIfPositive(ListMissCounter, snapshot.ListMiss);
        AddIfPositive(HtmlHitCounter, snapshot.HtmlHit);
        AddIfPositive(HtmlMissCounter, snapshot.HtmlMiss);
        AddIfPositive(BytesCounter, snapshot.Bytes);
        AddIfPositive(IdentityVariantCounter, snapshot.IdentityVariant);
        AddIfPositive(BrotliVariantCounter, snapshot.BrotliVariant);
        AddIfPositive(GzipVariantCounter, snapshot.GzipVariant);
        AddIfPositive(SanityFallbackCounter, snapshot.SanityFallback);
        AddIfPositive(SensitivePrefixBypassCounter, sensitivePrefixBypass);
        AddIfPositive(CredentialBypassCounter, credentialBypass);
        if (snapshot.Rejected > 0)
        {
            logger.LogDebug("public-hot-read-rejected {Count}", snapshot.Rejected);
        }
        if (sensitivePrefixBypass > 0)
        {
            logger.LogWarning(
                "public-hot-read-sensitive-prefix-bypass {Count}",
                sensitivePrefixBypass);
        }
        if (credentialBypass > 0)
        {
            logger.LogInformation(
                "public-hot-read-credential-bypass {Count}",
                credentialBypass);
        }
    }

    private static void AddIfPositive(Counter<long> counter, long value)
    {
        if (value > 0)
        {
            counter.Add(value);
        }
    }
}

internal static class PublicHotReadHtmlArtifactFactory
{
    internal static PublicHtmlArtifact FromHtml(
        string html,
        string cacheControl,
        string rendererVersion = "",
        string frontendAssetVersion = "")
    {
        byte[] bytes = Encoding.UTF8.GetBytes(html);
        string etag = CreateEtag(bytes);
        CspNonceUtf8Template? nonceTemplate = CspNonceUtf8Template.Compile(
            html,
            string.Concat("hot:sha256:", CreateDigest(bytes)));
        return new PublicHtmlArtifact(
            bytes,
            "text/html; charset=utf-8",
            etag,
            cacheControl,
            nonceTemplate,
            rendererVersion,
            frontendAssetVersion);
    }

    internal static PublicHtmlArtifact FromDocument(PublicAotHtmlArtifact document, string cacheControl)
    {
        return new PublicHtmlArtifact(
            document.Utf8Bytes,
            string.IsNullOrWhiteSpace(document.ContentType) ? "text/html; charset=utf-8" : document.ContentType,
            document.ETag,
            string.IsNullOrWhiteSpace(cacheControl) ? document.CacheControl : cacheControl,
            document.CspNonceTemplate,
            document.RendererVersion,
            document.FrontendAssetVersion);
    }

    private static string CreateEtag(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return string.Concat("\"", Convert.ToHexStringLower(hash[..8]), "\"");
    }

    private static string CreateDigest(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return Convert.ToHexStringLower(hash);
    }

}

internal static class PublicHotReadRouteKeys
{
    private const string HtmlPrefix = "/api/binary/article/html/";
    private const string HtmlSuffix = ".html";

    internal static PublicHtmlRouteIndex CreateHtmlIndex(string routeKey, PublicPageId pageId)
    {
        string normalizedRouteKey = routeKey.Trim();
        PublicPageId normalizedPageId = Enum.IsDefined(typeof(PublicPageId), pageId) ? pageId : PublicPageId.Home;
        return new PublicHtmlRouteIndex(
            normalizedRouteKey,
            HtmlPathKey(normalizedRouteKey),
            normalizedPageId);
    }

    internal static string HtmlPath(string routeKey)
        => string.Concat(HtmlPrefix, HtmlPathKey(routeKey), HtmlSuffix);

    internal static string HtmlPathKey(string routeKey)
    {
        string trimmed = routeKey.Trim();
        if (TryExtractPathKey(trimmed, out string existingPathKey))
        {
            return existingPathKey;
        }

        if (trimmed.StartsWith(PublicRouteIdentityRegistry.TagNameBucket + ":", StringComparison.Ordinal))
        {
            return string.Concat(PublicRouteIdentityRegistry.TagNameBucket, "-", StableRouteHash(trimmed));
        }

        string candidate = trimmed.Replace(':', '-').ToLowerInvariant();
        if (IsSafePathKey(candidate.AsSpan()))
        {
            return candidate;
        }

        return string.Concat("route-", StableRouteHash(trimmed));
    }

    internal static bool IsSafePathKey(ReadOnlySpan<char> value)
    {
        if (value.IsEmpty)
        {
            return false;
        }

        for (int i = 0; i < value.Length; i++)
        {
            char c = value[i];
            if ((uint)(c - 'a') <= 25
                || (uint)(c - '0') <= 9
                || c == '-'
                || c == '_')
            {
                continue;
            }

            return false;
        }

        return true;
    }

    private static bool TryExtractPathKey(string routeKey, out string pathKey)
    {
        pathKey = string.Empty;
        if (!routeKey.StartsWith(HtmlPrefix, StringComparison.Ordinal)
            || !routeKey.EndsWith(HtmlSuffix, StringComparison.Ordinal)
            || routeKey.Length <= HtmlPrefix.Length + HtmlSuffix.Length)
        {
            return false;
        }

        string candidate = routeKey[HtmlPrefix.Length..^HtmlSuffix.Length];
        if (!IsSafePathKey(candidate.AsSpan()))
        {
            pathKey = string.Concat("route-", StableRouteHash(routeKey));
            return true;
        }

        pathKey = candidate;
        return true;
    }

    private static string StableRouteHash(string routeKey)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(Encoding.UTF8.GetBytes(routeKey), hash);
        return Convert.ToHexStringLower(hash[..8]);
    }
}

internal static class PublicHotReadBinaryArtifactFactory
{
    internal static PublicBinaryArtifact FromPayload(
        IAedsEncoder encoder,
        AedsFrameType frameType,
        byte[] payload,
        string cacheControl,
        long version,
        PublicHotReadOptions options)
    {
        byte[] frame = encoder.Encode(frameType, payload);
        return FromFrame(frame, frameType, cacheControl, version, options);
    }

    internal static PublicBinaryArtifact FromWriter(
        AedsFrameType frameType,
        Action<IBufferWriter<byte>> writePayload,
        string cacheControl,
        long version,
        PublicHotReadOptions options)
    {
        using var frameWriter = new AedsFrameBufferWriter();
        writePayload(frameWriter.PayloadWriter);
        frameWriter.Seal(frameType);
        byte[] frame = frameWriter.WrittenFrame.ToArray();
        return FromFrame(frame, frameType, cacheControl, version, options);
    }

    private static PublicBinaryArtifact FromFrame(
        byte[] frame,
        AedsFrameType frameType,
        string cacheControl,
        long version,
        PublicHotReadOptions options)
    {
        if (frame.Length > options.MaxFrameBytes)
        {
            throw new InvalidOperationException($"public hot-read frame too large: {frameType} {frame.Length} bytes");
        }

        if (!LooksLikeExpectedAedsFrame(frame, frameType))
        {
            throw new InvalidOperationException($"public hot-read frame validation failed: {frameType}");
        }

        string etag = CreateEtag(frame);
        ReadOnlyMemory<byte> brotliFrame = default;
        string brotliEtag = string.Empty;
        ReadOnlyMemory<byte> gzipFrame = default;
        string gzipEtag = string.Empty;
        if (options.EnablePrecompressedBinaryVariants && frame.Length >= options.MinPrecompressedFrameBytes)
        {
            int minimumShare = Math.Clamp(options.MinResidentVariantClientSharePercent, 0, 100);
            int minimumSavings = Math.Clamp(options.MinCompressionSavingsPercent, 0, 99);
            byte[]? compressedBrotli = options.ExpectedBrotliClientSharePercent >= minimumShare
                ? TryCompress(frame, "br", minimumSavings)
                : null;
            if (compressedBrotli is { Length: > 0 })
            {
                brotliFrame = compressedBrotli;
                brotliEtag = CreateEtag(compressedBrotli);
            }

            byte[]? compressedGzip = options.ExpectedGzipClientSharePercent >= minimumShare
                ? TryCompress(frame, "gzip", minimumSavings)
                : null;
            if (compressedGzip is { Length: > 0 })
            {
                gzipFrame = compressedGzip;
                gzipEtag = CreateEtag(compressedGzip);
            }
        }

        return new PublicBinaryArtifact(frame, etag, cacheControl, version, frameType, brotliFrame, brotliEtag, gzipFrame, gzipEtag);
    }

    private static string CreateEtag(ReadOnlySpan<byte> bytes)
    {
        Span<byte> hash = stackalloc byte[32];
        SHA256.HashData(bytes, hash);
        return string.Concat("\"", Convert.ToHexStringLower(hash[..8]), "\"");
    }

    private static byte[]? TryCompress(ReadOnlySpan<byte> frame, string encoding, int minimumSavingsPercent)
    {
        using var output = new MemoryStream();
        if (encoding == "br")
        {
            using (var brotli = new BrotliStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                brotli.Write(frame);
            }
        }
        else
        {
            using (var gzip = new GZipStream(output, CompressionLevel.SmallestSize, leaveOpen: true))
            {
                gzip.Write(frame);
            }
        }

        long savedBytes = frame.Length - output.Length;
        if (savedBytes <= 0 || (savedBytes * 100) < ((long)frame.Length * minimumSavingsPercent))
        {
            return null;
        }

        return output.ToArray();
    }

    internal static bool LooksLikeExpectedAedsFrame(ReadOnlySpan<byte> frame, AedsFrameType expectedFrameType)
    {
        if (frame.Length < AedsFrameHeader.Size)
        {
            return false;
        }

        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(frame[0..4]);
        if (magic != AedsEncoder.Magic
            || frame[4] != AedsFrameHeader.CurrentVersion
            || frame[5] != AedsFrameHeader.Size)
        {
            return false;
        }

        ushort frameType = BinaryPrimitives.ReadUInt16LittleEndian(frame[8..10]);
        uint payloadLength = BinaryPrimitives.ReadUInt32LittleEndian(frame[10..14]);
        if (frameType != (ushort)expectedFrameType || payloadLength != (uint)(frame.Length - AedsFrameHeader.Size))
        {
            return false;
        }

        ushort expectedCrc = BinaryPrimitives.ReadUInt16LittleEndian(frame[14..16]);
        return expectedCrc == AedsCrc16.Compute(frame[AedsFrameHeader.Size..]);
    }
}
