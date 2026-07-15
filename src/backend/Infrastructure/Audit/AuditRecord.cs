using System.Buffers;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.Server.Infrastructure;
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
    public const string NotificationStream = "notification-stream";
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
    public const string AnonymousAccountStatusChanged = "admin.anonymous_account.status_changed";
    public const string CommentModerated = "admin.comment.moderated";
    public const string CommentBulkModerated = "admin.comment.bulk_moderated";
    public const string AnonymousCommentPolicyUpdated = "admin.anonymous_comment.policy_updated";
    public const string AnonymousGovernanceStatusRead = "admin.anonymous_governance.status_read";
    public const string AnonymousGovernanceNullifiersRead = "admin.anonymous_governance.nullifiers_read";
    public const string AnonymousNullifierBlocked = "admin.anonymous_nullifier.blocked";
    public const string AnonymousCredentialRevoked = "admin.anonymous_credential.revoked";
    public const string AnonymousCredentialIssued = "security.anonymous_credential.issued";
    public const string AnonymousCredentialRootRotated = "security.anonymous_credential.root_rotated";
    public const string SecurityPolicyActivated = "admin.security.policy.activated";
    public const string SecurityPolicyRolledBack = "admin.security.policy.rolled_back";
    public const string ContentExported = "admin.content.exported";
    public const string ArticleExported = "admin.article.exported";
    public const string ArticleImported = "admin.article.imported";
    public const string ArticleTrashCleared = "admin.article.trash_cleared";
    public const string AuditQueried = "admin.audit.queried";
    public const string AuthSelfServicePrincipalRejected = "security.auth.self_service_principal_rejected";
    public const string PasskeyCounterRollback = "security.passkey.counter_rollback";
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
    public const string MappedRecord = "__FsusAuditMappedRecord";
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
    string? AccountId,
    string? AdminPrincipalId,
    string? ActorRole,
    string? IpHash,
    string? UserAgentHash,
    string? SessionIdHash,
    string? DeviceFingerprintHash)
{
    private const string IpHashItemKey = "__fsus.audit.ip_hash";
    private const string UserAgentHashItemKey = "__fsus.audit.user_agent_hash";
    private const string SessionIdHashItemKey = "__fsus.audit.session_id_hash";
    private const string DeviceFingerprintHashItemKey = "__fsus.audit.device_fp_hash";

    public string? ActorId => AdminPrincipalId ?? AccountId;

    public static RequestAuditContextSnapshot FromHttpContext(HttpContext context)
    {
        bool isAdminPrincipal = context.User.IsAdminPrincipal();
        string? principalId = FastUserIdProvider.GetOrParseUserId(context)?.ToString(CultureInfo.InvariantCulture);
        string? accountId = isAdminPrincipal ? null : principalId;
        string? adminPrincipalId = isAdminPrincipal && context.User.TryGetAdminPrincipalId(out long adminId)
            ? adminId.ToString(CultureInfo.InvariantCulture)
            : null;
        string? actorRole = isAdminPrincipal ? "admin" : null;
        string? actorId = isAdminPrincipal ? adminPrincipalId : accountId;
        string actorType = string.IsNullOrWhiteSpace(actorId)
            ? AuditActorTypeCatalog.Anonymous
            : isAdminPrincipal
                ? AuditActorTypeCatalog.Admin
                : AuditActorTypeCatalog.User;

        return new RequestAuditContextSnapshot(
            actorType,
            context.TraceIdentifier,
            context.Request.Path.HasValue ? context.Request.Path.Value : null,
            context.Request.Method,
            string.IsNullOrWhiteSpace(accountId) ? null : accountId,
            string.IsNullOrWhiteSpace(adminPrincipalId) ? null : adminPrincipalId,
            string.IsNullOrWhiteSpace(actorRole) ? null : actorRole,
            HashRequestValue(context, IpHashItemKey, context.Connection.RemoteIpAddress?.ToString()),
            HashRequestValue(context, UserAgentHashItemKey, context.GetUserAgent()),
            HashRequestValue(context, SessionIdHashItemKey, context.User.GetSessionId()),
            HashRequestValue(context, DeviceFingerprintHashItemKey, context.Request.Headers["X-Fsus-Device-Fp"].ToString()));
    }

    public IReadOnlyDictionary<string, object?> ToProperties()
    {
        return new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            [AuditPropertyNames.ActorType] = ActorType,
            [AuditPropertyNames.ActorId] = ActorId,
            [AuditPropertyNames.ActorRole] = ActorRole,
            ["TraceId"] = TraceId,
            ["RequestPath"] = RequestPath,
            ["RequestMethod"] = RequestMethod,
            ["AccountId"] = AccountId,
            ["AdminPrincipalId"] = AdminPrincipalId,
            ["IpHash"] = IpHash,
            ["UserAgentHash"] = UserAgentHash,
            ["SessionIdHash"] = SessionIdHash,
            ["DeviceFingerprintHash"] = DeviceFingerprintHash
        };
    }

    public IDisposable PushLogContext()
        => new RequestAuditLogContextScope(this);

    private static string? HashRequestValue(HttpContext context, string itemKey, string? value)
    {
        if (context.Items.TryGetValue(itemKey, out object? cached))
        {
            return cached as string;
        }

        string? hash = HashNullable(value);
        context.Items[itemKey] = hash;
        return hash;
    }

    private static string? HashNullable(string? value)
    {
        if (string.IsNullOrWhiteSpace(value))
        {
            return null;
        }

        ReadOnlySpan<char> trimmed = value.AsSpan().Trim();
        if (trimmed.IsEmpty)
        {
            return null;
        }

        int byteCount = Encoding.UTF8.GetByteCount(trimmed);
        byte[]? rented = null;
        Span<byte> bytes = byteCount <= 512
            ? stackalloc byte[byteCount]
            : rented = ArrayPool<byte>.Shared.Rent(byteCount);

        try
        {
            int bytesWritten = Encoding.UTF8.GetBytes(trimmed, bytes);
            Span<byte> hash = stackalloc byte[32];
            SHA256.HashData(bytes[..bytesWritten], hash);
            return Convert.ToHexStringLower(hash);
        }
        finally
        {
            if (rented is not null)
            {
                ArrayPool<byte>.Shared.Return(rented);
            }
        }
    }

    private sealed class RequestAuditLogContextScope : IDisposable
    {
        private readonly IDisposable _actorType;
        private readonly IDisposable _actorId;
        private readonly IDisposable _actorRole;
        private readonly IDisposable _traceId;
        private readonly IDisposable _requestPath;
        private readonly IDisposable _requestMethod;
        private readonly IDisposable _accountId;
        private readonly IDisposable _adminPrincipalId;
        private readonly IDisposable _ipHash;
        private readonly IDisposable _userAgentHash;
        private readonly IDisposable _sessionIdHash;
        private readonly IDisposable _deviceFingerprintHash;
        private int _disposed;

        public RequestAuditLogContextScope(RequestAuditContextSnapshot snapshot)
        {
            _actorType = LogContext.PushProperty(AuditPropertyNames.ActorType, snapshot.ActorType);
            _actorId = LogContext.PushProperty(AuditPropertyNames.ActorId, snapshot.ActorId);
            _actorRole = LogContext.PushProperty(AuditPropertyNames.ActorRole, snapshot.ActorRole);
            _traceId = LogContext.PushProperty("TraceId", snapshot.TraceId);
            _requestPath = LogContext.PushProperty("RequestPath", snapshot.RequestPath);
            _requestMethod = LogContext.PushProperty("RequestMethod", snapshot.RequestMethod);
            _accountId = LogContext.PushProperty("AccountId", snapshot.AccountId);
            _adminPrincipalId = LogContext.PushProperty("AdminPrincipalId", snapshot.AdminPrincipalId);
            _ipHash = LogContext.PushProperty("IpHash", snapshot.IpHash);
            _userAgentHash = LogContext.PushProperty("UserAgentHash", snapshot.UserAgentHash);
            _sessionIdHash = LogContext.PushProperty("SessionIdHash", snapshot.SessionIdHash);
            _deviceFingerprintHash = LogContext.PushProperty("DeviceFingerprintHash", snapshot.DeviceFingerprintHash);
        }

        public void Dispose()
        {
            if (Interlocked.Exchange(ref _disposed, 1) != 0)
            {
                return;
            }

            _deviceFingerprintHash.Dispose();
            _sessionIdHash.Dispose();
            _userAgentHash.Dispose();
            _ipHash.Dispose();
            _adminPrincipalId.Dispose();
            _accountId.Dispose();
            _requestMethod.Dispose();
            _requestPath.Dispose();
            _traceId.Dispose();
            _actorRole.Dispose();
            _actorId.Dispose();
            _actorType.Dispose();
        }
    }
}
