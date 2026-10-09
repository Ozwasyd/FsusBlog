using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Frozen;
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
using FsusBlog.Server.Infrastructure.Memory.Transient;
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
    long SanityFallback,
    long FreshL0Hit = 0,
    long LastGoodHit = 0,
    long LastGoodWhileRebuild = 0,
    PublicHotReadHitRateReceipt HitRate = default);

public sealed class PublicHotReadCounters
{
    private readonly CounterStripe[] _stripes = BuildStripes();
    private readonly PublicHotReadCounterMode _mode;
    private readonly int _sampleRate;
    private long _articleHitAttempts;
    private long _listHitAttempts;
    private long _htmlHitAttempts;
    private long _variantAttempts;

    public PublicHotReadCounters(IOptions<PublicHotReadOptions>? options = null)
    {
        PublicHotReadOptions value = options?.Value ?? new PublicHotReadOptions();
        _mode = value.CounterMode;
        _sampleRate = Math.Clamp(value.CounterSampleRate, 1, 4096);
    }

    public void ArticleHit(int bytes)
    {
        if (!ObserveHit(HitFamily.Article))
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
        if (!ObserveHit(HitFamily.List))
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
        if (!ObserveHit(HitFamily.Html))
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
    public void FreshL0Hit() => Interlocked.Increment(ref PickStripe().FreshL0Hit);
    public void LastGoodHit() => Interlocked.Increment(ref PickStripe().LastGoodHit);
    public void LastGoodWhileRebuild() => Interlocked.Increment(ref PickStripe().LastGoodWhileRebuild);
    public void VariantSelected(string contentEncoding)
    {
        if (!ObserveHit(HitFamily.Variant))
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
        long freshL0Hit = 0;
        long lastGoodHit = 0;
        long lastGoodWhileRebuild = 0;

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
            freshL0Hit += reset ? Interlocked.Exchange(ref stripe.FreshL0Hit, 0) : Volatile.Read(ref stripe.FreshL0Hit);
            lastGoodHit += reset ? Interlocked.Exchange(ref stripe.LastGoodHit, 0) : Volatile.Read(ref stripe.LastGoodHit);
            lastGoodWhileRebuild += reset ? Interlocked.Exchange(ref stripe.LastGoodWhileRebuild, 0) : Volatile.Read(ref stripe.LastGoodWhileRebuild);
        }

        long calibratedArticleHit = PublicHotReadHitRateAccounting.ScaleHitSamples(articleHit, _mode, _sampleRate);
        long calibratedListHit = PublicHotReadHitRateAccounting.ScaleHitSamples(listHit, _mode, _sampleRate);
        long calibratedHtmlHit = PublicHotReadHitRateAccounting.ScaleHitSamples(htmlHit, _mode, _sampleRate);
        long observedHitSamples = articleHit + listHit + htmlHit;
        long calibratedHits = calibratedArticleHit + calibratedListHit + calibratedHtmlHit;
        long exactMisses = articleMiss + listMiss + htmlMiss;
        return new PublicHotReadCounterSnapshot(
            calibratedArticleHit,
            articleMiss,
            calibratedListHit,
            listMiss,
            calibratedHtmlHit,
            htmlMiss,
            rejected,
            PublicHotReadHitRateAccounting.ScaleHitSamples(bytes, _mode, _sampleRate),
            PublicHotReadHitRateAccounting.ScaleHitSamples(identityVariant, _mode, _sampleRate),
            PublicHotReadHitRateAccounting.ScaleHitSamples(brotliVariant, _mode, _sampleRate),
            PublicHotReadHitRateAccounting.ScaleHitSamples(gzipVariant, _mode, _sampleRate),
            sanityFallback,
            freshL0Hit,
            lastGoodHit,
            lastGoodWhileRebuild,
            PublicHotReadHitRateAccounting.Create(
                _mode,
                _sampleRate,
                observedHitSamples,
                calibratedHits,
                exactMisses));
    }

    private CounterStripe PickStripe()
    {
        int index = Environment.CurrentManagedThreadId % _stripes.Length;
        return _stripes[index];
    }

    private bool ObserveHit(HitFamily family)
    {
        if (_mode == PublicHotReadCounterMode.Off)
        {
            return false;
        }

        if (_mode != PublicHotReadCounterMode.Sampled)
        {
            return true;
        }

        long attempt = family switch
        {
            HitFamily.Article => Interlocked.Increment(ref _articleHitAttempts),
            HitFamily.List => Interlocked.Increment(ref _listHitAttempts),
            HitFamily.Html => Interlocked.Increment(ref _htmlHitAttempts),
            _ => Interlocked.Increment(ref _variantAttempts)
        };
        return attempt % _sampleRate == 0;
    }

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

    private enum HitFamily : byte
    {
        Article = 0,
        List = 1,
        Html = 2,
        Variant = 3
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
        [FieldOffset(96)] public long FreshL0Hit;
        [FieldOffset(104)] public long LastGoodHit;
        [FieldOffset(112)] public long LastGoodWhileRebuild;
    }
}

