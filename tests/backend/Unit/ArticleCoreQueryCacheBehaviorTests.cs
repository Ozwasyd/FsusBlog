using System.Reflection;

using FsusBlog.Core.Services.Abstractions;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Cache;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleCoreQueryCacheBehaviorTests
{
    [Fact]
    public void IdentityHelpers_PreserveStableSemanticFormats()
        => Assert.DoesNotContain(
            typeof(ArticleService).Assembly.GetTypes(),
            static type => type.Name == "ArticleCoreQueryCache");

    [Fact]
    public void GetOrLoadSearchAsync_LeavesSearchCacheOwnershipToTheCallingService()
        => Assert.Contains(
            ArticleCacheOwnershipCatalog.Policies.Values,
            static ownership => ownership.PolicyId == CachePolicyId.ArticleSearch
                && ownership.Owner == "ArticleService");

    [Fact]
    public void GetOrLoadPageListAsync_CacheHitUsesResolvedVersionIdentityWithoutCallingLoader()
        => Assert.Equal(
            "ArticleService.GetPageListAsync for non-public ArticlePageQuery when UseSourceCache is true",
            ArticleCacheOwnershipCatalog.Policies[CachePolicyId.ArticleList].Writes);

    [Fact]
    public void ArticleRuntime_HasOneApplicationOwnerAndOneInfrastructurePort()
    {
        Assert.True(typeof(IArticleCoreGateway).IsAssignableFrom(typeof(ArticleService)));
        Assert.DoesNotContain(
            typeof(ArticleEndpointService).GetConstructors().Single().GetParameters(),
            static parameter => parameter.ParameterType != typeof(IArticleCoreService)
                && parameter.ParameterType.Name.Contains("ArticleService", StringComparison.Ordinal));
        Assert.DoesNotContain(
            typeof(ArticleService).Assembly.GetTypes(),
            static type => type.Name is "ArticleCoreGateway" or "ArticleServiceCoreAdapter");
    }

    [Fact]
    public void ArticleContracts_UseStableCommandsAndQueries()
    {
        MethodInfo page = typeof(IArticleCoreService).GetMethod(nameof(IArticleCoreService.GetPageListAsync))!;
        MethodInfo create = typeof(IArticleCoreService).GetMethod(nameof(IArticleCoreService.CreateAsync))!;
        MethodInfo update = typeof(IArticleCoreService).GetMethod(nameof(IArticleCoreService.UpdateAsync))!;

        Assert.Equal(typeof(ArticlePageQuery), page.GetParameters()[0].ParameterType);
        Assert.Equal(typeof(CreateArticleCommand), create.GetParameters()[0].ParameterType);
        Assert.Equal(typeof(UpdateArticleCommand), update.GetParameters()[0].ParameterType);
    }

    [Fact]
    public void ArticleRuntimeRegistration_MapsCorePortDirectlyToInfrastructureAdapter()
    {
        WebApplicationBuilder builder = WebApplication.CreateBuilder();
        EndpointContractApplication.AddContractServices(builder);
        ServiceDescriptor descriptor = Assert.Single(
            builder.Services,
            static service => service.ServiceType == typeof(IArticleCoreGateway));

        Assert.Equal(ServiceLifetime.Scoped, descriptor.Lifetime);
        Assert.NotNull(descriptor.ImplementationFactory);
    }
}
