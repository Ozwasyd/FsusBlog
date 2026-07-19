using System.Reflection;

using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.PublicAot;

using Microsoft.AspNetCore.Http;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicAotDocumentCompositionBoundaryTests
{
    [Fact]
    public async Task NavigationSnapshot_UsesDocumentCompositionPortInsideDbGate()
    {
        var composition = Substitute.For<IPublicAotDocumentComposition>();
        var match = new PublicAotRouteMatch(
            PublicPageKind.Home,
            PublicPageId.Home,
            "home",
            "/",
            "/",
            string.Empty);
        var context = new DefaultHttpContext();
        Result<PublicAotNavigationSnapshot> expected = Result<PublicAotNavigationSnapshot>.Failure(
            ErrorCode.NotFound,
            "missing");
        composition.BuildNavigationSnapshotAsync(
                context,
                match,
                Arg.Any<DateTimeOffset>(),
                Arg.Any<CancellationToken>())
            .Returns(expected);
        var service = new PublicAotShellService(
            new ImmediateDbConcurrencyGate(),
            composition,
            Substitute.For<IPublicAotArtifactStore>(),
            new PublicAotSsrRuntimeState(new ConfigurationBuilder().Build()),
            NullLogger<PublicAotShellService>.Instance);

        Result<PublicAotNavigationSnapshot> actual = await service.BuildNavigationSnapshotAsync(
            context,
            match,
            CancellationToken.None);

        Assert.Equal(expected, actual);
        await composition.Received(1).BuildNavigationSnapshotAsync(
            context,
            match,
            Arg.Any<DateTimeOffset>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public void DependencyGraph_MovesCompositionPortsOutOfShellWithoutCallback()
    {
        Type[] shellDependencies = Assert.Single(typeof(PublicAotShellService).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters()
            .Select(static parameter => parameter.ParameterType)
            .ToArray();
        Assert.Contains(typeof(IPublicAotDocumentComposition), shellDependencies);
        Assert.Contains(typeof(IPublicAotArtifactStore), shellDependencies);
        Assert.DoesNotContain(typeof(IEnumerable<IPublicAotBootstrapProvider>), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotEntryRenderer), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotDocumentService), shellDependencies);
        Assert.DoesNotContain(typeof(IPublicAotRouteIdentity), shellDependencies);

        ParameterInfo[] compositionDependencies = Assert.Single(typeof(PublicAotDocumentComposition).GetConstructors(
                BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic))
            .GetParameters();
        Assert.DoesNotContain(
            compositionDependencies,
            static parameter => parameter.ParameterType == typeof(IPublicAotShellService)
                || parameter.ParameterType == typeof(PublicAotShellService));
    }

    [Fact]
    public void Composition_RegistersNarrowScopedPort()
    {
        var services = new ServiceCollection();

        services.AddFsusRuntimePublicAotServices();

        ServiceDescriptor descriptor = Assert.Single(
            services,
            static candidate => candidate.ServiceType == typeof(IPublicAotDocumentComposition));
        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.Equal(typeof(PublicAotDocumentComposition), descriptor.ImplementationType);
    }

    private sealed class ImmediateDbConcurrencyGate : IDbConcurrencyGate
    {
        public Task<T> ExecuteAsync<T>(
            string operation,
            Func<CancellationToken, Task<T>> action,
            Func<CancellationToken, Task<T>> onTimeout,
            CancellationToken cancellationToken = default)
            => action(cancellationToken);

        public DbConcurrencyGateSnapshot GetSnapshot() => default;
    }
}
