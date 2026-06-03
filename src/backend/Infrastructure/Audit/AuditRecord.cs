using System.Collections.ObjectModel;
using System.Security.Claims;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure.Helpers;
using Serilog.Context;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed record AuditRecord(
    string Source,
    string Type,
    DateTime OccurredAtUtc,
    string EventInfo,
    byte[]? ContextPayload,
    string Action = AuditActionCatalog.LogRecorded,
    string Outcome = AuditOutcomeCatalog.Unknown,
    string Severity = AuditSeverityCatalog.Info,
    string? ActorType = null,
    string? ActorId = null,
    string? ActorRole = null,
    string? TargetType = null,
    string? TargetId = null,
    bool IsHighValue = false,
    string? TraceId = null,
    string? RequestPath = null,
    string? RequestMethod = null,
    string? IpHash = null,
    string? UserAgentHash = null,
    string? SessionIdHash = null,
    string? DeviceFingerprintHash = null,
    string? ReasonCode = null,
    string? ContextJson = null,
    string? ChainId = null,
    string? PrevHash = null,
    string? RecordHash = null,
    string? RecordMac = null)
{
    public bool RequiresDurableWrite
        => IsHighValue
           || string.Equals(Severity, AuditSeverityCatalog.Critical, StringComparison.Ordinal)
           || string.Equals(Type, AuditTypeCatalog.Security, StringComparison.Ordinal)
           || string.Equals(Type, AuditTypeCatalog.Audit, StringComparison.Ordinal);
}

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

public static class AuditActionCatalog
{
    public const string LogRecorded = "log.recorded";
    public const string UserStatusChanged = "admin.user.status_changed";
    public const string UserPasswordReset = "admin.user.password_reset";
    public const string CommentModerated = "admin.comment.moderated";
    public const string CommentBulkModerated = "admin.comment.bulk_moderated";
    public const string ContentExported = "admin.content.exported";
    public const string ArticleExported = "admin.article.exported";
    public const string ArticleImported = "admin.article.imported";
    public const string AuditQueried = "admin.audit.queried";
}

public static class AuditOutcomeCatalog
{
    public const string Success = "success";
    public const string Failure = "failure";
    public const string Denied = "denied";
    public const string Unknown = "unknown";
}

public static class AuditSeverityCatalog
{
    public const string Info = "info";
    public const string Warning = "warning";
    public const string Error = "error";
    public const string Critical = "critical";
}

public static class AuditActorTypeCatalog
{
    public const string Anonymous = "anonymous";
    public const string User = "user";
    public const string Admin = "admin";
    public const string System = "system";
}

public static class AuditPropertyNames
{
    public const string Source = "AuditSource";
    public const string Type = "AuditType";
    public const string Action = "AuditAction";
    public const string Outcome = "AuditOutcome";
    public const string Severity = "AuditSeverity";
    public const string ActorType = "AuditActorType";
    public const string ActorId = "AuditActorId";
    public const string ActorRole = "AuditActorRole";
    public const string TargetType = "AuditTargetType";
    public const string TargetId = "AuditTargetId";
    public const string HighValue = "AuditHighValue";
    public const string ReasonCode = "AuditReasonCode";
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
    string ActorType,
    string? TraceId,
    string? RequestPath,
    string? RequestMethod,
    string? UserId,
    string? UserRole,
    string? IpHash,
    string? UserAgentHash,
    string? SessionIdHash,
    string? DeviceFingerprintHash)
{
    public static RequestAuditContextSnapshot FromHttpContext(HttpContext context)
    {
        string? userId = context.User.FindFirst(System.Security.Claims.ClaimTypes.NameIdentifier)?.Value;
        string? userRole = context.User.FindFirst(ClaimTypes.Role)?.Value;
        string actorType = string.IsNullOrWhiteSpace(userId)
            ? AuditActorTypeCatalog.Anonymous
            : string.Equals(userRole, "admin", StringComparison.OrdinalIgnoreCase)
                ? AuditActorTypeCatalog.Admin
                : AuditActorTypeCatalog.User;

        return new RequestAuditContextSnapshot(
            actorType,
            context.TraceIdentifier,
            context.Request.Path.HasValue ? context.Request.Path.Value : null,
            context.Request.Method,
            string.IsNullOrWhiteSpace(userId) ? null : userId,
            string.IsNullOrWhiteSpace(userRole) ? null : userRole,
            HashNullable(context.Connection.RemoteIpAddress?.ToString()),
            HashNullable(context.Request.Headers.UserAgent.ToString()),
            HashNullable(context.User.GetSessionId()),
            HashNullable(context.Request.Headers["X-Fsus-Device-Fp"].ToString()));
    }

    public IReadOnlyDictionary<string, object?> ToProperties()
    {
        Dictionary<string, object?> values = new(StringComparer.Ordinal)
        {
            [AuditPropertyNames.ActorType] = ActorType,
            [AuditPropertyNames.ActorId] = UserId,
            [AuditPropertyNames.ActorRole] = UserRole,
            ["TraceId"] = TraceId,
            ["RequestPath"] = RequestPath,
            ["RequestMethod"] = RequestMethod,
            ["UserId"] = UserId,
            ["IpHash"] = IpHash,
            ["UserAgentHash"] = UserAgentHash,
            ["SessionIdHash"] = SessionIdHash,
            ["DeviceFingerprintHash"] = DeviceFingerprintHash
        };

        return new ReadOnlyDictionary<string, object?>(values);
    }

    private static string? HashNullable(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        byte[] hash = SHA256.HashData(Encoding.UTF8.GetBytes(value.Trim()));
        return Convert.ToHexString(hash).ToLowerInvariant();
    }
}
