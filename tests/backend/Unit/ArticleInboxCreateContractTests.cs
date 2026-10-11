using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleInboxCreateContractTests
{
    private static readonly ArticleTemplateActor s_actor = new(42, [AdminPermissions.ArticleWrite]);

    [Fact]
    public void CreateModes_KeepExistingPersistedValuesAndAppendExplicitInbox()
    {
        Assert.Equal(0, (int)ArticleCreateMode.Blank);
        Assert.Equal(1, (int)ArticleCreateMode.Template);
        Assert.Equal(2, (int)ArticleCreateMode.Inbox);
        Assert.Equal("inbox", new ArticleCreateCommand(s_actor, Guid.NewGuid(), ArticleCreateMode.Inbox).ModeToken);
    }

    [Theory]
    [InlineData("templateId")]
    [InlineData("templateVersionId")]
    [InlineData("planDigest")]
    public void InboxCommand_RefusesEveryTemplateField(string field)
    {
        Assert.Equal("article_create_mode_invalid", Assert.Throws<ArticleCreateValidationException>(() =>
            new ArticleCreateCommand(s_actor, Guid.NewGuid(), ArticleCreateMode.Inbox,
                templateId: field == "templateId" ? Guid.NewGuid() : null,
                templateVersionId: field == "templateVersionId" ? Guid.NewGuid() : null,
                planDigest: field == "planDigest" ? new string('a', 64) : null)).Code);
    }

    [Fact]
    public void InboxRequestDigest_CannotReplayAnOrdinaryBlankRequest()
    {
        Guid requestId = Guid.NewGuid();
        Assert.NotEqual(
            ArticleCreateStore.ComputeRequestDigest(new ArticleCreateCommand(s_actor, requestId, ArticleCreateMode.Blank)),
            ArticleCreateStore.ComputeRequestDigest(new ArticleCreateCommand(s_actor, requestId, ArticleCreateMode.Inbox)));
    }

    [Fact]
    public async Task ExplicitInbox_ReusesTheExistingCreatePersistenceAndEmptyPayload()
    {
        var persistence = Substitute.For<IArticleCreatePersistence>();
        var expansion = Substitute.For<IArticleTemplateExpansionVerifier>();
        var store = new ArticleCreateStore(persistence, expansion);
        Guid requestId = Guid.NewGuid();
        ArticleCreateReceipt receipt = BuildSnapshot(requestId).Receipt;
        persistence.ExecuteAsync(Arg.Any<ArticleCreateCommand>(), Arg.Any<ArticleCreatePayload>(),
            Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(receipt);

        Assert.Same(receipt, await store.CreateInboxAsync(s_actor, requestId));

        await persistence.Received(1).ExecuteAsync(
            Arg.Is<ArticleCreateCommand>(command => command.Mode == ArticleCreateMode.Inbox && command.RequestId == requestId),
            Arg.Is<ArticleCreatePayload>(payload => payload.Title == string.Empty && payload.CategoryId == 0
                && payload.MarkdownContent == string.Empty && payload.TagIds.Count == 0 && payload.ExplicitAssetIds.Count == 0),
            Arg.Any<string>(), Arg.Any<CancellationToken>());
        await expansion.DidNotReceiveWithAnyArgs().VerifyAsync(default!, default);
    }

    [Fact]
    public async Task ExplicitInbox_MissingWritePermissionRefusesBeforeReplayOrPersistence()
    {
        var persistence = Substitute.For<IArticleCreatePersistence>();
        var store = new ArticleCreateStore(persistence, Substitute.For<IArticleTemplateExpansionVerifier>());
        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(() =>
            store.CreateInboxAsync(new ArticleTemplateActor(42, []), Guid.NewGuid()));
        await persistence.DidNotReceiveWithAnyArgs().ResolveRequestAsync(default, default, default!, default);
        await persistence.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!, default);
    }

    [Fact]
    public void InboxReceipt_RequiresActualEditableArticleAndDraftCoordinates()
        => Assert.True(ArticleCreateVerifier.Verify(BuildSnapshot(Guid.NewGuid())).Valid);

    [Theory]
    [InlineData("initialStatus")]
    [InlineData("articleStatus")]
    [InlineData("draftStatus")]
    [InlineData("draftArticle")]
    [InlineData("draftRevision")]
    [InlineData("draftOwner")]
    [InlineData("draftKey")]
    public void InboxReceipt_RefusesLifecycleOrIdentityDrift(string field)
    {
        ArticleCreateVerificationSnapshot snapshot = BuildSnapshot(Guid.NewGuid());
        snapshot = field switch
        {
            "initialStatus" => snapshot with { Receipt = snapshot.Receipt with { InitialStatus = "draft" } },
            "articleStatus" => snapshot with { ArticleStatus = (int)ArticleStatus.Published },
            "draftStatus" => snapshot with { DraftStatus = (int)ArticleStatus.Draft },
            "draftArticle" => snapshot with { DraftArticleId = 99 },
            "draftRevision" => snapshot with { DraftBaseRevisionId = 99 },
            "draftOwner" => snapshot with { DraftOwnerAdminPrincipalId = 99 },
            "draftKey" => snapshot with { DraftKey = "foreign-key" },
            _ => throw new ArgumentOutOfRangeException(nameof(field))
        };
        Assert.False(ArticleCreateVerifier.Verify(snapshot).Valid);
    }

    // Pure verifier input, never a durable database receipt or runtime qualification.
    private static ArticleCreateVerificationSnapshot BuildSnapshot(Guid requestId)
    {
        var auditRef = Guid.NewGuid();
        var receipt = new ArticleCreateReceipt(Guid.NewGuid(), requestId, 42, "inbox", null, null, null, null,
            1, 2, 1, 3, 1, "unit-create-event", auditRef, new string('a', 64), new string('b', 64),
            null, null, new string('c', 64), DateTime.UnixEpoch, InitialStatus: "inbox");
        var audit = new ArticleTemplateAuditLink(auditRef, "article", "business", AdminPermissions.ArticleWrite,
            "article-create-receipt", auditRef.ToString("N"), receipt.AuditDigest, "inbox", "success", true);
        return new ArticleCreateVerificationSnapshot(receipt, 1, (int)ArticleStatus.Inbox, 3, null,
            2, 1, string.Empty, 3, 1, 0, true, audit, (int)ArticleStatus.Inbox, 1, 3, 42,
            $"canonical-create:{requestId:N}");
    }
}
