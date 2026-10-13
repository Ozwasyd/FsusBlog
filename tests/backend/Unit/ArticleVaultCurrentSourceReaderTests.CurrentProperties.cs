using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticlePackages;
using FsusBlog.Shared.Contracts.ArticleProperties;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed partial class ArticleVaultCurrentSourceReaderTests
{
    [Fact]
    [Trait("Scope", "CurrentPropertyInputs")]
    public async Task CurrentPropertyInputs_ComposesOriginalReadersAndRetainsNonAdmittingProvenance()
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        var (reader, authority, bindings, model) = PropertyReader(fixture);
        ArticleVaultCurrentPropertyInput result = await reader.ReadAsync(fixture.Reference, fixture.Context, bindings);
        Assert.Same(model.Current, result.Properties.Source);
        Assert.Equal(fixture.Context.AdminPrincipalId, result.Properties.ActorAdminPrincipalId);
        Assert.Equal(result.Server.Package.RevisionId, result.Properties.Source.Snapshot.Coordinates.ArticleRevisionId);
        Assert.Equal("body\r\n"u8.ToArray(), result.Server.Package.RawMarkdown.ToArray());
        Assert.False(result.CanExecute);
        Assert.False(result.CanCommitBase);
        Assert.False(result.Properties.Component.RequirePropertyAuthority().IsValid);
        Assert.Equal(2, fixture.SourceReads);
        Assert.Equal(4, fixture.ObservationReads);
        Assert.Equal(4, fixture.PermissionReads);
        await authority.Received(2).ReadAsync(fixture.Context.AdminPrincipalId,
            new(null, AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope), 101, Arg.Any<CancellationToken>());
        await authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Theory]
    [InlineData("site")]
    [InlineData("article")]
    [InlineData("draft")]
    [InlineData("draft-revision")]
    [InlineData("revision")]
    [Trait("Scope", "CurrentPropertyInputs")]
    public async Task CurrentPropertyInputs_RejectsForeignOrUnsupportedCoordinatesBeforePropertyRead(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        var (reader, authority, bindings, _) = PropertyReader(fixture);
        var coordinates = bindings.SourceCoordinates;
        coordinates = mutation switch
        {
            "site" => coordinates with { SiteScope = "foreign" },
            "article" => coordinates with { ArticleId = 102 },
            "draft" => coordinates with { DraftId = 1 },
            "draft-revision" => coordinates with { DraftServerRevision = 1 },
            _ => coordinates with { ArticleRevisionId = coordinates.ArticleRevisionId + 1 }
        };
        var foreign = new ArticlePackagePropertyMappingBindings(coordinates, bindings.SourceSnapshotDigest, [], [], []);
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => reader.ReadAsync(fixture.Reference, fixture.Context, foreign));
        Assert.Equal(mutation == "revision" ? 1 : 0, fixture.SourceReads);
        await authority.DidNotReceiveWithAnyArgs().ReadAsync(default, default, default, default);
    }

    [Theory]
    [InlineData("missing-head")]
    [InlineData("snapshot-digest")]
    [InlineData("movement")]
    [Trait("Scope", "CurrentPropertyInputs")]
    public async Task CurrentPropertyInputs_PropagatesCanonicalRefusalsWithoutReturningPartialInput(string mutation)
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        var (reader, authority, bindings, model) = PropertyReader(fixture);
        var owner = new ArticlePropertyDefinitionOwner(null, bindings.SourceCoordinates.SiteScope);
        if (mutation == "missing-head")
        {
            authority.ReadAsync(fixture.Context.AdminPrincipalId, owner, 101, Arg.Any<CancellationToken>())
                .Returns(model with
                {
                    Current = null
                });
        }
        else if (mutation == "movement")
        {
            authority.ReadAsync(fixture.Context.AdminPrincipalId, owner, 101, Arg.Any<CancellationToken>())
                .Returns(model, model with
                {
                    Current = model.Current! with
                    {
                        AuditRecordHash = new string('b', 64)
                    }
                });
        }
        else
        {
            bindings = new(bindings.SourceCoordinates, new string('b', 64), [], [], []);
        }
        ArticleVaultExecutionRejectedException error = await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(
            () => reader.ReadAsync(fixture.Reference, fixture.Context, bindings));
        Assert.StartsWith("article_vault_current_property_input_article_package_property_", error.Message);
        Assert.Equal(1, fixture.SourceReads);
        await authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
    }

    [Fact]
    [Trait("Scope", "CurrentPropertyInputs")]
    public async Task CurrentPropertyInputs_RechecksSelectedRevisionAfterActualPropertyReads()
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        var (reader, authority, bindings, model) = PropertyReader(fixture);
        authority.ReadAsync(fixture.Context.AdminPrincipalId, new(null, bindings.SourceCoordinates.SiteScope),
            101, Arg.Any<CancellationToken>()).Returns(_ =>
            {
                fixture.CurrentRevision++;
                return Task.FromResult(model);
            });
        await Assert.ThrowsAsync<ArticleVaultExecutionRejectedException>(() => reader.ReadAsync(fixture.Reference, fixture.Context, bindings));
        Assert.Equal(2, fixture.SourceReads);
        await fixture.Store.DidNotReceiveWithAnyArgs().SaveResultAsync(default!, default);
    }

    [Fact]
    [Trait("Scope", "CurrentPropertyInputs")]
    public async Task CurrentPropertyInputs_InterruptedReadCanRepeatWithoutMutationOrCachedAdmission()
    {
        Fixture fixture = new("body\r\n"u8.ToArray());
        var (reader, authority, bindings, _) = PropertyReader(fixture);
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => reader.ReadAsync(
            fixture.Reference, fixture.Context, bindings, cancelled.Token));
        Assert.Equal(0, fixture.SourceReads);
        ArticleVaultCurrentPropertyInput first = await reader.ReadAsync(fixture.Reference, fixture.Context, bindings);
        ArticleVaultCurrentPropertyInput second = await reader.ReadAsync(fixture.Reference, fixture.Context, bindings);
        Assert.NotSame(first, second);
        Assert.Equal(4, fixture.SourceReads);
        Assert.False(second.CanExecute);
        await authority.DidNotReceiveWithAnyArgs().MutateAsync(default, default!, default);
    }

    [Fact]
    [Trait("Scope", "CurrentPropertyInputs")]
    public void CurrentPropertyInputs_DiRequiresOriginalAuthorityAndExplicitSiteWithoutFallback()
    {
        var services = new ServiceCollection();
        Assert.Throws<ArgumentException>(() => services.AddFsusArticleVaultCurrentPropertyInputs(" "));
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultCurrentPropertyInputs("primary"));
        Assert.Empty(services);
        Fixture fixture = new("body\r\n"u8.ToArray());
        var (_, authority, _, _) = PropertyReader(fixture);
        services.AddSingleton(authority);
        services.AddSingleton(fixture.Reader);
        services.AddFsusArticleVaultCurrentPropertyInputs("primary");
        Assert.Equal(ServiceLifetime.Scoped, services.Single(item => item.ServiceType == typeof(ArticleVaultCurrentPropertyInputReader)).Lifetime);
        using var provider = services.BuildServiceProvider(new ServiceProviderOptions { ValidateScopes = true, ValidateOnBuild = true });
        using var first = provider.CreateScope();
        using var second = provider.CreateScope();
        Assert.Same(first.ServiceProvider.GetRequiredService<ArticleVaultCurrentPropertyInputReader>(),
            first.ServiceProvider.GetRequiredService<ArticleVaultCurrentPropertyInputReader>());
        Assert.NotSame(first.ServiceProvider.GetRequiredService<ArticleVaultCurrentPropertyInputReader>(),
            second.ServiceProvider.GetRequiredService<ArticleVaultCurrentPropertyInputReader>());
        int count = services.Count;
        Assert.Throws<InvalidOperationException>(() => services.AddFsusArticleVaultCurrentPropertyInputs("primary"));
        Assert.Equal(count, services.Count);
    }

    private static (ArticleVaultCurrentPropertyInputReader Reader, IArticlePropertyValueAuthority Authority,
        ArticlePackagePropertyMappingBindings Bindings, ArticlePropertyValueReadModel Model) PropertyReader(Fixture fixture)
    {
        var coordinates = new ArticlePropertySnapshotCoordinates(null,
            AuthoringRevisionCompareDraftContextProvider.PrimarySiteScope, fixture.Context.ArticleId, 3, fixture.CurrentRevision);
        var snapshot = ArticlePropertyValueValidator.BindSnapshot(coordinates, []);
        Guid id = Guid.Parse("00000000-0000-4000-8000-000000000010");
        var persisted = new ArticlePropertyValuePersistedSnapshot(id,
            Guid.Parse("00000000-0000-4000-8000-000000000011"), snapshot, id, "20261009", new string('a', 64));
        var model = new ArticlePropertyValueReadModel(fixture.Context.ArticleId, fixture.CurrentRevision, 3, persisted, [], []);
        var bindings = new ArticlePackagePropertyMappingBindings(coordinates, snapshot.ContentDigest, [], [], []);
        var authority = Substitute.For<IArticlePropertyValueAuthority>();
        authority.ReadAsync(fixture.Context.AdminPrincipalId, new(null, coordinates.SiteScope), fixture.Context.ArticleId,
            Arg.Any<CancellationToken>()).Returns(model);
        return (new(fixture.Reader, new(authority), coordinates.SiteScope), authority, bindings, model);
    }
}