public sealed class PublicHotReadMetricFlushWorker(
    PublicHotReadCounters counters,
    PublicHotReadClassifierCounters classifierCounters,
    ILogger<PublicHotReadMetricFlushWorker> logger) : BackgroundService
{
    private static readonly Meter s_meter = new("FsusBlog.PublicHotRead", "1.0.0");
    private static readonly Counter<long> s_articleHitCounter = s_meter.CreateCounter<long>("fsus.hotread.article.hit");
    private static readonly Counter<long> s_articleMissCounter = s_meter.CreateCounter<long>("fsus.hotread.article.miss");
    private static readonly Counter<long> s_listHitCounter = s_meter.CreateCounter<long>("fsus.hotread.list.hit");
    private static readonly Counter<long> s_listMissCounter = s_meter.CreateCounter<long>("fsus.hotread.list.miss");
    private static readonly Counter<long> s_htmlHitCounter = s_meter.CreateCounter<long>("fsus.hotread.html.hit");
    private static readonly Counter<long> s_htmlMissCounter = s_meter.CreateCounter<long>("fsus.hotread.html.miss");
    private static readonly Counter<long> s_bytesCounter = s_meter.CreateCounter<long>("fsus.hotread.bytes");
    private static readonly Counter<long> s_identityVariantCounter = s_meter.CreateCounter<long>("fsus.hotread.encoding.identity");
    private static readonly Counter<long> s_brotliVariantCounter = s_meter.CreateCounter<long>("fsus.hotread.encoding.br");
    private static readonly Counter<long> s_gzipVariantCounter = s_meter.CreateCounter<long>("fsus.hotread.encoding.gzip");
    private static readonly Counter<long> s_sanityFallbackCounter = s_meter.CreateCounter<long>("fsus.hotread.sanity.fallback");
    private static readonly Counter<long> s_freshL0HitCounter = s_meter.CreateCounter<long>("fsus.hotread.fresh.hit");
    private static readonly Counter<long> s_lastGoodHitCounter = s_meter.CreateCounter<long>("fsus.hotread.last_good.hit");
    private static readonly Counter<long> s_lastGoodWhileRebuildCounter = s_meter.CreateCounter<long>("fsus.hotread.last_good.while_rebuild");
    private static readonly Counter<long> s_sensitivePrefixBypassCounter =
        s_meter.CreateCounter<long>("fsus.hotread.classifier.sensitive_bypass");
    private static readonly Counter<long> s_credentialBypassCounter =
        s_meter.CreateCounter<long>("fsus.hotread.classifier.credential_bypass");

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
        AddIfPositive(s_articleHitCounter, snapshot.ArticleHit);
        AddIfPositive(s_articleMissCounter, snapshot.ArticleMiss);
        AddIfPositive(s_listHitCounter, snapshot.ListHit);
        AddIfPositive(s_listMissCounter, snapshot.ListMiss);
        AddIfPositive(s_htmlHitCounter, snapshot.HtmlHit);
        AddIfPositive(s_htmlMissCounter, snapshot.HtmlMiss);
        AddIfPositive(s_bytesCounter, snapshot.Bytes);
        AddIfPositive(s_identityVariantCounter, snapshot.IdentityVariant);
        AddIfPositive(s_brotliVariantCounter, snapshot.BrotliVariant);
        AddIfPositive(s_gzipVariantCounter, snapshot.GzipVariant);
        AddIfPositive(s_sanityFallbackCounter, snapshot.SanityFallback);
        AddIfPositive(s_freshL0HitCounter, snapshot.FreshL0Hit);
        AddIfPositive(s_lastGoodHitCounter, snapshot.LastGoodHit);
        AddIfPositive(s_lastGoodWhileRebuildCounter, snapshot.LastGoodWhileRebuild);
        AddIfPositive(s_sensitivePrefixBypassCounter, sensitivePrefixBypass);
        AddIfPositive(s_credentialBypassCounter, credentialBypass);
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

    internal static string LocalizeHtmlPath(string htmlPath, string locale)
    {
        if (!htmlPath.StartsWith(HtmlPrefix, StringComparison.Ordinal)
            || !htmlPath.EndsWith(HtmlSuffix, StringComparison.Ordinal))
        {
            return string.Empty;
        }

        return string.Concat(
            htmlPath.AsSpan(0, htmlPath.Length - HtmlSuffix.Length),
            "-locale-",
            locale.ToLowerInvariant(),
            HtmlSuffix);
    }

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
    /// <summary>
    /// Encodes into the caller's admitted lease and awaits a consumer under its operation hold.
    /// The caller keeps the payload stable and charged through completion. The frame borrows
    /// the callback memory; it cannot become a published artifact or outlive the callback.
    /// </summary>
    internal static ValueTask ConsumeReservedPayloadAsync(
        IAedsEncoder encoder,
        AedsFrameType frameType,
        ReadOnlyMemory<byte> payload,
        TransientBufferLease destination,
        PublicHotReadOptions options,
        Func<ReadOnlyMemory<byte>, CancellationToken, ValueTask> consumer,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(encoder);
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(consumer);
        int frameLength = ReservedAedsFrameWriter.GetFrameLength(payload.Length, options);
        cancellationToken.ThrowIfCancellationRequested();
        if (destination.Memory.Length < frameLength)
        {
            throw new ArgumentException("Admitted lease is too small for the AEDS frame.", nameof(destination));
        }

        return destination.ConsumeAsync(async (memory, token) =>
        {
            token.ThrowIfCancellationRequested();
            if (payload.Span.Overlaps(memory.Span))
            {
                throw new ArgumentException("AEDS source and reserved destination must not overlap.", nameof(payload));
            }

            ReadOnlyMemory<byte> frame = ReservedAedsFrameWriter.WriteFrame(encoder, frameType, payload.Span, memory, options);
            if (!LooksLikeExpectedAedsFrame(frame.Span, frameType))
            {
                throw new InvalidOperationException("Reserved AEDS frame validation failed.");
            }

            // The existing operation hold covers encoding and the consumer's terminal event.
            await consumer(frame, token).ConfigureAwait(false);
        }, cancellationToken);
    }

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
