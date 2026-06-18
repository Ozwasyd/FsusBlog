using FsusBlog.Server.Tests.TestInfrastructure;

namespace FsusBlog.Server.Tests;

public sealed class OperationsReadinessContractTests
{
    [Fact]
    public void AuthoringEndpoints_ExposeOpsCacheAndIntegritySurfaces()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string endpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));
        string router = File.ReadAllText(Path.Combine(root, "src/frontend/src/router/index.ts"));
        string nav = File.ReadAllText(Path.Combine(root, "src/frontend/src/layouts/accountNav.ts"));

        Assert.Contains("MapGet(\"/ops/health\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/cache/diagnostics\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/cache/actions\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapGet(\"/integrity\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("MapPost(\"/integrity/fix\"", endpoints, StringComparison.Ordinal);
        Assert.Contains("X-Fsus-Mfa-Proof", endpoints, StringComparison.Ordinal);

        Assert.Contains("manage/ops", router, StringComparison.Ordinal);
        Assert.Contains("manage/cache", router, StringComparison.Ordinal);
        Assert.Contains("manage/integrity", router, StringComparison.Ordinal);
        Assert.Contains("/user/manage/ops", nav, StringComparison.Ordinal);
        Assert.Contains("/user/manage/cache", nav, StringComparison.Ordinal);
        Assert.Contains("/user/manage/integrity", nav, StringComparison.Ordinal);
    }

    [Fact]
    public void BackupRestoreAndSupplyChainScripts_AreDocumentedAndExecutable()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string operations = File.ReadAllText(Path.Combine(root, "docs/operations.md"));
        string security = File.ReadAllText(Path.Combine(root, "docs/security.md"));

        AssertScriptExists(root, "tools/operations/backup-site.sh");
        AssertScriptExists(root, "tools/operations/restore-site.sh");
        AssertScriptExists(root, "tools/operations/backup-restore-drill.sh");
        AssertScriptExists(root, "tools/security/check-supply-chain-audit.sh");
        AssertScriptExists(root, "tools/security/generate-sbom.sh");

        Assert.Contains("backup-site.sh", operations, StringComparison.Ordinal);
        Assert.Contains("restore-site.sh", operations, StringComparison.Ordinal);
        Assert.Contains("FSUSBLOG_SITE_BACKUP_PACKAGE", operations, StringComparison.Ordinal);
        Assert.Contains("Migration Recovery", operations, StringComparison.Ordinal);
        Assert.Contains("Supply Chain", operations, StringComparison.Ordinal);
        Assert.Contains("Secret Rotation And Recovery", security, StringComparison.Ordinal);
    }

    [Fact]
    public void PublicDistributionAndSearch_KeepNonPublicContentOut()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string distribution = File.ReadAllText(Path.Combine(root, "src/backend/Services/Distribution/BlogDistributionService.cs"));
        string search = File.ReadAllText(Path.Combine(root, "src/backend/Services/SearchIndexService.cs"));
        string operationsService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Operations/AdminOperationsService.cs"));

        Assert.Contains("article.Status == ArticleStatus.Published", distribution, StringComparison.Ordinal);
        Assert.Contains("article.ScheduledPublishAt == null || article.ScheduledPublishAt <= now", distribution, StringComparison.Ordinal);
        Assert.Contains("Queryable<Category, Article>", distribution, StringComparison.Ordinal);
        Assert.Contains("Queryable<Tag, ArticleTag, Article>", distribution, StringComparison.Ordinal);

        Assert.Contains("a.Status == ArticleStatus.Published", search, StringComparison.Ordinal);
        Assert.Contains("a.ScheduledPublishAt == null || a.ScheduledPublishAt <= now", search, StringComparison.Ordinal);
        Assert.Contains("search_visibility", operationsService, StringComparison.Ordinal);
        Assert.Contains("sitemap_visibility", operationsService, StringComparison.Ordinal);
    }

    [Fact]
    public void DangerousOperations_RequireDiffConfirmationAdminStepUpAndAudit()
    {
        string root = BackendTestPaths.RepositoryRoot;
        string operationsService = File.ReadAllText(Path.Combine(root, "src/backend/Infrastructure/Operations/AdminOperationsService.cs"));
        string endpoints = File.ReadAllText(Path.Combine(root, "src/backend/Modules/Endpoints/AuthoringEndpoints.cs"));

        Assert.Contains("APPLY_SAFE_FIXES", operationsService, StringComparison.Ordinal);
        Assert.Contains("DangerousOperationPolicyResponse", operationsService, StringComparison.Ordinal);
        Assert.Contains("diff-preview", operationsService, StringComparison.Ordinal);
        Assert.Contains("admin-step-up", operationsService, StringComparison.Ordinal);
        Assert.Contains("RequireAdminSensitiveStepUpAsync", endpoints, StringComparison.Ordinal);
        Assert.Contains("admin.integrity.safe_fix_applied", endpoints, StringComparison.Ordinal);
        Assert.Contains("RecordHighValueAsync", endpoints, StringComparison.Ordinal);
    }

    private static void AssertScriptExists(string root, string relativePath)
    {
        string path = Path.Combine(root, relativePath);
        Assert.True(File.Exists(path), $"{relativePath} missing");
        string firstLine = File.ReadLines(path).FirstOrDefault() ?? string.Empty;
        Assert.StartsWith("#!/usr/bin/env bash", firstLine, StringComparison.Ordinal);
    }
}
