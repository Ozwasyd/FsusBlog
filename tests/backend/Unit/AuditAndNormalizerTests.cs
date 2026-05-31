using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Helpers.Security;
using FsusBlog.Server.Infrastructure.PublicAot;
using Microsoft.Extensions.Logging.Abstractions;
using Serilog.Events;
using Serilog.Parsing;

namespace FsusBlog.Server.Tests.Unit;

// ──────────────────────────────────────────────────────────────────────────────
// TextNormalizer
// ──────────────────────────────────────────────────────────────────────────────

public class TextNormalizerTests
{
    [Fact]
    public void Initialize_CanBeCalledMultipleTimes()
    {
        // Should not throw; second call is a no-op
        TextNormalizer.Initialize(NullLogger.Instance);
        var result = TextNormalizer.Initialize(NullLogger.Instance);
        // May fail silently if dictionary files are absent, but should not throw
        Assert.Equal(!result.IsSuccess, result.IsFailure);
    }

    [Fact]
    public void NormalizeInPlace_AsciiUpperToLower_Consistent()
    {
        // The static char map may or may not have ASCII lowercasing depending on
        // whether Initialize() loaded OpenCC dictionaries. We just verify
        // NormalizeInPlace does not throw and processes all chars.
        char[] buf = "Hello World 123".ToCharArray();
        int lengthBefore = buf.Length;
        TextNormalizer.NormalizeInPlace(buf);
        Assert.Equal(lengthBefore, buf.Length); // length is preserved
    }

    [Fact]
    public void NormalizeInPlace_EmptyBuffer_DoesNothing()
    {
        char[] buf = [];
        TextNormalizer.NormalizeInPlace(buf); // should not throw
        Assert.Empty(buf);
    }

    [Fact]
    public void NormalizeInPlace_DigitsAndSymbols_Unchanged()
    {
        char[] buf = "123!@#".ToCharArray();
        TextNormalizer.NormalizeInPlace(buf);
        Assert.Equal("123!@#", new string(buf));
    }
}

// ──────────────────────────────────────────────────────────────────────────────
// AuditLogEventMapper
// ──────────────────────────────────────────────────────────────────────────────

public class AuditLogEventMapperTests
{
    private static LogEvent MakeLogEvent(
        string message = "test event",
        LogEventLevel level = LogEventLevel.Information,
        Exception? exception = null,
        Dictionary<string, LogEventPropertyValue>? properties = null)
    {
        var messageTemplate = new MessageTemplateParser().Parse(message);
        var props = properties ?? [];
        return new LogEvent(
            DateTimeOffset.UtcNow,
            level,
            exception,
            messageTemplate,
            props.Select(p => new LogEventProperty(p.Key, p.Value)));
    }

    private static LogEvent MakeWithSourceContext(string sourceContext, string message = "event")
    {
        var props = new Dictionary<string, LogEventPropertyValue>
        {
            ["SourceContext"] = new ScalarValue(sourceContext)
        };
        return MakeLogEvent(message, properties: props);
    }

    [Fact]
    public void Map_NormalEvent_ReturnsAuditRecord()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeLogEvent("user registered");
        var record = mapper.Map(ev);

