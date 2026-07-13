using System.Buffers;
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
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.NotificationStream;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Distribution;
using FsusBlog.Server.Services.Security;
using Microsoft.AspNetCore.Http;
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
            "verified",
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
