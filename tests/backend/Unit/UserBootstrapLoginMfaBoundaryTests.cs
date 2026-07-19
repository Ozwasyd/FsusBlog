using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class UserBootstrapLoginMfaBoundaryTests
{
    [Fact]
    public void DependencyGraph_BootstrapAndLoginOwnPersistenceWithoutUserServiceCallback()
    {
        Assert.Equal(
            [typeof(ISqlSugarClient), typeof(ILogger<AnonymousAccountBootstrapService>)],
            ConstructorDependencies(typeof(AnonymousAccountBootstrapService)));
        Assert.Equal(
            [
                typeof(ISqlSugarClient),
                typeof(ILogger<UserLoginWorkflowService>),
                typeof(IJwtHelper),
                typeof(IUserSessionValidationCache),
                typeof(IAuthRiskService)
            ],
            ConstructorDependencies(typeof(UserLoginWorkflowService)));

        Assert.DoesNotContain(typeof(UserService), ConstructorDependencies(typeof(AnonymousAccountBootstrapService)));
        Assert.DoesNotContain(typeof(UserService), ConstructorDependencies(typeof(UserLoginWorkflowService)));
    }

    [Fact]
    public void MfaPorts_MapDirectlyToStateMachineOwnerWithoutForwardingType()
    {
        Assert.Contains(typeof(IUserMfaCommandService), typeof(UserService).GetInterfaces());
        Assert.Contains(typeof(IUserMfaVerificationService), typeof(UserService).GetInterfaces());
        Assert.Null(typeof(UserService).Assembly.GetType("FsusBlog.Server.Services.UserMfaCommandService"));
    }

    [Fact]
    public void Composition_RegistersDedicatedBootstrapLoginAndDirectMfaPorts()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimeDomainServices();

        ServiceDescriptor bootstrap = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IAnonymousAccountBootstrapService));
        Assert.Equal(typeof(AnonymousAccountBootstrapService), bootstrap.ImplementationType);
        ServiceDescriptor login = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IUserLoginWorkflowService));
        Assert.Equal(typeof(UserLoginWorkflowService), login.ImplementationType);

        ServiceDescriptor mfaCommands = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IUserMfaCommandService));
        ServiceDescriptor mfaVerification = Assert.Single(
            services,
            static descriptor => descriptor.ServiceType == typeof(IUserMfaVerificationService));
        Assert.NotNull(mfaCommands.ImplementationFactory);
        Assert.NotNull(mfaVerification.ImplementationFactory);
        Assert.Null(mfaCommands.ImplementationType);
        Assert.Null(mfaVerification.ImplementationType);
    }

    private static Type[] ConstructorDependencies(Type implementation)
        => Assert.Single(implementation.GetConstructors())
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
}
