using System.Buffers;
using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipelines;
using System.Net;
using System.Runtime.CompilerServices;
using System.Security.Cryptography;
using System.Text;

using BenchmarkDotNet.Attributes;
using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Caching.Memory;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.Logging.Abstractions;

[MemoryDiagnoser]
public class PublicHotReadEarlyDataPlaneBenchmarks
{
    private readonly DefaultHttpContext _context = CreateContext();
    private readonly RequestDelegate _legacyPipeline;

    public PublicHotReadEarlyDataPlaneBenchmarks()
    {
        RequestDelegate terminal = static context =>
        {
            string path = context.Request.Path.Value!;
            _ = PublicHotReadFastPath.TryClassifyRouteForTests(path, out _);
            _ = PublicHotReadFastPath.TryClassifyRouteForTests(path, out _);
            return Task.CompletedTask;
        };

        for (int i = 0; i < 11; i++)
        {
            terminal = WrapGenericMiddleware(terminal);
        }

        _legacyPipeline = terminal;
    }

    [Benchmark(Baseline = true)]
    public Task Legacy_GenericPipelineAndDoubleClassification()
        => _legacyPipeline(_context);

    [Benchmark]
    public bool Current_EarlySingleClassificationFeature()
        => PublicHotReadFastPath.TryCreateRequestFeatureForTests(_context, out PublicHotReadRequestFeature? feature)
            && feature is { ClassificationCount: 1, RouteKind: PublicHotReadRouteKind.ArticleDetail };

    private static RequestDelegate WrapGenericMiddleware(RequestDelegate next)
        => context => InvokeGenericMiddlewareAsync(context, next);

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static async Task InvokeGenericMiddlewareAsync(HttpContext context, RequestDelegate next)
        => await next(context).ConfigureAwait(false);

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        context.Request.Path = "/api/binary/article/42.aeds";
        return context;
    }
}

[MemoryDiagnoser]
public class CacheAndFrameFixedCostHotPathBenchmarks
{
    private const int Identity = 42;
    private const string PolicyName = "ArticleDetailFrame";
    private readonly CachePolicy _policy = new(
        CachePolicyId.ArticleDetailFrame,
        "blog",
        "article-detail-frame",
        TimeSpan.FromMinutes(5),
        TimeSpan.FromHours(1));
    private readonly byte[] _payload = Encoding.UTF8.GetBytes(new string('f', 512));
    private readonly byte[] _preencodedFrame;
    private readonly MemoryCache _legacyL1 = new(new MemoryCacheOptions());
    private readonly ConcurrentDictionary<CacheL1Key, byte[]> _structuredL1 = new();
    private readonly long _structuredL1ExpiresAt = Stopwatch.GetTimestamp() + (Stopwatch.Frequency * 300L);
    private readonly ConcurrentDictionary<string, long> _legacyCounters = new(StringComparer.Ordinal);
    private long _legacyAtomicCounter;

    public CacheAndFrameFixedCostHotPathBenchmarks()
    {
        _preencodedFrame = new AedsEncoder().Encode(AedsFrameType.ArticleDetail, _payload);
        _legacyL1.Set(_policy.BuildKey(Identity.ToString(System.Globalization.CultureInfo.InvariantCulture)), _preencodedFrame);
        _structuredL1[CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, Identity)] = _preencodedFrame;
        FsusObservability.RecordCacheOperation("get_raw_readonly", PolicyName, "l1", "hit", TimeSpan.Zero);
    }

    [Benchmark(Baseline = true)]
    public int Legacy_L1FinalRedisStringKey()
    {
        string key = _policy.BuildKey(Identity.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return _legacyL1.TryGetValue(key, out byte[]? frame) ? frame?.Length ?? 0 : 0;
    }

    [Benchmark]
    public int Current_L1IntegerStructuredKey()
    {
        CacheL1Key key = CacheL1Key.ForInteger("runtime", CachePolicyId.ArticleDetailFrame, Identity);
        return Stopwatch.GetTimestamp() < _structuredL1ExpiresAt
            && _structuredL1.TryGetValue(key, out byte[]? frame)
                ? frame.Length
                : 0;
    }

    [Benchmark]
    public int Legacy_RawCallerCopy()
        => _preencodedFrame.ToArray().Length;

    [Benchmark]
    public int Current_RawReadonlyBorrow()
        => UnifiedCache.BorrowRawBytesReadonlyForTests(_preencodedFrame).Length;

    [Benchmark]
    public int Current_DynamicFrame()
    {
        using var writer = new AedsFrameBufferWriter(_payload.Length + AedsFrameHeader.Size);
        writer.Write(_payload);
        writer.Seal(AedsFrameType.ArticleDetail);
        return writer.WrittenFrame.Length;
    }

    [Benchmark]
    public int Current_PreencodedFrame()
        => ReadPreencodedFrameMetadata(_preencodedFrame);

    [Benchmark]
    public long Legacy_GlobalAtomicAndStringCounterKey()
    {
        Interlocked.Increment(ref _legacyAtomicCounter);
        return _legacyCounters.AddOrUpdate(
            string.Concat("get_raw_readonly", '|', PolicyName, '|', "l1", '|', "hit"),
            1,
            static (_, current) => current + 1);
    }

    [Benchmark]
    public int Current_StripedCachedTagCounter()
    {
        FsusObservability.RecordCacheOperation("get_raw_readonly", PolicyName, "l1", "hit", TimeSpan.Zero);
        return 1;
    }

    [MethodImpl(MethodImplOptions.NoInlining)]
    private static int ReadPreencodedFrameMetadata(ReadOnlySpan<byte> frame)
        => frame.Length + BinaryPrimitives.ReadUInt16LittleEndian(frame[8..10]);

    [GlobalCleanup]
    public void Cleanup() => _legacyL1.Dispose();
}

