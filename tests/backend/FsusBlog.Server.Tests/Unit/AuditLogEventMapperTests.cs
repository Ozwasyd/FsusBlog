using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.PublicAot;
using Serilog.Events;
using Serilog.Parsing;

namespace FsusBlog.Server.Tests;

public sealed class AuditLogEventMapperTests
{
    private static readonly MessageTemplateParser TemplateParser = new();

    [Fact]
    public void Map_UsesExplicitAuditSourceAndType()
    {
        var mapper = new AuditLogEventMapper();
        DateTimeOffset timestamp = new(2026, 4, 18, 10, 30, 0, TimeSpan.Zero);
        LogEvent logEvent = CreateLogEvent(
            timestamp,
            LogEventLevel.Information,
            "管理员删除评论",
            null,
            new LogEventProperty(AuditPropertyNames.Source, new ScalarValue(AuditSourceCatalog.Comment)),
            new LogEventProperty(AuditPropertyNames.Type, new ScalarValue(AuditTypeCatalog.Audit)),
            new LogEventProperty("TraceId", new ScalarValue("trace-1")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        Assert.Equal(AuditSourceCatalog.Comment, record!.Source);
        Assert.Equal(AuditTypeCatalog.Audit, record.Type);
        Assert.Equal(timestamp.UtcDateTime, record.OccurredAtUtc);
        Assert.Equal("管理员删除评论", record.EventInfo);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record);
        Assert.Equal("trace-1", context["TraceId"]);
    }

    [Fact]
    public void Map_ClassifiesExceptionsAsExceptionType()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Error,
            "后台任务执行失败",
            new InvalidOperationException("boom"),
            new LogEventProperty("SourceContext", new ScalarValue("FsusBlog.Server.Services.Background.PublicAotBackfillWorker")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        Assert.Equal(AuditSourceCatalog.PublicAot, record!.Source);
        Assert.Equal(AuditTypeCatalog.Exception, record.Type);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record);
        Assert.Equal("boom", context["exceptionMessage"]);
    }

    [Fact]
    public void Map_SkipPersistencePropertySuppressesAuditRecord()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Warning,
            "audit-log degraded",
            null,
            new LogEventProperty(AuditPropertyNames.SkipPersistence, new ScalarValue(true)));

        Assert.Null(mapper.Map(logEvent));
    }

    private static LogEvent CreateLogEvent(
        DateTimeOffset timestamp,
        LogEventLevel level,
        string message,
        Exception? exception,
        params LogEventProperty[] properties)
        => new(
            timestamp,
            level,
            exception,
            TemplateParser.Parse(message),
            properties);

    private static IReadOnlyDictionary<string, object?> DecodeContext(AuditRecord record)
    {
        Assert.NotNull(record.ContextPayload);
        Assert.True(PublicAotBinaryPayload.TryDecodeObject(record.ContextPayload, out Dictionary<string, object?> payload));
        return payload;
    }
}
