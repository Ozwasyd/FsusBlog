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

        return sourceContext switch
        {
            var value when value.Contains("VisitLogMiddleware", StringComparison.Ordinal)
                || value.Contains("VisitLogProcessorService", StringComparison.Ordinal)
                => AuditSourceCatalog.Access,
            var value when value.Contains("AuthController", StringComparison.Ordinal)
                || value.Contains("AuthEndpoints", StringComparison.Ordinal)
                => AuditSourceCatalog.Auth,
            var value when value.Contains("UserService", StringComparison.Ordinal)
                => AuditSourceCatalog.User,
            var value when value.Contains("StatsController", StringComparison.Ordinal)
                || value.Contains("StatsService", StringComparison.Ordinal)
                => AuditSourceCatalog.Admin,
            var value when value.Contains("ArticleController", StringComparison.Ordinal)
                || value.Contains("ArticleService", StringComparison.Ordinal)
                => AuditSourceCatalog.Article,
            var value when value.Contains("CommentController", StringComparison.Ordinal)
                || value.Contains("CommentService", StringComparison.Ordinal)
                => AuditSourceCatalog.Comment,
            var value when value.Contains("CategoryController", StringComparison.Ordinal)
                => AuditSourceCatalog.Category,
            var value when value.Contains("TagController", StringComparison.Ordinal)
                => AuditSourceCatalog.Tag,
            var value when value.Contains("SystemController", StringComparison.Ordinal)
                || value.Contains("SystemService", StringComparison.Ordinal)
                || value.Contains("SystemEndpoints", StringComparison.Ordinal)
                => AuditSourceCatalog.System,
            var value when value.Contains("FileService", StringComparison.Ordinal)
                => AuditSourceCatalog.Storage,
            var value when value.Contains(".Infrastructure.Cache.", StringComparison.Ordinal)
                => AuditSourceCatalog.Cache,
            var value when value.Contains("SqlSugar", StringComparison.Ordinal)
                || value.Contains("DbConcurrencyGate", StringComparison.Ordinal)
                || value.Contains("SchemaMigration", StringComparison.Ordinal)
                => AuditSourceCatalog.Db,
            var value when value.Contains(".Infrastructure.NotificationStream.", StringComparison.Ordinal)
                || value.Contains(".Services.NotificationStream.", StringComparison.Ordinal)
                => AuditSourceCatalog.NotificationStream,
            var value when value.Contains("PublicAot", StringComparison.Ordinal)
                => AuditSourceCatalog.PublicAot,
            var value when value.Contains(".Services.Background.", StringComparison.Ordinal)
                || value.Contains("BackgroundTaskExecutor", StringComparison.Ordinal)
                => AuditSourceCatalog.Background,
            var value when value.Contains(".Infrastructure.Filters.", StringComparison.Ordinal)
                || value.Contains(".Infrastructure.Security.", StringComparison.Ordinal)
                || value.Contains(".Services.Security.", StringComparison.Ordinal)
                => AuditSourceCatalog.Security,
            var value when value.Contains(".Modules.Controllers.", StringComparison.Ordinal)
                || value.Contains(".Modules.Endpoints.", StringComparison.Ordinal)
                => AuditSourceCatalog.Request,
            _ when eventInfo.Contains("notification stream", StringComparison.OrdinalIgnoreCase)
                => AuditSourceCatalog.NotificationStream,
            _ => AuditSourceCatalog.Runtime
        };
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
            return "public_aot.cache";
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