[MemoryDiagnoser]
public class CspNonceHtmlHotPathBenchmarks
{
    private const string LegacyPlaceholder = "%%FSUSBLOG_CSP_NONCE%%";
    private const string Nonce = "benchmark_nonce_0123456789";
    private readonly byte[] _legacyTemplateBytes;
    private readonly byte[] _nonceBytes = Encoding.UTF8.GetBytes(Nonce);
    private readonly CspNonceUtf8Template _template;
    private readonly ReusableBufferWriter _writer;

    public CspNonceHtmlHotPathBenchmarks()
    {
        string html = CreateRepresentativeHtml();
        _template = CspNonceUtf8Template.Compile(html, "benchmark:renderer:frontend:digest")
            ?? throw new InvalidOperationException("benchmark HTML did not produce a nonce template");
        string legacyTemplate = html
            .Replace("<head>", $"<head><meta property=\"csp-nonce\" nonce=\"{LegacyPlaceholder}\" />", StringComparison.Ordinal)
            .Replace("<script", $"<script nonce=\"{LegacyPlaceholder}\"", StringComparison.Ordinal)
            .Replace("<style", $"<style nonce=\"{LegacyPlaceholder}\"", StringComparison.Ordinal);
        _legacyTemplateBytes = Encoding.UTF8.GetBytes(legacyTemplate);
        _writer = new ReusableBufferWriter(_template.GetRenderedLength(_nonceBytes.Length));
    }

    [Benchmark(Baseline = true)]
    public int Legacy_DecodeReplaceEncodeWholeDocument()
    {
        string decoded = Encoding.UTF8.GetString(_legacyTemplateBytes);
        string rendered = decoded.Replace(LegacyPlaceholder, Nonce, StringComparison.Ordinal);
        return Encoding.UTF8.GetBytes(rendered).Length;
    }

    [Benchmark]
    public int Current_PrecompiledSegmentWriter()
    {
        _writer.Reset();
        _template.Write(_writer, _nonceBytes);
        return _writer.WrittenCount;
    }

    internal static string CreateRepresentativeHtml()
    {
        var builder = new StringBuilder(160 * 1024);
        builder.Append("<!doctype html><html><head><title>FsusBlog 性能🙂</title><style>.article{line-height:1.7}</style></head><body>");
        for (int index = 0; index < 1800; index++)
        {
            builder.Append("<p data-index=\"");
            builder.Append(index);
            builder.Append("\">public article content 中文🙂 cache hydration benchmark segment</p>");
        }

        builder.Append("<script>globalThis.__FSUSBLOG_BOOTSTRAP__={ready:true}</script></body></html>");
        return builder.ToString();
    }

    private sealed class ReusableBufferWriter(int capacity) : IBufferWriter<byte>
    {
        private readonly byte[] _buffer = new byte[capacity];
        private int _written;

        public int WrittenCount => _written;

        public void Reset() => _written = 0;

        public void Advance(int count)
        {
            if (count < 0 || _written > _buffer.Length - count)
            {
                throw new InvalidOperationException("benchmark writer capacity exceeded");
            }

            _written += count;
        }

        public Memory<byte> GetMemory(int sizeHint = 0)
        {
            EnsureCapacity(sizeHint);
            return _buffer.AsMemory(_written);
        }

        public Span<byte> GetSpan(int sizeHint = 0)
        {
            EnsureCapacity(sizeHint);
            return _buffer.AsSpan(_written);
        }

