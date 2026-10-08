using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleVaultRecoveryServiceRegistrationTests
{
    [Fact]
    public void ExplicitServerComposition_ResolvesCanonicalReadersInOneScopedBinding()
    {
        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        services.AddSingleton<IConfiguration>(new ConfigurationBuilder().AddInMemoryCollection(
            new Dictionary<string, string?> { ["SITE_BASEURL"] = "https://site.example/" }).Build());
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddSingleton(Substitute.For<IArticleVaultOperationCheckpointStore>());
        services.AddSingleton(Substitute.For<IAuthoringRevisionCompareAuthority>());
        services.AddSingleton(Substitute.For<IAuthoringDraftLifecycle>());
        services.AddSingleton(Substitute.For<IAuthorRecentArticleHistoryPermissionProjectionProvider>());
        services.AddFsusArticleVaultRecoveryReaders("site-primary");
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope scope = provider.CreateScope();
        Assert.IsType<AuthoringRevisionComparePackageReader>(scope.ServiceProvider.GetRequiredService<IRevisionComparePackageReader>());
        Assert.IsType<ArticleVaultAcceptedSourceAdapter>(scope.ServiceProvider.GetRequiredService<ArticleVaultAcceptedSourceAdapter>());
        Assert.IsType<ArticleVaultRecoveryCheckpointReader>(scope.ServiceProvider.GetRequiredService<ArticleVaultRecoveryCheckpointReader>());
        Assert.Equal(ServiceLifetime.Scoped, Assert.Single(services,
            static descriptor => descriptor.ServiceType == typeof(ArticleVaultAcceptedSourceAdapter)).Lifetime);
        Assert.Equal("article_vault_recovery_site_binding_already_registered", Assert.Throws<InvalidOperationException>(
            () => services.AddFsusArticleVaultRecoveryReaders("foreign-site")).Message);
    }

    [Theory]
    [InlineData("")]
    [InlineData(" ")]
    public void MissingExplicitSite_DoesNotInstallAReaderOrGuessFromConfiguration(string site)
    {
        var services = new ServiceCollection();
        Assert.Throws<ArgumentException>(() => services.AddFsusArticleVaultRecoveryReaders(site));
        Assert.Empty(services);
    }

    [Fact]
    public void MissingCanonicalCheckpointStore_IsARealCompositionFailure()
    {
        var services = new ServiceCollection();
        services.AddSingleton(Substitute.For<IArticleVaultExecutionStore>());
        services.AddFsusArticleVaultRecoveryReaders("site-primary");
        using ServiceProvider provider = services.BuildServiceProvider();
        Assert.Throws<InvalidOperationException>(() => provider.GetRequiredService<ArticleVaultRecoveryCheckpointReader>());
        Assert.DoesNotContain(services, static descriptor => descriptor.ServiceType == typeof(IArticleVaultOperationCheckpointStore));
    }
}
