using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Server.Services.ArticleVault;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class ArticleVaultInstallationSiteIdentityCandidateReaderTests
{
    private const string Identity = "fsus-site:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private const string Scope = "https://approved.example/";

    [Fact]
    public async Task ExactCurrentCandidate_PreservesOriginalTypedModelAndCallerTokenWithoutCreatingAuthority()
    {
        var original = Substitute.For<ISystemSiteIdentityReader>();
        SystemSiteIdentityReadModel current = Current();
        original.ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>()).Returns(current);
        using var cancellation = new CancellationTokenSource();
        var reader = new ArticleVaultInstallationSiteIdentityCandidateReader(original);
        Assert.Same(current, await reader.ReadCandidateAsync(Expected(), cancellation.Token));
        await original.Received(1).ReadCurrentSiteIdentityAsync(cancellation.Token);
        Assert.All(original.ReceivedCalls(), call => Assert.Equal("ReadCurrentSiteIdentityAsync", call.GetMethodInfo().Name));
    }

    [Theory]
    [InlineData(SystemSiteIdentityState.Absent)]
    [InlineData(SystemSiteIdentityState.MigrationRequired)]
    [InlineData(SystemSiteIdentityState.Ambiguous)]
    [InlineData(SystemSiteIdentityState.Malformed)]
    [InlineData(SystemSiteIdentityState.UnsupportedVersion)]
    [InlineData(SystemSiteIdentityState.InitializationRequired)]
    [InlineData((SystemSiteIdentityState)99)]
    public async Task NonCurrentState_RefusesEvenWhenIdentityAndApprovedScopeArePresent(SystemSiteIdentityState state)
    {
        var original = Substitute.For<ISystemSiteIdentityReader>();
        original.ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>()).Returns(Current() with
        {
            State = state
        });
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            new ArticleVaultInstallationSiteIdentityCandidateReader(original).ReadCandidateAsync(Expected()));
    }

    [Theory]
    [InlineData("identity-null")]
    [InlineData("identity-url")]
    [InlineData("identity-uppercase")]
    [InlineData("lifecycle-null")]
    [InlineData("lifecycle-version")]
    [InlineData("generation-null")]
    [InlineData("generation")]
    [InlineData("mapping-null")]
    [InlineData("mapping")]
    [InlineData("scope-missing")]
    [InlineData("scope-case")]
    [InlineData("scope-revision")]
    [InlineData("scope-duplicate")]
    [InlineData("scope-null")]
    [InlineData("scopes-null")]
    public async Task CurrentCandidate_DriftOrMalformedBindingRefusesWithoutUrlOrVaultFallback(string mutation)
    {
        SystemSiteIdentityReadModel current = mutation switch
        {
            "identity-null" => Current() with { Identity = null },
            "identity-url" => Current() with { Identity = Scope },
            "identity-uppercase" => Current() with { Identity = Identity.ToUpperInvariant() },
            "lifecycle-null" => Current() with { LifecycleVersion = null },
            "lifecycle-version" => Current() with { LifecycleVersion = 2 },
            "generation-null" => Current() with { Generation = null },
            "generation" => Current() with { Generation = 2 },
            "mapping-null" => Current() with { MappingRevision = null },
            "mapping" => Current() with { MappingRevision = 2 },
            "scope-missing" => Current() with { Scopes = [] },
            "scope-case" => Current() with { Scopes = [new(Scope.ToUpperInvariant(), 1)] },
            "scope-revision" => Current() with { Scopes = [new(Scope, 2)] },
            "scope-duplicate" => Current() with { Scopes = [new(Scope, 1), new(Scope, 1)] },
            "scope-null" => Current() with { Scopes = [null!] },
            _ => Current() with { Scopes = null! }
        };
        var original = Substitute.For<ISystemSiteIdentityReader>();
        original.ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>()).Returns(current);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            new ArticleVaultInstallationSiteIdentityCandidateReader(original).ReadCandidateAsync(Expected()));
    }

    [Theory]
    [InlineData("lifecycle")]
    [InlineData("generation")]
    [InlineData("mapping")]
    [InlineData("scope-empty")]
    [InlineData("scope-revision")]
    [InlineData("scope-after-mapping")]
    public async Task InvalidHostExpectation_RefusesBeforeOriginalRead(string mutation)
    {
        ArticleVaultInstallationSiteIdentityExpectation expected = mutation switch
        {
            "lifecycle" => Expected() with { LifecycleVersion = 2 },
            "generation" => Expected() with { Generation = 0 },
            "mapping" => Expected() with { MappingRevision = 0 },
            "scope-empty" => Expected() with { ApprovedScope = new(" ", 1) },
            "scope-revision" => Expected() with { ApprovedScope = new(Scope, 0) },
            _ => Expected() with { ApprovedScope = new(Scope, 2) }
        };
        var original = Substitute.For<ISystemSiteIdentityReader>();
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() =>
            new ArticleVaultInstallationSiteIdentityCandidateReader(original).ReadCandidateAsync(expected));
        Assert.Empty(original.ReceivedCalls());
    }

    [Fact]
    public async Task OriginalStorageException_PropagatesWithoutFallbackOrProvisioning()
    {
        var original = Substitute.For<ISystemSiteIdentityReader>();
        var error = new InvalidOperationException("original-storage-unavailable");
        original.ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>())
            .Returns(Task.FromException<SystemSiteIdentityReadModel>(error));
        Assert.Same(error, await Assert.ThrowsAsync<InvalidOperationException>(() =>
            new ArticleVaultInstallationSiteIdentityCandidateReader(original).ReadCandidateAsync(Expected())));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task CancellationBeforeOrDuringRead_PreservesCallerRefusal(bool during)
    {
        var original = Substitute.For<ISystemSiteIdentityReader>();
        using var cancellation = new CancellationTokenSource();
        original.ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>()).Returns(_ =>
        {
            cancellation.Cancel();
            return Task.FromResult(Current());
        });
        if (!during)
        {
            cancellation.Cancel();
        }
        OperationCanceledException error = await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            new ArticleVaultInstallationSiteIdentityCandidateReader(original).ReadCandidateAsync(Expected(), cancellation.Token));
        Assert.Equal(cancellation.Token, error.CancellationToken);
        Assert.Equal(during ? 1 : 0, original.ReceivedCalls().Count());
    }

    [Fact]
    public async Task RepeatedRead_DoesNotCacheTheFirstMappingAfterOriginalAuthorityMoves()
    {
        var original = Substitute.For<ISystemSiteIdentityReader>();
        original.ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>())
            .Returns(Current(), Current() with
            {
                MappingRevision = 2
            });
        var reader = new ArticleVaultInstallationSiteIdentityCandidateReader(original);
        Assert.Equal(Identity, (await reader.ReadCandidateAsync(Expected())).Identity);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => reader.ReadCandidateAsync(Expected()));
        await original.Received(2).ReadCurrentSiteIdentityAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public void ExplicitCandidateComposition_SharesOriginalReaderWithoutInstallingAuthorityOrTrustedReaders()
    {
        var original = Substitute.For<ISystemSiteIdentityReader>();
        var services = new ServiceCollection();
        services.AddSingleton(original);
        services.AddFsusArticleVaultInstallationSiteIdentityCandidates();
        using ServiceProvider provider = services.BuildServiceProvider(validateScopes: true);
        using IServiceScope first = provider.CreateScope();
        using IServiceScope second = provider.CreateScope();
        Assert.Same(original, first.ServiceProvider.GetRequiredService<ISystemSiteIdentityReader>());
        Assert.Same(first.ServiceProvider.GetRequiredService<ArticleVaultInstallationSiteIdentityCandidateReader>(),
            first.ServiceProvider.GetRequiredService<ArticleVaultInstallationSiteIdentityCandidateReader>());
        Assert.NotSame(first.ServiceProvider.GetRequiredService<ArticleVaultInstallationSiteIdentityCandidateReader>(),
            second.ServiceProvider.GetRequiredService<ArticleVaultInstallationSiteIdentityCandidateReader>());
        Assert.DoesNotContain(services, descriptor => descriptor.ServiceType == typeof(ArticleVaultConflictReviewReader)
            || descriptor.ServiceType == typeof(ArticleVaultRecoveryStageComposition));
        Assert.Empty(original.ReceivedCalls());
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public void ExplicitCandidateComposition_MissingOriginalOrDuplicateFailsWithoutMutation(bool duplicate)
    {
        var services = new ServiceCollection();
        if (duplicate)
        {
            services.AddSingleton(Substitute.For<ISystemSiteIdentityReader>());
            services.AddFsusArticleVaultInstallationSiteIdentityCandidates();
        }
        int count = services.Count;
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultInstallationSiteIdentityCandidates());
        Assert.Equal(count, services.Count);
    }

    private static SystemSiteIdentityReadModel Current() => new(SystemSiteIdentityState.Current, Identity,
        1, 1, 1, [new(Scope, 1)]);

    private static ArticleVaultInstallationSiteIdentityExpectation Expected() => new(1, 1, 1, new(Scope, 1));
}
