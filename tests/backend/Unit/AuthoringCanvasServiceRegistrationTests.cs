using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasServiceRegistrationTests
{
    [Fact]
    public async Task RuntimeDomainServices_ResolveOneProductionReferenceAuthority()
    {
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().Build());
        services.AddHttpContextAccessor();
        services.AddScoped(_ => Substitute.For<ISqlSugarClient>());
        services.AddFsusRuntimeDomainServices();
        using ServiceProvider provider = services.BuildServiceProvider();
        using IServiceScope scope = provider.CreateScope();

        Assert.IsType<ArticleRelationSourceCoordinateAuthority>(
            Assert.Single(scope.ServiceProvider.GetServices<ArticleRelationSourceCoordinateAuthority>()));
        Assert.IsType<ArticlePropertyDefinitionStore>(
            scope.ServiceProvider.GetRequiredService<IArticlePropertyDefinitionStore>());
        Assert.Single(scope.ServiceProvider.GetServices<IAuthorSavedViewDependencyProvider>()
            .OfType<ArticlePropertySavedViewDependencyProvider>());
        IAuthorSavedViewDependencyCatalog catalog = scope.ServiceProvider
            .GetRequiredService<IAuthorSavedViewDependencyCatalog>();
        AuthorSavedViewDependencyResolution property = await catalog.ResolveProjectionAsync(
            new AuthorSavedViewOwner(42, "https://property-provider.test"),
            new AuthorSavedViewFieldReference(AuthorSavedViewFieldKind.Property,
                "property:dd90413e-7d50-4264-9910-d89294ac2f18"));
        Assert.Equal(AuthorSavedViewDependencyStatus.PermissionRevoked, property.Status);
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
        Assert.IsType<PostgresAuthoringCanvasCoordinateAuthority>(
            Assert.Single(scope.ServiceProvider.GetServices<IAuthoringCanvasExternalCoordinateAuthority>()));
    }
}
