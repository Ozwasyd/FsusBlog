using System.Reflection;

using Microsoft.Extensions.Logging;
using Serilog.Events;
using Serilog.Parsing;

using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Tests.Unit;
namespace FsusBlog.Server.Tests;

public sealed class AuditLogEventMapperTests
{
    private static readonly MessageTemplateParser s_templateParser = new();

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
        Assert.Equal(AuditActionCatalog.PublicAotCache, record.Action);
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

    [Fact]
    public void Map_DropsSensitiveTelemetryAndAuditContextProperties()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "request completed",
            null,
            new LogEventProperty("TraceId", new ScalarValue("trace-safe")),
            new LogEventProperty("ClientIp", new ScalarValue("203.0.113.10")),
            new LogEventProperty("UserAgent", new ScalarValue("browser")),
            new LogEventProperty("Cookie", new ScalarValue("__Host-AccessToken=secret")),
            new LogEventProperty("Authorization", new ScalarValue("Bearer token")),
            new LogEventProperty("Email", new ScalarValue("user@example.invalid")),
            new LogEventProperty("RequestBody", new ScalarValue("{\"password\":\"secret\"}")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record!);
        Assert.Equal("trace-safe", context["TraceId"]);
        Assert.DoesNotContain("ClientIp", context.Keys);
        Assert.DoesNotContain("UserAgent", context.Keys);
        Assert.DoesNotContain("Cookie", context.Keys);
        Assert.DoesNotContain("Authorization", context.Keys);
        Assert.DoesNotContain("Email", context.Keys);
        Assert.DoesNotContain("RequestBody", context.Keys);
    }

    [Fact]
    public void Map_DoesNotPromoteBareUserIdToActorOrContext()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "legacy request log",
            null,
            new LogEventProperty("UserId", new ScalarValue(123)),
            new LogEventProperty("SafeTrace", new ScalarValue("safe-trace")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        Assert.Null(record!.ActorType);
        Assert.Null(record.ActorId);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record);
        Assert.Equal("safe-trace", context["SafeTrace"]);
        Assert.DoesNotContain("UserId", context.Keys);
    }

    [Fact]
    public void Map_DoesNotUseExplicitActorIdWithoutActorType()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "partial audit event",
            null,
            new LogEventProperty(AuditPropertyNames.ActorId, new ScalarValue("account:123")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        Assert.Null(record!.ActorType);
        Assert.Null(record.ActorId);
    }

    [Theory]
    [InlineData("account", "account:123")]
    [InlineData("admin_principal", "admin:7")]
    public void Map_RetainsExplicitNamespacedActorWhenActorTypeIsPresent(string actorType, string actorId)
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "explicit audit event",
            null,
            new LogEventProperty(AuditPropertyNames.ActorType, new ScalarValue(actorType)),
            new LogEventProperty(AuditPropertyNames.ActorId, new ScalarValue(actorId)));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        Assert.Equal(actorType, record!.ActorType);
        Assert.Equal(actorId, record.ActorId);
    }

    [Fact]
    public void AuditLogEventMapper_RuntimeDoesNotFallbackFromUserIdToActorId()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "legacy user-id only",
            null,
            new LogEventProperty("UserId", new ScalarValue("42")));

        AuditRecord? record = mapper.Map(logEvent);
        Assert.NotNull(record);
        Assert.Null(record!.ActorType);
        Assert.Null(record.ActorId);
    }

    [Theory]
    [InlineData("Proof")]
    [InlineData("Groth16Proof")]
    [InlineData("NullifierHash")]
    [InlineData("Nullifier")]
    [InlineData("RawNullifier")]
    [InlineData("CredentialSecret")]
    [InlineData("CredentialCommitment")]
    [InlineData("CredentialWitness")]
    [InlineData("CredentialRequest")]
    [InlineData("IssuerSignature")]
    [InlineData("IssuerResponse")]
    [InlineData("Credential")]
    [InlineData("UserId")]
    [InlineData("InternalUserId")]
    [InlineData("AccountId")]
    [InlineData("AdminPrincipalId")]
    public void Map_DropsZkSensitiveAuditContextPropertiesByExactName(string propertyName)
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "zk audit event",
            null,
            new LogEventProperty("SafeTrace", new ScalarValue("safe-trace")),
            new LogEventProperty(propertyName, new ScalarValue($"secret-{propertyName}")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record!);
        Assert.Equal("safe-trace", context["SafeTrace"]);
        Assert.DoesNotContain(propertyName, context.Keys);
        Assert.DoesNotContain($"secret-{propertyName}", FlattenContext(context), StringComparer.Ordinal);
    }

    [Theory]
    [InlineData("comment_proof_payload")]
    [InlineData("anonymousNullifierValue")]
    [InlineData("credential_commitment_hex")]
    [InlineData("credential-secret-bytes")]
    [InlineData("credential.witness.payload")]
    [InlineData("issuer_signature_compact")]
    [InlineData("credentialRequestPayload")]
    public void Map_DropsZkSensitiveAuditContextPropertiesBySubstring(string propertyName)
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "zk audit event",
            null,
            new LogEventProperty("SafeTrace", new ScalarValue("safe-trace")),
            new LogEventProperty(propertyName, new ScalarValue($"secret-{propertyName}")));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record!);
        Assert.Equal("safe-trace", context["SafeTrace"]);
        Assert.DoesNotContain(propertyName, context.Keys);
        Assert.DoesNotContain($"secret-{propertyName}", FlattenContext(context), StringComparer.Ordinal);
    }

    [Fact]
    public void Map_DropsNestedZkSensitiveAuditContextProperties()
    {
        var mapper = new AuditLogEventMapper();
        LogEvent logEvent = CreateLogEvent(
            DateTimeOffset.UtcNow,
            LogEventLevel.Information,
            "nested zk audit event",
            null,
            new LogEventProperty(
                "ZkContext",
                new StructureValue(
                [
                    new LogEventProperty("CredentialSecret", new ScalarValue("nested-credential-secret")),
                    new LogEventProperty("safeDetail", new ScalarValue("safe-detail"))
                ])),
            new LogEventProperty(
                "NestedDictionary",
                new DictionaryValue(new Dictionary<ScalarValue, LogEventPropertyValue>
                {
                    [new ScalarValue("raw_nullifier_value")] = new ScalarValue("nested-nullifier-secret"),
                    [new ScalarValue("safeKey")] = new ScalarValue("safe-value")
                })));

        AuditRecord? record = mapper.Map(logEvent);

        Assert.NotNull(record);
        IReadOnlyDictionary<string, object?> context = DecodeContext(record!);
        var structure = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(context["ZkContext"]);
        Assert.Equal("safe-detail", structure["safeDetail"]);
        Assert.DoesNotContain("CredentialSecret", structure.Keys);

        var dictionary = Assert.IsAssignableFrom<IReadOnlyDictionary<string, object?>>(context["NestedDictionary"]);
        Assert.Equal("safe-value", dictionary["safeKey"]);
        Assert.DoesNotContain("raw_nullifier_value", dictionary.Keys);
        Assert.DoesNotContain("nested-credential-secret", FlattenContext(context), StringComparer.Ordinal);
        Assert.DoesNotContain("nested-nullifier-secret", FlattenContext(context), StringComparer.Ordinal);
    }

    [Fact]
    public void BackendLogTemplates_DoNotDirectlyLogZkSecrets()
    {
        string[] sensitiveTokens =
        [
            "Proof",
            "Groth16Proof",
            "NullifierHash",
            "RawNullifier",
            "CredentialSecret",
            "CredentialCommitment",
            "CredentialWitness",
            "CredentialRequest",
            "IssuerSignature",
            "IssuerResponse"
        ];
        IReadOnlyList<string> runtimeViolations = RuntimeMetadataInspection.FindMethodsWithLiteralAndMember(
            typeof(AuditLogEventMapper).Assembly,
            literal => sensitiveTokens.Any(token => literal.Contains(token, StringComparison.Ordinal)),
            static member => member.Name.StartsWith("Log", StringComparison.Ordinal)
                && member.DeclaringType?.Namespace?.StartsWith("Microsoft.Extensions.Logging", StringComparison.Ordinal) == true);
        string[] generatedViolations = typeof(AuditLogEventMapper).Assembly.DefinedTypes
            .SelectMany(static type => type.DeclaredMethods)
            .Select(method => (Method: method, Contract: method.GetCustomAttribute<LoggerMessageAttribute>()))
            .Where(static item => item.Contract is not null)
            .Where(item => sensitiveTokens.Any(token =>
                item.Contract!.Message.Contains(token, StringComparison.Ordinal)))
            .Select(static item => $"{item.Method.DeclaringType?.FullName}.{item.Method.Name}")
            .ToArray();

        Assert.Empty(runtimeViolations.Concat(generatedViolations));
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
            s_templateParser.Parse(message),
            properties);

    private static IReadOnlyDictionary<string, object?> DecodeContext(AuditRecord record)
    {
        Assert.NotNull(record.ContextPayload);
        Assert.True(PublicAotBinaryPayload.TryDecodeObject(record.ContextPayload, out Dictionary<string, object?> payload));
        return payload;
    }

    private static IEnumerable<string> FlattenContext(IReadOnlyDictionary<string, object?> context)
    {
        foreach ((string key, object? value) in context)
        {
            yield return key;

            if (value is IReadOnlyDictionary<string, object?> nested)
            {
                foreach (string item in FlattenContext(nested))
                {
                    yield return item;
                }

                continue;
            }

            if (value is IEnumerable<object?> items)
            {
                foreach (object? item in items)
                {
                    if (item is IReadOnlyDictionary<string, object?> nestedItem)
                    {
                        foreach (string nestedText in FlattenContext(nestedItem))
                        {
                            yield return nestedText;
                        }
                    }
                    else if (item is not null)
                    {
                        yield return Convert.ToString(item) ?? string.Empty;
                    }
                }

                continue;
            }

            if (value is not null)
            {
                yield return Convert.ToString(value) ?? string.Empty;
            }
        }
    }
}
