using FsusBlog.Shared.Contracts.AuthoringCanvas;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasServiceRegistrationTests
{
    [Fact]
    public void RuntimeDomainServices_ResolveOneProductionReferenceAuthority()
    {
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);
        services.AddScoped(_ => Substitute.For<ISqlSugarClient>());
        services.AddFsusRuntimeDomainServices();
        using ServiceProvider provider = services.BuildServiceProvider();
        using IServiceScope scope = provider.CreateScope();

        Assert.IsType<AuthoringCanvasDocumentStore>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasDocumentStore>());
        Assert.IsType<PostgresAuthoringCanvasArticleReferenceReader>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasArticleReferenceReader>());
        Assert.IsType<AuthoringCanvasCoordinateFactProvider>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasCoordinateFactProvider>());
        Assert.IsType<AuthoringCanvasReferenceFactSource>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasReferenceFactSource>());
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<AuthoringCanvasReferenceResolver>());
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<AuthoringCanvasReferenceVerifier>());
        Assert.IsType<AuthoringCanvasOperationReferenceValidator>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasOperationReferenceValidator>());
        Assert.IsType<PostgresAuthoringCanvasOperationTransaction>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasOperationTransaction>());
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<AuthoringCanvasOperationEngine>());
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<AuthoringCanvasOperationDatabaseVerifier>());
        Assert.IsType<AuthoringCanvasTransport>(
            Assert.Single(scope.ServiceProvider.GetServices<AuthoringCanvasTransport>()));
        Assert.IsType<PostgresAuthoringCanvasCoordinateAuthority>(
            Assert.Single(scope.ServiceProvider.GetServices<IAuthoringCanvasExternalCoordinateAuthority>()));
    }
}
