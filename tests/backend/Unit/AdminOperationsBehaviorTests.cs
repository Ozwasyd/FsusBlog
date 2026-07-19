using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminOperationsBehaviorTests
{
    [Fact]
    public void GetDangerousOperationPolicy_RequiresDiffAndStepUpForIntegrityFix()
    {
        AdminOperationsService service = CreateServiceWithoutDependencies();

        DangerousOperationPolicyResponse policy = service.GetDangerousOperationPolicy();

        Assert.Contains("integrity-fix", policy.DiffRequiredOperations);
        Assert.Contains("integrity-fix", policy.MfaRequiredOperations);
        Assert.Contains("anonymous-account-suspend", policy.MfaRequiredOperations);
        Assert.Contains("session-revoke", policy.MfaRequiredOperations);
        Assert.Contains(policy.Rules, rule => rule.Level == "admin-step-up" && rule.Interaction == "Admin step-up proof");
        Assert.Contains(policy.Rules, rule => rule.Level == "diff-preview" && rule.Interaction == "展示 changed fields");
        string serialized = System.Text.Json.JsonSerializer.Serialize(policy);
        Assert.DoesNotContain("password-reset", serialized, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("重置密码", serialized, StringComparison.Ordinal);
    }

    [Fact]
    public async Task ApplyIntegrityFixAsync_WrongConfirmationReturnsWithoutApplyingChanges()
    {
        AdminOperationsService service = CreateServiceWithoutDependencies();

        IntegrityFixResponse response = await service.ApplyIntegrityFixAsync(
            new IntegrityFixRequest(["article_tag_missing_tag"], "WRONG_CONFIRMATION"),
            CancellationToken.None);

        Assert.Equal("confirmation_required", response.Status);
        Assert.Equal(0, response.AppliedCount);
        Assert.Empty(response.Diffs);
    }

    private static AdminOperationsService CreateServiceWithoutDependencies()
        => new(
            db: null!,
            environment: null!,
            backupStatusReader: null!,
            readinessProbe: null!,
            publicHotReadStore: null!,
            auditLogRuntime: null!,
            dependencyGraphRuntime: new DependencyGraphRuntimeState(),
            startupRuntime: null!,
            scheduledPublishRuntime: null!,
            crawlerDetector: null!,
            cacheDiagnosticsReader: null!);
}
