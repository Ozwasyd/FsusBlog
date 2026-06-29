using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Tests.TestInfrastructure;
using Microsoft.AspNetCore.Http;
using System.Security.Claims;

namespace FsusBlog.Server.Tests;

public sealed class AuditSystemContractTests
{
    [Fact]
    public void AuditLogEntity_ExposesStructuredFieldsAndTamperEvidence()
    {
        Type type = typeof(AuditLog);

        Assert.NotNull(type.GetProperty(nameof(AuditLog.Action)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.ActorId)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.TargetType)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.Outcome)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.Severity)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.IpHash)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.ContextJson)));
        Assert.NotNull(type.GetProperty(nameof(AuditLog.RecordHash)));
    }

    [Fact]
    public void ExplicitAuditServiceAndFallbackWriter_ArePresent()
    {
        Assert.True(typeof(IAuditEventService).IsInterface);
        Assert.True(typeof(IAuditFallbackWriter).IsInterface);

        var record = new AuditRecord(
            AuditSourceCatalog.Admin,
            AuditTypeCatalog.Security,
            DateTime.UtcNow,
            "critical",
            null,
            Severity: AuditSeverityCatalog.Critical);

        Assert.True(record.RequiresDurableWrite);
    }

    [Fact]
    public void SourceFiles_KeepRumSeparateAndExposeAuditConsole()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string rumService = File.ReadAllText(Path.Combine(root, "src/backend/Services/Telemetry/RumTelemetryService.cs"));
        string authoringEndpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));
        string router = File.ReadAllText(Path.Combine(root, "src/frontend/src/router/index.ts"));
        string nav = File.ReadAllText(Path.Combine(root, "src/frontend/src/layouts/accountNav.ts"));

        Assert.Contains("FrontendRumMetric", rumService, StringComparison.Ordinal);
        Assert.DoesNotContain("new AuditLog", rumService, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/audit\"", authoringEndpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/audit/{id:long}/verify\"", authoringEndpoints, StringComparison.Ordinal);
        Assert.Contains("manage/audit", router, StringComparison.Ordinal);
        Assert.Contains("/user/manage/audit", nav, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditVerify_SourceChecksPreviousRecordHash()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string queryService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/AuditQueryService.cs"));

        Assert.Contains("VerifyWithChainAsync", queryService, StringComparison.Ordinal);
        Assert.Contains("ResolvePreviousHashAsync", queryService, StringComparison.Ordinal);
        Assert.Contains("it.Id < row.Id", queryService, StringComparison.Ordinal);
        Assert.Contains("row.PrevHash", queryService, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditQuery_SourceUsesCursorListAndSummaryCache()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string queryService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/AuditQueryService.cs"));
        string dtos = File.ReadAllText(Path.Combine(root, "src/backend/Models/Dtos/AuditDtos.cs"));
        string endpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));
        string observability = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Observability/FsusObservability.cs"));
        string listMethod = ExtractMethodBlock(queryService, "public async Task<AuditLogListResponse> ListAsync");
        string summaryMethod = ExtractMethodBlock(queryService, "public async Task<AuditLogSummaryResponse> GetSummaryAsync");

        Assert.Contains("string? Cursor", dtos, StringComparison.Ordinal);
        Assert.Contains("string? NextCursor", dtos, StringComparison.Ordinal);
        Assert.Contains("string? cursor", endpoints, StringComparison.Ordinal);
        Assert.Contains("TryDecodeAuditCursor", queryService, StringComparison.Ordinal);
        Assert.Contains("EncodeAuditCursor", queryService, StringComparison.Ordinal);
        Assert.Contains("it.OccurredAtUtc < cursor.OccurredAtUtc", listMethod, StringComparison.Ordinal);
        Assert.Contains("it.OccurredAtUtc == cursor.OccurredAtUtc && it.Id < cursor.Id", listMethod, StringComparison.Ordinal);
        Assert.Contains("OrderByDescending(static it => it.OccurredAtUtc)", listMethod, StringComparison.Ordinal);
        Assert.Contains("OrderByDescending(static it => it.Id)", listMethod, StringComparison.Ordinal);
        Assert.Contains("Take(pageSize + 1)", listMethod, StringComparison.Ordinal);
        Assert.DoesNotContain(".Skip(", listMethod, StringComparison.Ordinal);
        Assert.DoesNotContain(".CountAsync", listMethod, StringComparison.Ordinal);

        Assert.Contains("NormalizeSummaryCacheKey", queryService, StringComparison.Ordinal);
        Assert.Contains("SummaryCacheTtl", queryService, StringComparison.Ordinal);
        Assert.Contains("SummaryCache", queryService, StringComparison.Ordinal);
        Assert.Contains("RecordAuditSummaryCacheHit", summaryMethod, StringComparison.Ordinal);
        Assert.Contains("RecordAuditSummaryCacheHit", observability, StringComparison.Ordinal);
        Assert.Contains("auditListDbCount", observability, StringComparison.Ordinal);
        Assert.Contains("auditListElapsed", observability, StringComparison.Ordinal);
        Assert.Contains("auditSummaryQueryCount", observability, StringComparison.Ordinal);
        Assert.Contains("auditFacetElapsed", observability, StringComparison.Ordinal);
        Assert.Contains("auditSummaryCacheHit", observability, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditProjection_RedactedMode_DoesNotExposeSensitiveHashes()
    {
        AuditLog row = CreateSensitiveAuditLog();

        var item = AuditQueryService.ToItemResponse(row, AuditDisclosureMode.PiiRedacted);

        Assert.Equal("pii-redacted", item.PiiMode);
        Assert.NotEqual(row.IpHash, item.IpHash);
        Assert.NotEqual(row.UserAgentHash, item.UserAgentHash);
        Assert.NotEqual(row.SessionIdHash, item.SessionIdHash);
        Assert.NotEqual(row.DeviceFingerprintHash, item.DeviceFingerprintHash);
        Assert.Equal("pii-redacted", item.IpHash);
    }

    [Fact]
    public void AuditProjection_InvestigationMode_ExposesSensitiveHashes()
    {
        AuditLog row = CreateSensitiveAuditLog();

        var item = AuditQueryService.ToItemResponse(row, AuditDisclosureMode.Investigation);

        Assert.Equal("investigation", item.PiiMode);
        Assert.Equal(row.IpHash, item.IpHash);
        Assert.Equal(row.UserAgentHash, item.UserAgentHash);
        Assert.Equal(row.SessionIdHash, item.SessionIdHash);
        Assert.Equal(row.DeviceFingerprintHash, item.DeviceFingerprintHash);
    }

    [Fact]
    public void AuditEndpoint_SourceGatesInvestigationFieldsAndAuditsSensitiveReads()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string permissions = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Auth/AdminPermissions.cs"));
        string endpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));
        string dtos = File.ReadAllText(Path.Combine(root, "src/backend/Models/Dtos/AuditDtos.cs"));

        Assert.Contains("AuditInvestigate", permissions, StringComparison.Ordinal);
        Assert.Contains("piiMode", endpoints, StringComparison.Ordinal);
        Assert.Contains("HasAuditInvestigationPermission", endpoints, StringComparison.Ordinal);
        Assert.Contains("RecordHighValueAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("sensitiveFieldsRead", endpoints, StringComparison.Ordinal);
        Assert.Contains("AuditLogPublicItemResponse", dtos, StringComparison.Ordinal);
        Assert.Contains("AuditLogInvestigationFieldsResponse", dtos, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditEndpoint_OrdinaryAdminInvestigationRequestFallsBackToRedacted()
    {
        var context = CreateAdminContext(AdminPermissions.AuditRead);

        AuditDisclosureMode mode = AuthoringEndpoints.ResolveAuditDisclosureMode(context, "investigation");

        Assert.Equal(AuditDisclosureMode.PiiRedacted, mode);
    }

    [Fact]
    public void AuditEndpoint_AuditInvestigationPermissionCanRequestSensitiveHashes()
    {
        var context = CreateAdminContext(AdminPermissions.AuditRead, AdminPermissions.AuditInvestigate);

        AuditDisclosureMode mode = AuthoringEndpoints.ResolveAuditDisclosureMode(context, "investigation");

        Assert.Equal(AuditDisclosureMode.Investigation, mode);
    }

    [Fact]
    public void AuditFallbackWriter_SourceBatchesFallbackWrites()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string fallbackWriter = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/AuditFallbackWriter.cs"));
        string writeAsync = ExtractMethodBlock(fallbackWriter, "public async Task WriteAsync");

        Assert.Contains("WriteBatchAsync", fallbackWriter, StringComparison.Ordinal);
        Assert.Contains("FileMode.Append", fallbackWriter, StringComparison.Ordinal);
        Assert.DoesNotContain("File.AppendAllTextAsync", fallbackWriter, StringComparison.Ordinal);
        Assert.DoesNotContain("Directory.CreateDirectory", writeAsync, StringComparison.Ordinal);
    }

    private static AuditLog CreateSensitiveAuditLog()
        => new()
        {
            Id = 42,
            Source = "auth",
            Type = "security",
            Action = "auth.test",
            Outcome = "success",
            Severity = "info",
            ActorType = "admin",
            ActorId = "7",
            TargetType = "session",
            TargetId = "42",
            EventInfo = "unit audit",
            OccurredAtUtc = DateTime.UtcNow,
            IpHash = "ip-hash-full",
            UserAgentHash = "ua-hash-full",
            SessionIdHash = "session-hash-full",
            DeviceFingerprintHash = "device-hash-full"
        };

    private static DefaultHttpContext CreateAdminContext(params string[] permissions)
    {
        var claims = new List<Claim>
        {
            new("identity_kind", AnonymousIdentityRuntime.AdminPrincipalKind),
            new("admin_id", "7")
        };
        claims.AddRange(permissions.Select(static permission => new Claim(AdminPermissions.PermissionClaimType, permission)));

        var context = new DefaultHttpContext();
        context.User = new ClaimsPrincipal(new ClaimsIdentity(claims, "unit"));
        return context;
    }

    private static string ExtractMethodBlock(string source, string signature)
    {
        int start = source.IndexOf(signature, StringComparison.Ordinal);
        Assert.True(start >= 0, $"Unable to locate method signature: {signature}");
        int braceStart = source.IndexOf('{', start);
        Assert.True(braceStart > start, $"Unable to locate method body: {signature}");

        int depth = 0;
        for (int i = braceStart; i < source.Length; i++)
        {
            if (source[i] == '{')
            {
                depth++;
            }
            else if (source[i] == '}')
            {
                depth--;
                if (depth == 0)
                {
                    return source[start..(i + 1)];
                }
            }
        }

        throw new InvalidOperationException($"Unable to extract method body: {signature}");
    }
}
