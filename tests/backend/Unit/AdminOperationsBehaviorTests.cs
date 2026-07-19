using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Models.Dtos;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AdminOperationsBehaviorTests
{
    [Fact]
    public void GetDangerousOperationPolicy_RequiresDiffAndStepUpForIntegrityFix()
    {
        var service = new AdminDangerousOperationPolicyReader();

        DangerousOperationPolicyResponse policy = service.Get();

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
    public async Task ApplyFixAsync_WrongConfirmationReturnsWithoutApplyingChanges()
    {
        AdminIntegrityOperations service = CreateServiceWithoutDependencies();

        IntegrityFixResponse response = await service.ApplyFixAsync(
            new IntegrityFixRequest(["article_tag_missing_tag"], "WRONG_CONFIRMATION"),
            CancellationToken.None);

        Assert.Equal("confirmation_required", response.Status);
        Assert.Equal(0, response.AppliedCount);
        Assert.Empty(response.Diffs);
    }

    private static AdminIntegrityOperations CreateServiceWithoutDependencies()
        => new(
            db: null!,
            environment: null!);
}
