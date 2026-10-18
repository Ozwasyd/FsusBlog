using System.Reflection;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringExtensionApprovalAuthorityTests
{
    [Fact]
    public void ApprovedClaim_HasNoPublicConstructorOrMutableApprovalFlag()
    {
        Type type = typeof(AuthoringExtensionApprovalAuthority.ApprovedClaim);
        Assert.True(type.IsSealed);
        Assert.Empty(type.GetConstructors(BindingFlags.Public | BindingFlags.Instance));
        Assert.All(type.GetProperties(), property => Assert.Null(property.SetMethod));
        Assert.DoesNotContain(type.GetProperties(), property => property.PropertyType == typeof(bool));
        Assert.All(typeof(IAuthoringExtensionApprovalAuthority).GetMethods(), method =>
            Assert.DoesNotContain(method.GetParameters(), parameter => parameter.ParameterType == typeof(bool)));
    }

    [Theory]
    [InlineData(AuthoringApprovalStatus.Pending, AuthoringApprovalStatus.Claimed)]
    [InlineData(AuthoringApprovalStatus.Denied, AuthoringApprovalStatus.Claimed)]
    [InlineData(AuthoringApprovalStatus.Claimed, AuthoringApprovalStatus.Claimed)]
    [InlineData(AuthoringApprovalStatus.Completed, AuthoringApprovalStatus.Approved)]
    [InlineData(AuthoringApprovalStatus.RecoveryRequired, AuthoringApprovalStatus.Claimed)]
    [InlineData(AuthoringApprovalStatus.Expired, AuthoringApprovalStatus.Claimed)]
    [InlineData(AuthoringApprovalStatus.Revoked, AuthoringApprovalStatus.Claimed)]
    public void ClosedStateMachine_RejectsSkippedConsentReplayAndTerminalResurrection(AuthoringApprovalStatus from, AuthoringApprovalStatus to)
        => Assert.False(PostgresAuthoringExtensionApprovalStore.IsTransitionAllowed(from, to));

    [Theory]
    [InlineData(AuthoringApprovalStatus.Pending, AuthoringApprovalStatus.Approved)]
    [InlineData(AuthoringApprovalStatus.Pending, AuthoringApprovalStatus.Denied)]
    [InlineData(AuthoringApprovalStatus.Approved, AuthoringApprovalStatus.Claimed)]
    [InlineData(AuthoringApprovalStatus.Claimed, AuthoringApprovalStatus.RecoveryRequired)]
    public void ClosedStateMachine_AcceptsExplicitDurableProgress(AuthoringApprovalStatus from, AuthoringApprovalStatus to)
        => Assert.True(PostgresAuthoringExtensionApprovalStore.IsTransitionAllowed(from, to));

    [Fact]
    public async Task MissingAuthenticatedContext_FailsBeforeAnyPersistenceOrStateAccess()
    {
        var authority = new AuthoringExtensionApprovalAuthority(new HttpContextAccessor(),
            new ConfigurationBuilder().Build(), null!, null!, null!, null!);
        var error = await Assert.ThrowsAsync<AuthoringExtensionContractException>(() => authority.ReadAsync(new string('a', 64)).AsTask());
        Assert.Equal("approval_authenticated_admin_required", error.Message);
    }
}