        private void EnsureCapacity(int sizeHint)
        {
            if (sizeHint < 0 || _written > _buffer.Length - sizeHint)
            {
                throw new InvalidOperationException("benchmark writer capacity exceeded");
            }
        }
    }
}

[MemoryDiagnoser]
public class RequestAuditHotPathBenchmarks
{
    private const string UserAgent = "Mozilla/5.0 FsusBlog benchmark client";
    private readonly DefaultHttpContext _context = CreateContext();

    [Benchmark(Baseline = true)]
    public int Legacy_DictionaryAndStringHash()
    {
        var properties = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["TraceId"] = _context.TraceIdentifier,
            ["RequestPath"] = _context.Request.Path.Value,
            ["RequestMethod"] = _context.Request.Method,
            ["IpHash"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(_context.Connection.RemoteIpAddress!.ToString()))),
            ["UserAgentHash"] = Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(UserAgent)))
        };
        return properties.Count;
    }

    [Benchmark]
    public int Current_ContextSnapshot()
    {
        RequestAuditContextSnapshot snapshot = RequestAuditContextSnapshot.FromHttpContext(_context);
        return snapshot.ActorType.Length + (snapshot.IpHash?.Length ?? 0) + (snapshot.UserAgentHash?.Length ?? 0);
    }

    private static DefaultHttpContext CreateContext()
    {
        var context = new DefaultHttpContext();
        context.TraceIdentifier = "benchmark-trace";
        context.Request.Method = HttpMethods.Post;
        context.Request.Path = "/api/binary/comment";
        context.Request.Headers.UserAgent = UserAgent;
        context.Connection.RemoteIpAddress = IPAddress.Parse("203.0.113.9");
        return context;
    }
}

[MemoryDiagnoser]
public class BinaryTransportHotPathBenchmarks
{
    private readonly IAedsEncoder _encoder = new AedsEncoder();
    private readonly BinaryRequestBinder _binder = new();
    private readonly byte[] _payload = Encoding.UTF8.GetBytes(new string('x', 512));
    private readonly byte[] _frame;

    public BinaryTransportHotPathBenchmarks()
    {
        _frame = _encoder.Encode(AedsFrameType.SiteSubscriptionRequest, _payload);
    }

    [Benchmark(Baseline = true)]
    public int Legacy_EncodeWithIntermediateCopies()
    {
        byte[] payloadCopy = _payload.ToArray();
        byte[] frame = _encoder.Encode(AedsFrameType.SiteSubscriptionRequest, payloadCopy);
        return frame.ToArray().Length;
    }

    [Benchmark]
    public int Current_EncodeFrame()
        => _encoder.Encode(AedsFrameType.SiteSubscriptionRequest, _payload).Length;

    [Benchmark]
    public async Task<int> Current_BindPipeReaderFrame()
    {
        var context = new DefaultHttpContext();
        context.Request.ContentType = "application/octet-stream";
        context.Request.ContentLength = _frame.Length;
        context.Request.Body = new MemoryStream(_frame, writable: false);
        BinaryRequestPayload result = await _binder.ReadFrameAsync(
            context,
            _encoder,
            AedsFrameType.SiteSubscriptionRequest,
            CancellationToken.None);
        await context.Response.CompleteAsync();
        return result.IsSuccess ? result.Payload.Length : -1;
    }
}

[MemoryDiagnoser]
public class NotificationStreamHotPathBenchmarks
{
    private const string Group = "benchmark-hot-path";
    private readonly NotificationStreamConnectionManager _manager;
    private readonly NotificationStreamConnection[] _connections;
    private readonly byte[] _payload = Encoding.UTF8.GetBytes(new string('n', 256));

    public NotificationStreamHotPathBenchmarks()
    {
        IConfiguration configuration = new ConfigurationBuilder()
            .AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["NotificationStream:QueueCapacity"] = "64",
                ["NotificationStream:MaxConnectionsGlobal"] = "64",
                ["NotificationStream:MaxConnectionsPerIp"] = "64",
                ["NotificationStream:MaxConnectionsPerAccount"] = "2"
            })
            .Build();
        _manager = new NotificationStreamConnectionManager(
            configuration,
            NullLogger<NotificationStreamConnectionManager>.Instance);
        _connections = Enumerable.Range(0, 32)
            .Select(index => _manager.RegisterConnection(
                $"benchmark-{index}",
                $"account-{index}",
                [Group],
                clientIp: "203.0.113.8"))
            .ToArray();
    }

    [Benchmark(Baseline = true)]
    public int Legacy_CopyPerSubscriber()
    {
        int deliveredBytes = 0;
        for (int i = 0; i < _connections.Length; i++)
        {
            deliveredBytes += _payload.ToArray().Length;
        }
        return deliveredBytes;
    }

    [Benchmark]
    public int Current_SharedFrameFanout()
    {
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray(_payload);
        int delivered = _manager.Publish(frame, new NotificationStreamGroupTarget(Group));
        foreach (NotificationStreamConnection connection in _connections)
        {
            if (connection.Reader.TryRead(out SharedNotificationStreamFrame? queued))
            {
                connection.AcknowledgeDequeuedFrame();
                queued.Release();
            }
        }
        frame.Release();
        return delivered;
    }

    [Benchmark]
    public int Current_FramePump()
    {
        var connection = new NotificationStreamConnection("pump", null, [], 32);
        SharedNotificationStreamFrame frame = SharedNotificationStreamFrame.FromArray(_payload);
        frame.Retain();
        connection.TryEnqueue(frame);
        connection.Reader.TryRead(out SharedNotificationStreamFrame? queued);
        PipeWriter writer = PipeWriter.Create(Stream.Null, new StreamPipeWriterOptions(leaveOpen: true));
        int written = NotificationStreamFramePump.WriteDequeuedFrame(writer, connection, queued!);
        frame.Release();
        return written;
    }
}