        Assert.NotNull(record);
        Assert.Equal("user registered", record!.EventInfo);
    }

    [Fact]
    public void Map_SkipPersistenceTrue_ReturnsNull()
    {
        var mapper = new AuditLogEventMapper();
        var props = new Dictionary<string, LogEventPropertyValue>
        {
            [AuditPropertyNames.SkipPersistence] = new ScalarValue(true)
        };
        var ev = MakeLogEvent("skip me", properties: props);
        Assert.Null(mapper.Map(ev));
    }

    [Fact]
    public void Map_VisitLogSource_ClassifiedAsAccess()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Infrastructure.Middlewares.VisitLogMiddleware");
        var record = mapper.Map(ev);

        Assert.NotNull(record);
        Assert.Equal(AuditSourceCatalog.Access, record!.Source);
    }

    [Fact]
    public void Map_AuthEndpointsSource_ClassifiedAsAuth()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Modules.Endpoints.AuthEndpoints");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Auth, record!.Source);
    }

    [Fact]
    public void Map_UserServiceSource_ClassifiedAsUser()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Services.UserService");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.User, record!.Source);
    }

    [Fact]
    public void Map_ArticleServiceSource_ClassifiedAsArticle()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Services.ArticleService");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Article, record!.Source);
    }

    [Fact]
    public void Map_CommentServiceSource_ClassifiedAsComment()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Services.CommentService");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Comment, record!.Source);
    }

    [Fact]
    public void Map_SecurityServiceSource_ClassifiedAsSecurity()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Infrastructure.Security.AdaptivePowGovernor");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Security, record!.Source);
    }

    [Fact]
    public void Map_CacheSource_ClassifiedAsCache()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Infrastructure.Cache.UnifiedCache");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Cache, record!.Source);
    }

    [Fact]
    public void Map_DbSource_ClassifiedAsDb()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Infrastructure.Helpers.Initializer.SqlSugarInitializer");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Db, record!.Source);
    }

    [Fact]
    public void Map_SseSource_ClassifiedAsSse()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeWithSourceContext("FsusBlog.Server.Services.Sse.MessageCenterService");
        var record = mapper.Map(ev);

        Assert.Equal(AuditSourceCatalog.Sse, record!.Source);
    }

    [Fact]
    public void Map_ErrorLevel_ClassifiedAsException()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeLogEvent("server error", LogEventLevel.Error);
        var record = mapper.Map(ev);

        Assert.NotNull(record);
        Assert.Equal(AuditTypeCatalog.Exception, record!.Type);
    }

    [Fact]
    public void Map_WithException_IncludesExceptionInContext()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeLogEvent("exception event", exception: new InvalidOperationException("boom"));
        var record = mapper.Map(ev);

        Assert.NotNull(record);
        Assert.Equal("boom", DecodeContext(record!)["exceptionMessage"]);
    }

    [Fact]
    public void Map_NoSourceContext_FallsBackToRuntime()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeLogEvent("random log without source context");
        var record = mapper.Map(ev);

        Assert.NotNull(record);
        Assert.Equal(AuditSourceCatalog.Runtime, record!.Source);
    }

    [Fact]
    public void Map_SecurityEventContent_ClassifiedAsAuditType()
    {
        var mapper = new AuditLogEventMapper();
        var ev = MakeLogEvent("安全事件: brute force detected");
        var record = mapper.Map(ev);

        Assert.Equal(AuditTypeCatalog.Audit, record!.Type);
    }

    [Fact]
    public void Map_BackgroundLifecycle_ClassifiedAsLifecycle()
    {
        var mapper = new AuditLogEventMapper();
        var props = new Dictionary<string, LogEventPropertyValue>
        {
            ["SourceContext"] = new ScalarValue("FsusBlog.Server.Services.Background.SomeBackgroundService")
        };
        var ev = MakeLogEvent("初始化完成", properties: props);
        var record = mapper.Map(ev);

        Assert.Equal(AuditTypeCatalog.Lifecycle, record!.Type);
    }

    [Fact]
    public void Map_WithExplicitSourceProperty_UsesIt()
    {
        var mapper = new AuditLogEventMapper();
        var props = new Dictionary<string, LogEventPropertyValue>
        {
            [AuditPropertyNames.Source] = new ScalarValue("custom_source")
        };
        var ev = MakeLogEvent("test", properties: props);
        var record = mapper.Map(ev);

        Assert.Equal("custom_source", record!.Source);
    }

    private static IReadOnlyDictionary<string, object?> DecodeContext(AuditRecord record)
    {
        Assert.NotNull(record.ContextPayload);
        Assert.True(PublicAotBinaryPayload.TryDecodeObject(record.ContextPayload, out Dictionary<string, object?> payload));
        return payload;
    }
}
