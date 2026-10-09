using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleCreateContractTests
{
    private static readonly DateTime s_now = new(2026, 9, 8, 12, 0, 0, DateTimeKind.Utc);
    private static readonly ArticleTemplateActor s_actor = new(42, [AdminPermissions.ArticleWrite]);

    [Fact]
    public void Command_RequiresClosedModeAndCompleteTemplateSet()
    {
        ArticleCreateCommand blank = new(s_actor, Guid.CreateVersion7(), ArticleCreateMode.Blank);
        Assert.Equal(ArticleCreateMode.Blank, blank.Mode);
        Assert.Null(blank.Plan);

        Assert.Equal(
            "article_create_mode_invalid",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), (ArticleCreateMode)99)).Code);
        Assert.Equal(
            "article_create_mode_invalid",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), ArticleCreateMode.Blank,
                    templateId: Guid.CreateVersion7())).Code);
        Assert.Equal(
            "article_create_mode_incomplete_template_set",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
                    templateId: Guid.CreateVersion7())).Code);
        Assert.Equal(
            "article_create_mode_incomplete_template_set",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
                    templateId: Guid.CreateVersion7(),
                    templateVersionId: Guid.CreateVersion7())).Code);
    }

    [Fact]
    public void Command_BindsPlanIdentityDigestAndActor()
    {
        ArticleTemplateExpansionPlan plan = ExpansionFixture.BuildPlan(s_actor);
        Guid otherTemplate = Guid.CreateVersion7();

        ArticleCreateCommand valid = new(
            s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
            plan.Input.TemplateId, plan.VersionId, plan, plan.ContentDigest);
        Assert.Same(plan, valid.Plan);

        Assert.Equal(
            "article_create_plan_binding_invalid",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
                    otherTemplate, plan.VersionId, plan, plan.ContentDigest)).Code);
        Assert.Equal(
            "article_create_plan_binding_invalid",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
                    plan.Input.TemplateId, Guid.CreateVersion7(), plan, plan.ContentDigest)).Code);
        Assert.Equal(
            "article_create_plan_binding_invalid",
            Assert.Throws<ArticleCreateValidationException>(
                () => new ArticleCreateCommand(
                    s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
                    plan.Input.TemplateId, plan.VersionId, plan,
                    new string('0', 64))).Code);
        Assert.Throws<ArticleTemplateAccessDeniedException>(
            () => new ArticleCreateCommand(
                new ArticleTemplateActor(77, [AdminPermissions.ArticleWrite]),
                Guid.CreateVersion7(), ArticleCreateMode.Template,
                plan.Input.TemplateId, plan.VersionId, plan, plan.ContentDigest));
    }

    [Fact]
    public void RequestDigest_SeparatesModesAndPlans()
    {
        ArticleTemplateExpansionPlan planA = ExpansionFixture.BuildPlan(s_actor);
        ArticleTemplateExpansionPlan planB = ExpansionFixture.BuildPlan(s_actor, title: "other");
        Guid requestId = Guid.CreateVersion7();
        string blankDigest = ArticleCreateStore.ComputeRequestDigest(
            new ArticleCreateCommand(s_actor, requestId, ArticleCreateMode.Blank));
        string templateDigestA = ArticleCreateStore.ComputeRequestDigest(
            new ArticleCreateCommand(s_actor, requestId, ArticleCreateMode.Template,
                planA.Input.TemplateId, planA.VersionId, planA, planA.ContentDigest));
        string templateDigestB = ArticleCreateStore.ComputeRequestDigest(
            new ArticleCreateCommand(s_actor, requestId, ArticleCreateMode.Template,
                planB.Input.TemplateId, planB.VersionId, planB, planB.ContentDigest));

        Assert.NotEqual(blankDigest, templateDigestA);
        Assert.NotEqual(templateDigestA, templateDigestB);
        Assert.Matches("^[0-9a-f]{64}$", blankDigest);
    }

    [Fact]
    public void Receipt_CarriesNoArticleOrTemplateBody()
    {
        string[] forbidden = ["Title", "Markdown", "Content", "Body", "Description"];
        Assert.All(
            typeof(ArticleCreateReceipt).GetProperties(),
            property => Assert.DoesNotContain(
                forbidden,
                name => property.Name.Contains(name, StringComparison.OrdinalIgnoreCase)
                    && !property.Name.EndsWith("Digest", StringComparison.Ordinal)));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Store_RejectsMissingWritePermissionBeforeReplayOrBlankWrites(bool replayAvailable)
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        IArticleTemplateExpansionVerifier verifier = Substitute.For<IArticleTemplateExpansionVerifier>();
        var store = new ArticleCreateStore(persistence, verifier);
        var command = new ArticleCreateCommand(new ArticleTemplateActor(42, []),
            Guid.CreateVersion7(), ArticleCreateMode.Blank);
        if (replayAvailable)
        {
            persistence.ResolveRequestAsync(command.Actor.AdminPrincipalId, command.RequestId,
                ArticleCreateStore.ComputeRequestDigest(command)).Returns(VerificationReceipt(Guid.CreateVersion7(), 42));
        }

        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(
            () => store.CreateAsync(command));

        await persistence.DidNotReceiveWithAnyArgs().ResolveRequestAsync(default, default, default!);
        await persistence.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!);
    }

    [Fact]
    public async Task Store_CurrentWriterCanReplayWithoutReexecutingOrRecheckingTemplate()
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        IArticleTemplateExpansionVerifier verifier = Substitute.For<IArticleTemplateExpansionVerifier>();
        var store = new ArticleCreateStore(persistence, verifier);
        var command = new ArticleCreateCommand(s_actor, Guid.CreateVersion7(), ArticleCreateMode.Blank);
        ArticleCreateReceipt receipt = VerificationReceipt(Guid.CreateVersion7(), 42);
        persistence.ResolveRequestAsync(s_actor.AdminPrincipalId, command.RequestId,
            ArticleCreateStore.ComputeRequestDigest(command)).Returns(receipt);

        Assert.Same(receipt, await store.CreateAsync(command));

        await persistence.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!);
        await verifier.DidNotReceiveWithAnyArgs().VerifyAsync(default!);
    }

    [Fact]
    public async Task ReceiptVerification_RejectsMissingWritePermissionBeforeReading()
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        var store = new ArticleCreateStore(persistence, Substitute.For<IArticleTemplateExpansionVerifier>());

        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(() => store.VerifyReceiptAsync(
            new ArticleTemplateActor(42, []), Guid.CreateVersion7()));

        await persistence.DidNotReceiveWithAnyArgs().ReadVerificationSnapshotAsync(default);
    }

    [Fact]
    public async Task ReceiptVerification_ForeignOwnerHasTheSameResultAsMissingReceipt()
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        var store = new ArticleCreateStore(persistence, Substitute.For<IArticleTemplateExpansionVerifier>());
        Guid receiptId = Guid.CreateVersion7();
        ArticleCreateReceipt receipt = VerificationReceipt(receiptId, owner: 77);
        var snapshot = new ArticleCreateVerificationSnapshot(receipt,
            null, null, null, null, null, null, null, null, null, 0, false, null);
        persistence.ReadVerificationSnapshotAsync(receiptId).Returns(snapshot);

        ArticleCreateVerificationResult foreign = await store.VerifyReceiptAsync(s_actor, receiptId);
        ArticleCreateVerificationResult missing = await store.VerifyReceiptAsync(s_actor, Guid.CreateVersion7());

        Assert.False(foreign.Valid);
        Assert.Equal(missing.Violations, foreign.Violations);
        Assert.Equal("receipt_missing", Assert.Single(foreign.Violations).Code);

        ArticleCreateVerificationResult owned = await store.VerifyReceiptAsync(
            new ArticleTemplateActor(77, [AdminPermissions.ArticleWrite]), receiptId);
        Assert.Equal(ArticleCreateVerifier.Verify(snapshot).Violations, owned.Violations);
        Assert.DoesNotContain(owned.Violations, violation => violation.Code == "receipt_missing");
    }

    [Theory]
    [InlineData("property")]
    [InlineData("rights")]
    [InlineData("responsibility")]
    [InlineData("prepublish")]
    public async Task Store_RejectsVerifiedDefaultsWithoutAnActualCreateReceiverBeforeWriting(string unsupported)
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        IArticleTemplateExpansionVerifier verifier = Substitute.For<IArticleTemplateExpansionVerifier>();
        var store = new ArticleCreateStore(persistence, verifier);
        ArticleTemplateExpansionPlan plan = ExpansionFixture.BuildPlan(s_actor, defaults: UnsupportedDefaults(unsupported));
        verifier.VerifyAsync(plan, Arg.Any<CancellationToken>()).Returns(new ArticleTemplateVerificationResult(true, []));
        var command = new ArticleCreateCommand(s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
            plan.Input.TemplateId, plan.VersionId, plan, plan.ContentDigest);

        Assert.Equal("article_create_defaults_receiver_unavailable", (await Assert.ThrowsAsync<ArticleCreateValidationException>(
            () => store.CreateAsync(command))).Code);

        await persistence.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!, default);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task Store_VerifiedEmptyOrSupportedMetadataDefaultsStillReachTheCanonicalPersistence(bool empty)
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        IArticleTemplateExpansionVerifier verifier = Substitute.For<IArticleTemplateExpansionVerifier>();
        var store = new ArticleCreateStore(persistence, verifier);
        var defaults = empty ? new ArticleTemplateDefaults() : new ArticleTemplateDefaults(
            summaryPlaceholder: "summary", categoryId: 11, tagIds: [21]);
        ArticleTemplateExpansionPlan plan = ExpansionFixture.BuildPlan(s_actor, defaults: defaults);
        verifier.VerifyAsync(plan, Arg.Any<CancellationToken>()).Returns(new ArticleTemplateVerificationResult(true, []));
        var command = new ArticleCreateCommand(s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
            plan.Input.TemplateId, plan.VersionId, plan, plan.ContentDigest);
        ArticleCreateReceipt receipt = VerificationReceipt(Guid.CreateVersion7(), 42);
        persistence.ExecuteAsync(command, Arg.Any<ArticleCreatePayload>(), Arg.Any<string>(), Arg.Any<CancellationToken>()).Returns(receipt);

        Assert.Same(receipt, await store.CreateAsync(command));

        await persistence.Received(1).ExecuteAsync(command, Arg.Is<ArticleCreatePayload>(payload =>
            payload.Title == plan.Input.Title && payload.MarkdownContent == "# body\n"
            && payload.CategoryId == (empty ? 0 : 11) && payload.TagIds.Count == (empty ? 0 : 1)
            && payload.Summary == defaults.SummaryPlaceholder && payload.DefaultsDigest == plan.DefaultsDigest),
            ArticleCreateStore.ComputeRequestDigest(command), Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Store_CurrentWriterCanReplayAnExactUnsupportedPlanWithoutApplyingItsDefaultsAgain()
    {
        IArticleCreatePersistence persistence = Substitute.For<IArticleCreatePersistence>();
        IArticleTemplateExpansionVerifier verifier = Substitute.For<IArticleTemplateExpansionVerifier>();
        var store = new ArticleCreateStore(persistence, verifier);
        ArticleTemplateExpansionPlan plan = ExpansionFixture.BuildPlan(s_actor, defaults: UnsupportedDefaults("rights"));
        var command = new ArticleCreateCommand(s_actor, Guid.CreateVersion7(), ArticleCreateMode.Template,
            plan.Input.TemplateId, plan.VersionId, plan, plan.ContentDigest);
        ArticleCreateReceipt receipt = VerificationReceipt(Guid.CreateVersion7(), 42);
        persistence.ResolveRequestAsync(s_actor.AdminPrincipalId, command.RequestId,
            ArticleCreateStore.ComputeRequestDigest(command)).Returns(receipt);

        Assert.Same(receipt, await store.CreateAsync(command));

        await persistence.DidNotReceiveWithAnyArgs().ExecuteAsync(default!, default!, default!, default);
        await verifier.DidNotReceiveWithAnyArgs().VerifyAsync(default!, default);
    }

    private static ArticleTemplateDefaults UnsupportedDefaults(string kind)
    {
        var profile = new ArticleTemplateProfileReference(Guid.CreateVersion7(), 1);
        return kind switch
        {
            "property" => new ArticleTemplateDefaults(propertyDefaults:
                [new ArticleTemplatePropertyDefault(Guid.CreateVersion7(), ArticleTemplatePropertyValueKind.Boolean, "false")]),
            "rights" => new ArticleTemplateDefaults(rightsProfile: profile),
            "responsibility" => new ArticleTemplateDefaults(responsibilityProfile: profile),
            "prepublish" => new ArticleTemplateDefaults(prepublishProfile: profile),
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };
    }

    private static ArticleCreateReceipt VerificationReceipt(Guid receiptId, long owner)
        => new(receiptId, Guid.CreateVersion7(), owner, "blank", null, null, null, null,
            1, 1, 1, 1, 1, "create-event", Guid.CreateVersion7(), new string('a', 64),
            new string('b', 64), null, null, new string('c', 64), s_now);

    internal static class ExpansionFixture
    {
        internal static ArticleTemplateExpansionPlan BuildPlan(
            ArticleTemplateActor actor,
            string title = "planned title",
            ArticleTemplateDefaults? defaults = null)
        {
            var templateId = Guid.CreateVersion7();
            var versionId = Guid.CreateVersion7();
            var input = new ArticleTemplateExpansionInput(
                actor,
                templateId,
                versionId,
                title,
                new DateTimeOffset(2026, 9, 8, 0, 0, 0, TimeSpan.Zero),
                "UTC",
                "zh-CN");
            defaults ??= new ArticleTemplateDefaults(categoryId: 11, tagIds: [21]);
            var dependencies = new ArticleTemplateExpansionDependencies(
                defaults.CategoryId, defaults.TagIds, Array.Empty<ArticleTemplateAssetPin>(),
                defaults.PropertyDefaults,
                defaults.RightsProfile, defaults.ResponsibilityProfile, defaults.PrepublishProfile);
            byte[] expanded = System.Text.Encoding.UTF8.GetBytes("# body\n");
            return new ArticleTemplateExpansionPlan(
                input,
                versionId,
                1,
                1,
                ArticleTemplateContract.PersonalScope(actor.AdminPrincipalId),
                expanded,
                ArticleTemplateExpansionPlanner.ComputeSha256(expanded),
                defaults,
                ArticleTemplateContract.ComputeDefaultsDigest(defaults),
                dependencies,
                Array.Empty<string>(),
                s_now,
                s_now.AddMinutes(15));
        }
    }
}
