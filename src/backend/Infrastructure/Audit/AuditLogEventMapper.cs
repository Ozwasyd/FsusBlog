using System.Collections.Concurrent;
using System.Collections.Frozen;
using System.Globalization;

using FsusBlog.Server.Infrastructure.PublicAot;

using Serilog.Events;

namespace FsusBlog.Server.Infrastructure.Audit;

public sealed class AuditLogEventMapper
{
    private static readonly HashSet<string> ForbiddenContextProperties = new(StringComparer.OrdinalIgnoreCase)
    {
        "Authorization",
        "Body",
        "ClientIp",
        "Cookie",
        "Credential",
        "CredentialCommitment",
        "CredentialRequest",
        "CredentialSecret",
        "CredentialWitness",
        "Email",
        "Groth16Proof",
        "AccountId",
        "AdminPrincipalId",
        "Ip",
        "IssuerSignature",
        "IssuerResponse",
        string.Concat("Internal", "UserId"),
        "Nullifier",
        "NullifierHash",
        "Password",
        "Proof",
        "RawNullifier",
        "RequestBody",
        "Token",
        "UserId",
        "UserAgent",
        "Username"
    };

    private static readonly string[] ForbiddenContextPropertySubstrings =
    [
        "body",
        "clientip",
        "cookie",
        "email",
        "proof",
        "nullifier",
        "token",
        "useragent",
        "credentialcommitment",
        "credentialrequest",
        "credentialsecret",
        "credentialwitness",
        "issuersignature"
    ];

    private static readonly string[] BackgroundLifecycleKeywords =
    [
        "初始化",
        "启动",
        "离线",
        "停机",
        "完成",
        "同步搜索引擎 IP 白名单",
        "backfill completed"
    ];

    private const int SourceContextCacheLimit = 256;
    private static readonly FrozenDictionary<string, string> SourceContextExactCatalog = new Dictionary<string, string>(StringComparer.Ordinal)
    {
        ["FsusBlog.Server.Infrastructure.Middlewares.VisitLogMiddleware"] = AuditSourceCatalog.Access,
        ["FsusBlog.Server.Services.VisitLogProcessorService"] = AuditSourceCatalog.Access,
        ["FsusBlog.Server.Modules.Endpoints.AuthEndpoints"] = AuditSourceCatalog.Auth,
        ["FsusBlog.Server.Services.UserService"] = AuditSourceCatalog.User,
        ["FsusBlog.Server.Services.StatsService"] = AuditSourceCatalog.Admin,
        ["FsusBlog.Server.Services.ArticleService"] = AuditSourceCatalog.Article,
        ["FsusBlog.Server.Services.CommentService"] = AuditSourceCatalog.Comment,
        ["FsusBlog.Server.Services.SystemService"] = AuditSourceCatalog.System,
        ["FsusBlog.Server.Services.FileService"] = AuditSourceCatalog.Storage,
        ["FsusBlog.Server.Infrastructure.Cache.UnifiedCache"] = AuditSourceCatalog.Cache,
        ["FsusBlog.Server.Infrastructure.Helpers.Initializer.SqlSugarInitializer"] = AuditSourceCatalog.Db,
        ["FsusBlog.Server.Services.NotificationStream.MessageCenterService"] = AuditSourceCatalog.NotificationStream,
        ["FsusBlog.Server.Infrastructure.Security.AdaptivePowGovernor"] = AuditSourceCatalog.Security
    }.ToFrozenDictionary(StringComparer.Ordinal);

    private static readonly SourceContextRule[] SourceContextRules =
    [
        new(["VisitLogMiddleware", "VisitLogProcessorService"], AuditSourceCatalog.Access),
        new(["AuthController", "AuthEndpoints"], AuditSourceCatalog.Auth),
        new(["UserService"], AuditSourceCatalog.User),
        new(["StatsController", "StatsService"], AuditSourceCatalog.Admin),
        new(["ArticleController", "ArticleService"], AuditSourceCatalog.Article),
        new(["CommentController", "CommentService"], AuditSourceCatalog.Comment),
        new(["CategoryController"], AuditSourceCatalog.Category),
        new(["TagController"], AuditSourceCatalog.Tag),
        new(["SystemController", "SystemService", "SystemEndpoints"], AuditSourceCatalog.System),
        new(["FileService"], AuditSourceCatalog.Storage),
        new([".Infrastructure.Cache."], AuditSourceCatalog.Cache),
        new(["SqlSugar", "DbConcurrencyGate", "SchemaMigration"], AuditSourceCatalog.Db),
        new([".Infrastructure.NotificationStream.", ".Services.NotificationStream."], AuditSourceCatalog.NotificationStream),
        new(["PublicAot"], AuditSourceCatalog.PublicAot),
        new([".Services.Background.", "BackgroundTaskExecutor"], AuditSourceCatalog.Background),
        new([".Infrastructure.Filters.", ".Infrastructure.Security.", ".Services.Security."], AuditSourceCatalog.Security),
        new([".Modules.Controllers.", ".Modules.Endpoints."], AuditSourceCatalog.Request)
    ];

