using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Audit;

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
        string root = ResolveRepositoryRoot();
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
        string root = ResolveRepositoryRoot();
        string queryService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/AuditQueryService.cs"));

        Assert.Contains("VerifyWithChainAsync", queryService, StringComparison.Ordinal);
        Assert.Contains("ResolvePreviousHashAsync", queryService, StringComparison.Ordinal);
        Assert.Contains("it.Id < row.Id", queryService, StringComparison.Ordinal);
        Assert.Contains("row.PrevHash", queryService, StringComparison.Ordinal);
    }

    [Fact]
    public void AuditFallbackWriter_SourceBatchesFallbackWrites()
    {
        string root = ResolveRepositoryRoot();
        string fallbackWriter = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Audit/AuditFallbackWriter.cs"));
        string writeAsync = ExtractMethodBlock(fallbackWriter, "public async Task WriteAsync");

        Assert.Contains("WriteBatchAsync", fallbackWriter, StringComparison.Ordinal);
        Assert.Contains("FileMode.Append", fallbackWriter, StringComparison.Ordinal);
        Assert.DoesNotContain("File.AppendAllTextAsync", fallbackWriter, StringComparison.Ordinal);
        Assert.DoesNotContain("Directory.CreateDirectory", writeAsync, StringComparison.Ordinal);
    }

    private static string ResolveRepositoryRoot()
    {
        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        while (directory is not null)
        {
            if (File.Exists(Path.Combine(directory.FullName, "FsusBlog.slnx")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new InvalidOperationException("Repository root not found.");
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
