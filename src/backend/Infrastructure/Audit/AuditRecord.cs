using System.Collections.ObjectModel;
using FsusBlog.Server.Infrastructure.Helpers;
using Serilog.Context;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed record AuditRecord(
    string Source,
    string Type,
    DateTime OccurredAtUtc,
    string EventInfo,
    byte[]? ContextPayload);

public static class AuditSourceCatalog
{
    public const string Frontend = "frontend";
    public const string Request = "request";
    public const string Auth = "auth";
    public const string Admin = "admin";
    public const string Article = "article";
    public const string Comment = "comment";
    public const string Category = "category";
    public const string Tag = "tag";
    public const string System = "system";
    public const string User = "user";
    public const string Security = "security";
    public const string Cache = "cache";
    public const string Db = "db";
    public const string Sse = "sse";
    public const string PublicAot = "public_aot";
    public const string Storage = "storage";
    public const string Background = "background";
    public const string Runtime = "runtime";
    public const string Access = "access";
}

public static class AuditTypeCatalog
{
    public const string Audit = "audit";
    public const string Business = "business";
    public const string Security = "security";
    public const string Infra = "infra";
    public const string Exception = "exception";
    public const string Lifecycle = "lifecycle";
    public const string Access = "access";
    public const string Performance = "performance";
}

public static class AuditPropertyNames
{
    public const string Source = "AuditSource";
    public const string Type = "AuditType";
    public const string SkipPersistence = "SkipAuditPersistence";
}

public static class AuditLogScope
{
    public static IDisposable Push(
        string source,
        string type,
        params ReadOnlySpan<KeyValuePair<string, object?>> properties)
    {
        var disposables = new List<IDisposable>(properties.Length + 2)
        {
            LogContext.PushProperty(AuditPropertyNames.Source, source),
            LogContext.PushProperty(AuditPropertyNames.Type, type)
        };

        for (int i = 0; i < properties.Length; i++)
        {
            KeyValuePair<string, object?> property = properties[i];
            disposables.Add(LogContext.PushProperty(property.Key, property.Value, destructureObjects: true));
        }

        return new CompositeDisposable(disposables);
    }

    public static IDisposable SkipPersistence()
        => LogContext.PushProperty(AuditPropertyNames.SkipPersistence, true);

    private sealed class CompositeDisposable(IReadOnlyList<IDisposable> disposables) : IDisposable
    {
        private readonly IReadOnlyList<IDisposable> _disposables = disposables;
        private int _disposed;

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            for (int i = _disposables.Count - 1; i >= 0; i--)
            {
                _disposables[i].Dispose();
            }
        }
    }
}

internal sealed record RequestAuditContextSnapshot(
    string? TraceId,
    string? RequestPath,
    string? RequestMethod,
    string? UserId,
    string? Username,
    string? ClientIp,
    string? UserAgent)
{
    public static RequestAuditContextSnapshot FromHttpContext(HttpContext context)
    {
        string? userId = context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
        string? username = context.User.Identity?.IsAuthenticated == true
            ? context.User.Identity?.Name ?? context.User.FindFirst(System.Security.Claims.ClaimTypes.Name)?.Value
            : null;

        return new RequestAuditContextSnapshot(
            context.TraceIdentifier,
            context.Request.Path.HasValue ? context.Request.Path.Value : null,
            context.Request.Method,
            string.IsNullOrWhiteSpace(userId) ? null : userId,
            string.IsNullOrWhiteSpace(username) ? null : username,
            context.GetClientIp(),
            context.Request.Headers.UserAgent.ToString());
    }

    public IReadOnlyDictionary<string, object?> ToProperties()
    {
        Dictionary<string, object?> values = new(StringComparer.Ordinal)
        {
            ["TraceId"] = TraceId,
            ["RequestPath"] = RequestPath,
            ["RequestMethod"] = RequestMethod,
            ["UserId"] = UserId,
            ["Username"] = Username,
            ["ClientIp"] = ClientIp,
            ["UserAgent"] = UserAgent
        };

        return new ReadOnlyDictionary<string, object?>(values);
    }
}
