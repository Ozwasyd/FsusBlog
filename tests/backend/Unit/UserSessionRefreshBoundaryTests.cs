using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.NotificationStream;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserSessionRefreshBoundaryTests
{
    [Fact]
    public void DependencyGraph_SessionRefreshHasNoUserServiceCallback()
    {
        Type[] dependencies = Assert.Single(typeof(UserSessionCommandService).GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();

        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(ILogger<UserSessionCommandService>),
                typeof(IJwtHelper),
                typeof(IUserSessionValidationCache),
                typeof(IMessageNotificationStreamPort),
                typeof(TimeProvider)
            ],
            dependencies);
        Assert.DoesNotContain(typeof(UserService), dependencies);
    }

    [Fact]
    public void RuntimePath_OwnsLifecycleRotationAndReplayRevocation()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserSessionCommandService),
            nameof(UserSessionCommandService.RevokeSessionAsync),
            nameof(UserSessionCommandService.RevokeOtherSessionsAsync),
            nameof(UserSessionCommandService.RefreshTokenAsync),
            "RevokeLikelyRefreshReplayAsync");

        Assert.Contains("PublishManyAsync", runtime, StringComparison.Ordinal);
        Assert.Contains("refresh_token_reuse_family_revoke", runtime, StringComparison.Ordinal);
        Assert.Contains("refreshtokenhash <> @StaleHash", runtime, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("UserService", runtime, StringComparison.Ordinal);
        Assert.Null(typeof(UserService).GetMethod(nameof(UserSessionCommandService.RefreshTokenAsync)));
        Assert.Null(typeof(UserService).GetMethod(nameof(UserSessionCommandService.RevokeSessionAsync)));
    }

    [Fact]
    public void CredentialDeletion_RevokesOnlySessionsCreatedByThatInternalCredentialRow()
    {
        string runtime = RuntimeMetadataInspection.DescribeMethods(
            typeof(UserSessionCommandService),
            nameof(UserSessionCommandService.RevokeSessionsByCredentialAsync));

        Assert.Contains("authenticated_credential_row_id = @CredentialRowId", runtime, StringComparison.Ordinal);
        Assert.Contains("userid = @UserId", runtime, StringComparison.Ordinal);
        Assert.Contains("credential_deleted", runtime, StringComparison.Ordinal);
        Assert.Contains("PublishManyAsync", runtime, StringComparison.Ordinal);
        Assert.DoesNotContain("credentialid", runtime, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void Composition_RegistersScopedSessionRefreshBoundary()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IUserSessionCommandService));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(UserSessionCommandService), descriptor.ImplementationType);
    }
}