    private static readonly ConcurrentDictionary<string, string> SourceContextCatalogCache = new(StringComparer.Ordinal);

    public static bool IsAuditCandidate(LogEvent logEvent)
        => logEvent.Exception is not null
           || logEvent.Level >= LogEventLevel.Warning
           || logEvent.Properties.ContainsKey(AuditPropertyNames.Source)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.Type)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.Action)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.Outcome)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.Severity)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.ActorType)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.ActorId)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.ActorRole)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.TargetType)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.TargetId)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.HighValue)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.ReasonCode)
           || logEvent.Properties.ContainsKey(AuditPropertyNames.SkipPersistence);

    public AuditRecord? Map(LogEvent logEvent)
    {
        if (TryGetBoolean(logEvent, AuditPropertyNames.SkipPersistence) is true)
        {
            return null;
        }

        string eventInfo = logEvent.RenderMessage(CultureInfo.InvariantCulture);
        string source = TryGetString(logEvent, AuditPropertyNames.Source)
            ?? ClassifySource(TryGetString(logEvent, "SourceContext"), eventInfo);
        string type = TryGetString(logEvent, AuditPropertyNames.Type)
            ?? ClassifyType(source, logEvent, eventInfo);
        string action = TryGetString(logEvent, AuditPropertyNames.Action)
            ?? ClassifyAction(source, type, eventInfo);
        string outcome = TryGetString(logEvent, AuditPropertyNames.Outcome)
            ?? ClassifyOutcome(logEvent);
        string severity = TryGetString(logEvent, AuditPropertyNames.Severity)
            ?? ClassifySeverity(logEvent);
        bool isHighValue = TryGetBoolean(logEvent, AuditPropertyNames.HighValue)
            ?? source is AuditSourceCatalog.Admin or AuditSourceCatalog.Auth or AuditSourceCatalog.Security;
        string? actorType = TryGetString(logEvent, AuditPropertyNames.ActorType);

        byte[] contextPayload = BuildContextPayload(logEvent, source, type);
        return new AuditRecord(
            source,
            type,
            logEvent.Timestamp.UtcDateTime,
            eventInfo,
            contextPayload,
            Action: action,
            Outcome: outcome,
            Severity: severity,
            ActorType: actorType,
            ActorId: ResolveExplicitActorId(logEvent, actorType),
            ActorRole: TryGetString(logEvent, AuditPropertyNames.ActorRole),
            TargetType: TryGetString(logEvent, AuditPropertyNames.TargetType),
            TargetId: TryGetString(logEvent, AuditPropertyNames.TargetId),
            IsHighValue: isHighValue,
            TraceId: TryGetString(logEvent, "TraceId"),
            RequestPath: TryGetString(logEvent, "RequestPath"),
            RequestMethod: TryGetString(logEvent, "RequestMethod"),
            IpHash: TryGetString(logEvent, "IpHash"),
            UserAgentHash: TryGetString(logEvent, "UserAgentHash"),
            SessionIdHash: TryGetString(logEvent, "SessionIdHash"),
            DeviceFingerprintHash: TryGetString(logEvent, "DeviceFingerprintHash"),
            ReasonCode: TryGetString(logEvent, AuditPropertyNames.ReasonCode));
    }

    private static string ClassifySource(string? sourceContext, string eventInfo)
    {
        if (string.IsNullOrWhiteSpace(sourceContext))
        {
            return AuditSourceCatalog.Runtime;
        }

        sourceContext = sourceContext.Trim();
        if (SourceContextExactCatalog.TryGetValue(sourceContext, out string? exactCatalog) ||
            SourceContextCatalogCache.TryGetValue(sourceContext, out exactCatalog))
        {
            return exactCatalog;
        }

        foreach (SourceContextRule rule in SourceContextRules)
        {
            if (rule.IsMatch(sourceContext))
            {
                AddSourceContextCacheEntry(sourceContext, rule.Catalog);
                return rule.Catalog;
            }
        }

        if (eventInfo.Contains("notification stream", StringComparison.OrdinalIgnoreCase))
        {
            return AuditSourceCatalog.NotificationStream;
        }

        AddSourceContextCacheEntry(sourceContext, AuditSourceCatalog.Runtime);
        return AuditSourceCatalog.Runtime;
    }

    private static void AddSourceContextCacheEntry(string sourceContext, string catalog)
    {
        if (SourceContextCatalogCache.Count < SourceContextCacheLimit)
        {
            _ = SourceContextCatalogCache.TryAdd(sourceContext, catalog);
        }
    }

    private readonly record struct SourceContextRule(string[] Tokens, string Catalog)
    {
        public bool IsMatch(string sourceContext)
        {
            foreach (string token in Tokens)
            {
                if (sourceContext.Contains(token, StringComparison.Ordinal))
                {
                    return true;
                }
            }

            return false;
        }
    }

    private static string ClassifyType(string source, LogEvent logEvent, string eventInfo)
    {
        if (source == AuditSourceCatalog.Access)
        {
            return AuditTypeCatalog.Access;
        }

        if (logEvent.Exception is not null || logEvent.Level >= LogEventLevel.Error)
        {
            return AuditTypeCatalog.Exception;
        }

        if (eventInfo.Contains("审计", StringComparison.Ordinal)
            || eventInfo.Contains("安全事件", StringComparison.Ordinal))
        {
            return AuditTypeCatalog.Audit;
        }

        if (source == AuditSourceCatalog.Security)
        {
            return AuditTypeCatalog.Security;
        }

        if ((source == AuditSourceCatalog.Cache || source == AuditSourceCatalog.Db)
            && (eventInfo.Contains("慢 SQL", StringComparison.Ordinal)
                || eventInfo.Contains("timeout", StringComparison.OrdinalIgnoreCase)
                || eventInfo.Contains("耗时", StringComparison.Ordinal)))
        {
            return AuditTypeCatalog.Performance;
        }

        if ((source == AuditSourceCatalog.Background || source == AuditSourceCatalog.Runtime)
            && BackgroundLifecycleKeywords.Any(keyword => eventInfo.Contains(keyword, StringComparison.OrdinalIgnoreCase)))
        {
            return AuditTypeCatalog.Lifecycle;
        }

        return source switch
        {
            AuditSourceCatalog.Auth or
            AuditSourceCatalog.Admin or
            AuditSourceCatalog.Article or
            AuditSourceCatalog.Comment or
            AuditSourceCatalog.Category or
            AuditSourceCatalog.Tag or
            AuditSourceCatalog.System or
            AuditSourceCatalog.User => AuditTypeCatalog.Business,
            _ => AuditTypeCatalog.Infra
        };
    }

    private static string ClassifyAction(string source, string type, string eventInfo)
    {
        if (source == AuditSourceCatalog.Auth && eventInfo.Contains("登录", StringComparison.Ordinal))
        {
            return "auth.login";
        }

        if (source == AuditSourceCatalog.Auth && eventInfo.Contains("刷新令牌", StringComparison.Ordinal))
        {
            return "auth.refresh_token";
        }

        if (source == AuditSourceCatalog.Security)
        {
            return "security.event";
        }

        if (source == AuditSourceCatalog.PublicAot)
        {
            return AuditActionCatalog.PublicAotCache;
        }

        return type == AuditTypeCatalog.Exception
            ? "runtime.exception"
            : AuditActionCatalog.LogRecorded;
    }

    private static string ClassifyOutcome(LogEvent logEvent)
        => logEvent.Exception is not null || logEvent.Level >= LogEventLevel.Error
            ? AuditOutcomeCatalog.Failure
            : AuditOutcomeCatalog.Success;

    private static string ClassifySeverity(LogEvent logEvent)
        => logEvent.Level switch
        {
            >= LogEventLevel.Fatal => AuditSeverityCatalog.Critical,
            >= LogEventLevel.Error => AuditSeverityCatalog.Error,
            >= LogEventLevel.Warning => AuditSeverityCatalog.Warning,
            _ => AuditSeverityCatalog.Info
        };

    private static string? ResolveExplicitActorId(LogEvent logEvent, string? actorType)
    {
        if (string.IsNullOrWhiteSpace(actorType))
        {
            return null;
        }

        return TryGetString(logEvent, AuditPropertyNames.ActorId);
    }

    private static byte[] BuildContextPayload(LogEvent logEvent, string source, string type)
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["source"] = source,
            ["type"] = type,
            ["level"] = logEvent.Level.ToString()
        };

        string? sourceContext = TryGetString(logEvent, "SourceContext");
        if (!string.IsNullOrWhiteSpace(sourceContext))
        {
            payload["category"] = sourceContext;
        }

        foreach ((string propertyName, LogEventPropertyValue propertyValue) in logEvent.Properties)
        {
            if (propertyName is AuditPropertyNames.Source
                or AuditPropertyNames.Type
                or AuditPropertyNames.Action
                or AuditPropertyNames.Outcome
                or AuditPropertyNames.Severity
                or AuditPropertyNames.ActorType
                or AuditPropertyNames.ActorId
                or AuditPropertyNames.ActorRole
                or AuditPropertyNames.TargetType
                or AuditPropertyNames.TargetId
                or AuditPropertyNames.HighValue
                or AuditPropertyNames.ReasonCode
                or AuditPropertyNames.SkipPersistence
                or AuditPropertyNames.MappedRecord
                or "MessageTemplate"
                or "Renderings")
            {
                continue;
            }

            if (ShouldDropContextProperty(propertyName))
            {
                continue;
            }

            payload[propertyName] = ConvertPropertyValue(propertyValue);
        }

        if (logEvent.Exception is not null)
        {
            payload["exceptionType"] = logEvent.Exception.GetType().FullName;
            payload["exceptionMessage"] = logEvent.Exception.Message;
        }

        return PublicAotBinaryPayload.EncodeObjectFrame(payload);
    }

    private static bool ShouldDropContextProperty(string propertyName)
    {
        if (ForbiddenContextProperties.Contains(propertyName))
        {
            return true;
        }

        string normalized = NormalizeContextPropertyName(propertyName);
        return ForbiddenContextPropertySubstrings.Any(keyword =>
            normalized.Contains(keyword, StringComparison.OrdinalIgnoreCase));
    }

    private static string NormalizeContextPropertyName(string propertyName)
    {
        Span<char> buffer = propertyName.Length <= 256
            ? stackalloc char[propertyName.Length]
            : new char[propertyName.Length];
        int index = 0;
        foreach (char c in propertyName)
        {
            if (char.IsLetterOrDigit(c))
            {
                buffer[index++] = char.ToLowerInvariant(c);
            }
        }

        return new string(buffer[..index]);
    }

    private static object? ConvertPropertyValue(LogEventPropertyValue value)
        => value switch
        {
            ScalarValue scalar => scalar.Value,
            SequenceValue sequence => sequence.Elements.Select(ConvertPropertyValue).ToArray(),
            DictionaryValue dictionary => ConvertDictionaryValue(dictionary),
            StructureValue structure => ConvertStructureValue(structure),
            _ => value.ToString()
        };

    private static Dictionary<string, object?> ConvertDictionaryValue(DictionaryValue dictionary)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (KeyValuePair<ScalarValue, LogEventPropertyValue> pair in dictionary.Elements)
        {
            string key = Convert.ToString(ConvertPropertyValue(pair.Key), CultureInfo.InvariantCulture) ?? string.Empty;
            if (!string.IsNullOrWhiteSpace(key) && !ShouldDropContextProperty(key))
            {
                result[key] = ConvertPropertyValue(pair.Value);
            }
        }

        return result;
    }

    private static Dictionary<string, object?> ConvertStructureValue(StructureValue structure)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (LogEventProperty property in structure.Properties)
        {
            if (!ShouldDropContextProperty(property.Name))
            {
                result[property.Name] = ConvertPropertyValue(property.Value);
            }
        }

        return result;
    }

    private static string? TryGetString(LogEvent logEvent, string propertyName)
        => logEvent.Properties.TryGetValue(propertyName, out LogEventPropertyValue? value)
           && value is ScalarValue { Value: not null } scalar
            ? Convert.ToString(scalar.Value, CultureInfo.InvariantCulture)
            : null;

    private static bool? TryGetBoolean(LogEvent logEvent, string propertyName)
        => logEvent.Properties.TryGetValue(propertyName, out LogEventPropertyValue? value)
           && value is ScalarValue { Value: bool boolValue }
            ? boolValue
            : null;
}
