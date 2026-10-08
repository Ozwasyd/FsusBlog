using FsusBlog.Core.Services.Gateways;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Fixtures;

using Microsoft.AspNetCore.Http;

using NSubstitute;

using SqlSugar;

namespace FsusBlog.Server.Tests.Unit;

public sealed class PublicCacheChurnArticleProjectionReaderTests
{
    private const string RunId = "current-run";
    private const string Namespace = "current-namespace";
    private static readonly string s_digest = new('a', 64);

    [Theory]
    [InlineData("other-run", Namespace, 7)]
    [InlineData(RunId, "other-namespace", 7)]
    [InlineData(RunId, Namespace, 8)]
    [InlineData(RunId, Namespace, 0)]
    public async Task CrossRunOrEntityReceipt_RefusesBeforeCanonicalReaderIo(string runId, string testNamespace, int articleId)
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        CanonicalArticleProjectionVerifier verifier = CreateVerifier(db);
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RuntimeCacheChurnArticleProjectionReader.ReadAsync(
                verifier, Scope(), runId, testNamespace, articleId, Receipt(), Invocation(), CancellationToken.None));
        Assert.Equal("cache_churn_article_producer_identity_mismatch", error.Message);
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task OriginalInvocationMismatch_IsRejectedByCanonicalVerifier()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        CanonicalArticlePublicationRequest substituted = Invocation() with
        {
            Binding = Invocation().Binding with
            {
                RunId = "substituted-run"
            }
        };
        CanonicalArticleProjectionVerificationException error =
            await Assert.ThrowsAsync<CanonicalArticleProjectionVerificationException>(() =>
                RuntimeCacheChurnArticleProjectionReader.ReadAsync(
                    CreateVerifier(db), Scope(), RunId, Namespace, 7, Receipt(), substituted, CancellationToken.None));
        Assert.Contains("publication_current_invocation_binding_mismatch", error.Violations);
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task MissingOriginalInvocation_IsNotReconstructedFromReceiptLabels()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        await Assert.ThrowsAsync<ArgumentNullException>(() => RuntimeCacheChurnArticleProjectionReader.ReadAsync(
            CreateVerifier(db), Scope(), RunId, Namespace, 7, Receipt(), null!, CancellationToken.None));
        Assert.Empty(db.ReceivedCalls());
    }

    [Fact]
    public async Task WrongActualRuntimeScope_RefusesEvenWhenAllReceiptLabelsMatch()
    {
        ISqlSugarClient db = Substitute.For<ISqlSugarClient>();
        IRuntimeKeyScope scope = Scope();
        scope.ScopeToken.Returns("other-runtime-scope");
        InvalidOperationException error = await Assert.ThrowsAsync<InvalidOperationException>(() =>
            RuntimeCacheChurnArticleProjectionReader.ReadAsync(
                CreateVerifier(db), scope, RunId, Namespace, 7, Receipt(), Invocation(), CancellationToken.None));
        Assert.Equal("cache_churn_article_producer_identity_mismatch", error.Message);
        Assert.Empty(db.ReceivedCalls());
    }

    private static IRuntimeKeyScope Scope()
    {
        IRuntimeKeyScope scope = Substitute.For<IRuntimeKeyScope>();
        scope.ScopeToken.Returns(Namespace);
        return scope;
    }

    private static CanonicalArticlePublicationRequest Invocation()
        => new(new(RunId, Namespace, "profile", ["public.article"], 1, s_digest, s_digest),
            new("canary", "Canary title", "Canary content", CategoryId: 2));

    // Deliberately insufficient authority used only for refusal controls. No
    // test treats this record as a producer-issued or qualifying receipt.
    private static CanonicalArticlePublicationReceipt Receipt()
        => new(CanonicalArticlePublicationFixturePort.Schema, s_digest, RunId, Namespace, "profile", "canary", 1,
            7, 10, 1, 20, 1, 30, s_digest, s_digest, 40, 1, "event", s_digest, "audit", s_digest,
            s_digest, [], s_digest);

    private static CanonicalArticleProjectionVerifier CreateVerifier(ISqlSugarClient db)
        => new(db, Substitute.For<ISearchIndexService>(), Substitute.For<IArticleCoreGateway>(),
            Substitute.For<IPublicArticleProjectionStore>(), Substitute.For<IArticleDetailAedsArtifactStore>(),
            new PublicHotReadStore(), Substitute.For<IPublicAotInvalidationGenerationAuthority>(),
            Substitute.For<IPublicAotArtifactStore>(), Substitute.For<IPublicArtifactStorage>(),
            Substitute.For<IHttpContextAccessor>(), new PublicArtifactRevocationRegistry(),
            Substitute.For<IPublicArtifactRevocationStateStore>(), Substitute.For<ICacheStringReader>(),
            Substitute.For<IRuntimeKeyScope>(), TimeProvider.System);
}
