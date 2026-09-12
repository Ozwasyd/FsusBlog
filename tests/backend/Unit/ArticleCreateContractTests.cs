using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

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

    internal static class ExpansionFixture
    {
        internal static ArticleTemplateExpansionPlan BuildPlan(
            ArticleTemplateActor actor,
            string title = "planned title")
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
            var defaults = new ArticleTemplateDefaults(categoryId: 11, tagIds: [21]);
            var dependencies = new ArticleTemplateExpansionDependencies(
                11, [21], Array.Empty<ArticleTemplateAssetPin>(),
                Array.Empty<ArticleTemplatePropertyDefault>(),
                null, null, null);
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
