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
    public void RuntimeDomainServices_ResolveOneProductionReferenceAndOperationAuthority()
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
        Assert.IsType<AuthoringCanvasReferenceFactSource>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasReferenceFactSource>());
        Assert.IsType<PostgresAuthoringCanvasOperationTransaction>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasOperationTransaction>());
        Assert.IsType<AuthoringCanvasOperationReferenceValidator>(
            scope.ServiceProvider.GetRequiredService<IAuthoringCanvasOperationReferenceValidator>());
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<AuthoringCanvasReferenceResolver>());
        Assert.NotNull(scope.ServiceProvider.GetRequiredService<AuthoringCanvasOperationEngine>());
        Assert.Empty(scope.ServiceProvider.GetServices<IAuthoringCanvasCoordinateFactProvider>());
    }
}
