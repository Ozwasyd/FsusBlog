using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Services.Authoring;

using Microsoft.Extensions.DependencyInjection;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class AuthoringCanvasRequestLifetimeTests
{
    private static readonly AuthoringCanvasOwner s_owner = new(73, "primary-site");

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task MissingValidatedSession_RejectsResolutionAndValidationBeforeCanvasRead(bool validateOperation)
    {
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);
        services.AddHttpContextAccessor();
        services.AddScoped(_ => Substitute.For<ISqlSugarClient>());
        services.AddFsusRuntimeDomainServices();
        IAuthoringCanvasDocumentStore store = Substitute.For<IAuthoringCanvasDocumentStore>();
        store.GetAsync(Arg.Any<AuthoringCanvasOwner>(), Arg.Any<Guid>(), Arg.Any<CancellationToken>())
            .Returns<Task<AuthoringCanvasDocumentHeader?>>(_ =>
                throw new InvalidOperationException("canvas_read_before_validated_session"));
        services.AddScoped(_ => store);
        using ServiceProvider provider = services.BuildServiceProvider();
        using IServiceScope scope = provider.CreateScope();
        var node = new AuthoringCanvasNode(
            Guid.CreateVersion7(),
            AuthoringCanvasNodeType.ArticleReference,
            0,
            new AuthoringCanvasGeometry(0, 0, 100, 100),
            TargetArticleId: 204,
            ReferenceState: AuthoringCanvasReferenceState.Current);
        Guid canvasId = Guid.CreateVersion7();
        string digest = new('c', 64);

        if (validateOperation)
        {
            IAuthoringCanvasOperationReferenceValidator validator = scope.ServiceProvider
                .GetRequiredService<IAuthoringCanvasOperationReferenceValidator>();
            await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => validator.ValidateAsync(
                new AuthoringCanvasOperationReferenceValidationRequest(
                    Guid.CreateVersion7(), canvasId, 1, digest, s_owner, [node])));
        }
        else
        {
            AuthoringCanvasReferenceResolver resolver = scope.ServiceProvider
                .GetRequiredService<AuthoringCanvasReferenceResolver>();
            await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => resolver.ResolveAsync(
                new AuthoringCanvasReferenceResolutionRequest(
                    Guid.CreateVersion7(), canvasId, 1, digest, s_owner,
                    AuthoringCanvasReferencePermission.ArticleRead, [node])));
        }

        Assert.Empty(store.ReceivedCalls());
    }

    [Fact]
    public async Task MissingValidatedSession_RejectsRecoveryBeforeJournalRead()
    {
        var services = new ServiceCollection();
        services.AddSingleton(TimeProvider.System);
        services.AddHttpContextAccessor();
        services.AddScoped(_ => Substitute.For<ISqlSugarClient>());
        services.AddFsusRuntimeDomainServices();
        IAuthoringCanvasOperationTransaction transaction = Substitute.For<IAuthoringCanvasOperationTransaction>();
        transaction.RecoverAsync(Arg.Any<AuthoringCanvasOperationRecoveryQuery>(), Arg.Any<CancellationToken>())
            .Returns<Task<AuthoringCanvasOperationReceipt?>>(_ =>
                throw new InvalidOperationException("journal_read_before_validated_session"));
        services.AddScoped(_ => transaction);
        using ServiceProvider provider = services.BuildServiceProvider();
        using IServiceScope scope = provider.CreateScope();
        AuthoringCanvasOperationEngine engine = scope.ServiceProvider
            .GetRequiredService<AuthoringCanvasOperationEngine>();

        await Assert.ThrowsAsync<AuthoringCanvasAccessDeniedException>(() => engine.RecoverAsync(
            new AuthoringCanvasOperationRecoveryQuery(
                Guid.CreateVersion7(), s_owner, Guid.CreateVersion7(), new string('d', 64))));

        Assert.Empty(transaction.ReceivedCalls());
    }
}