[MemoryDiagnoser]
public class ReadModelProjectionHotPathBenchmarks
{
    private readonly ArticleListPageReadModel _page = new()
    {
        Total = 64,
        HasMore = true,
        NextCursor = "benchmark-cursor",
        Items = Enumerable.Range(1, 64).Select(static id => new ArticleListItemReadModel
        {
            Id = id,
            Title = $"Article {id}",
            Summary = "summary",
            Snippet = "snippet",
            Views = id * 10,
            CreateTime = DateTime.UnixEpoch.AddDays(id),
            CategoryId = id % 5,
            CategoryName = $"Category {id % 5}",
            Tags = [new TagReadModel { Id = id, Name = "benchmark" }],
            Status = ArticleStatus.Published
        }).ToList()
    };

    [Benchmark(Baseline = true)]
    public int Legacy_LinqProjection()
        => _page.Items.Select(ArticleProjection.ToResponse).ToList().Count;

    [Benchmark]
    public int Current_PreSizedProjection()
        => ArticleProjection.ToResponsePage(_page).Items.Count;
}

[MemoryDiagnoser]
public class RelatedReadingHotPathBenchmarks
{
    private const string Title = "PostgreSQL cache concurrency and binary transport";
    private const string Summary = "Notification fanout and related reading scoring";
    private readonly string[] _keywords = RelatedReadingService.ExtractKeywords(Title, Summary);

    [Benchmark(Baseline = true)]
    public int Legacy_SplitAndContainsScoring()
    {
        string[] words = string.Concat(Title, " ", Summary)
            .ToLowerInvariant()
            .Split(' ', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
        return words.Count(word => Summary.Contains(word, StringComparison.OrdinalIgnoreCase));
    }

    [Benchmark]
    public int Current_BoundedScoring()
    {
        RelatedReadingBenchmarkResult result = RelatedReadingService.ScoreCandidateForBenchmark(
            2,
            DateTime.UnixEpoch.AddDays(100),
            [1, 2, 3],
            2,
            DateTime.UnixEpoch.AddDays(96),
            [2, 3, 4],
            Title,
            Summary,
            _keywords);
        return result.Score;
    }
}

[MemoryDiagnoser]
public class StatsProjectionHotPathBenchmarks
{
    private static readonly DateTime CreatedAt = DateTime.UnixEpoch.AddDays(20_000);

    [Benchmark(Baseline = true)]
    public int Legacy_DictionaryProjection()
    {
        var item = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["author"] = "Benchmark User",
            ["mode"] = "anonymous",
            ["badge"] = "访客",
            ["content"] = "benchmark comment",
            ["createdAt"] = CreatedAt
        };
        return item.Count;
    }

    [Benchmark]
    public int Current_ValueProjection()
    {
        var item = StatsService.CreateRecentCommentStatItem(
            "anonymous",
            null,
            "Benchmark User",
            "site",
            "benchmark comment",
            CreatedAt);
        return item.Content.Length + item.AuthorDisplayName.Length;
    }
}

[MemoryDiagnoser]
public class CrawlerNormalizationHotPathBenchmarks
{
    private const string UserAgent = "Mozilla/5.0 \u200BGoogleBot/2.1 (+https://www.google.com/bot.html)";

    [Benchmark(Baseline = true)]
    public int Legacy_ReplaceAndLowercase()
        => UserAgent.Replace("\u200B", string.Empty, StringComparison.Ordinal).ToLowerInvariant().Length;

    [Benchmark]
    public int Current_BoundedNormalization()
        => CrawlerDetectorService.NormalizeCrawlerUserAgent(UserAgent).Length;
}
