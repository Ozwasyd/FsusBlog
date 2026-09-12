using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleTemplateExpansionTests
{
    private static readonly DateTime s_now = new(2026, 9, 8, 12, 0, 0, DateTimeKind.Utc);
    private static readonly DateTimeOffset s_businessTime = new(2026, 9, 8, 23, 30, 0, TimeSpan.Zero);

    [Fact]
    public async Task Planner_ExpandsAllClosedVariablesDeterministically()
    {
        var fixture = new ExpansionFixture(
            "# {{title}}\n\nby {{author}} on {{date}} in {{site_locale}}\n",
            defaults: new ArticleTemplateDefaults(titlePlaceholder: "Draft {{date}}"));
        ArticleTemplateExpansionInput input = fixture.Input("Quarterly *Report*");

        ArticleTemplateExpansionPlan plan = await fixture.Planner.PlanAsync(input);
        string text = System.Text.Encoding.UTF8.GetString(plan.ExpandedSource);

        Assert.Equal(
            "# Quarterly \\*Report\\*\n\nby Test Author on 2026-09-09 in zh-CN\n",
            text);
        Assert.Equal(
            ArticleTemplateExpansionPlanner.ComputeSha256(plan.ExpandedSource),
            plan.ExpandedSourceDigest);
        Assert.Equal(plan.ExpiresAtUtc, plan.IssuedAtUtc.Add(TimeSpan.FromMinutes(15)));
        Assert.Equal(1, plan.VersionNumber);
        Assert.Equal(1, plan.TemplateRevision);
        Assert.Equal(
            ArticleTemplateContract.ComputeExpansionPlanDigest(plan),
            plan.ContentDigest);

        ArticleTemplateExpansionPlan second = await fixture.Planner.PlanAsync(input);
        Assert.Equal(plan.ExpandedSource, second.ExpandedSource);
        Assert.Equal(plan.ContentDigest, second.ContentDigest);
    }

    [Fact]
    public async Task Planner_PreservesByteSemanticsAroundSubstitutions()
    {
        var fixture = new ExpansionFixture(
            "﻿# {{title}}  \r\n\r\n{{date}}\t{{author}}",
            defaults: new ArticleTemplateDefaults());
        ArticleTemplateExpansionPlan plan = await fixture.Planner.PlanAsync(fixture.Input("plain"));

        string text = System.Text.Encoding.UTF8.GetString(plan.ExpandedSource);
        Assert.StartsWith("﻿# ", text);
        Assert.Contains("  \r\n\r\n", text);
        Assert.EndsWith("\tTest Author", text);
        Assert.DoesNotContain("{{", text);
    }

    [Fact]
    public async Task Planner_RequiresTitleWhenTokenPresentAndEscapesControlInput()
    {
        var fixture = new ExpansionFixture("# {{title}}", defaults: new ArticleTemplateDefaults());
        Assert.Equal(
            "article_template_expansion_title_required",
            (await Assert.ThrowsAsync<ArticleTemplateExpansionException>(
                () => fixture.Planner.PlanAsync(fixture.Input(null)))).Code);
        Assert.Equal(
            "article_template_expansion_value_control_character",
            (await Assert.ThrowsAsync<ArticleTemplateValidationException>(
                () => fixture.Planner.PlanAsync(fixture.Input("line\nbreak")))).Code);
    }

    [Fact]
    public async Task Planner_FailsClosedOnUnknownLocaleTimezoneAndMissingTemplate()
    {
        var fixture = new ExpansionFixture("plain", defaults: new ArticleTemplateDefaults());
        Assert.Equal(
            "article_template_expansion_locale_unknown",
            Assert.Throws<ArticleTemplateValidationException>(
                () => fixture.Input("t", locale: "xx-INVALID")).Code);
        Assert.Equal(
            "article_template_expansion_timezone_unknown",
            Assert.Throws<ArticleTemplateValidationException>(
                () => fixture.Input("t", timeZone: "Mars/Olympus")).Code);
        Assert.Equal(
            "article_template_expansion_time_not_utc",
            Assert.Throws<ArticleTemplateValidationException>(
                () => fixture.Input("t", businessTime: s_businessTime.ToOffset(TimeSpan.FromHours(8)))).Code);
        await Assert.ThrowsAsync<ArticleTemplateNotFoundException>(
            () => fixture.Planner.PlanAsync(fixture.Input("t", templateId: Guid.CreateVersion7())));
    }

    [Fact]
    public async Task Planner_EnforcesUsePermissionAndActiveStatus()
    {
        var fixture = new ExpansionFixture("plain", defaults: new ArticleTemplateDefaults());
        var outsider = new ArticleTemplateActor(77, [AdminPermissions.ArticleWrite]);
        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(
            () => fixture.Planner.PlanAsync(fixture.Input("t", actor: outsider)));

        fixture.Persistence.Definitions[fixture.TemplateId] = fixture.Definition with
        {
            Status = ArticleTemplateStatus.Retired
        };
        await Assert.ThrowsAsync<ArticleTemplateAccessDeniedException>(
            () => fixture.Planner.PlanAsync(fixture.Input("t")));
    }

    [Fact]
    public async Task Planner_ValidatesReferencesBeforePlanning()
    {
        var fixture = new ExpansionFixture("plain", defaults: new ArticleTemplateDefaults());
        fixture.References.Reject = true;
        Assert.Equal(
            "stale_reference",
            (await Assert.ThrowsAsync<ArticleTemplateReferenceException>(
                () => fixture.Planner.PlanAsync(fixture.Input("t")))).Code);
    }

    [Fact]
    public async Task Plan_BindsTypedDefaultsAndDependencyPinsWithoutInterpolation()
    {
        Guid assetId = Guid.Parse("11111111-1111-1111-1111-111111111111");
        var defaults = new ArticleTemplateDefaults(
            categoryId: 11,
            tagIds: [21, 22],
            assetIds: [FsusBlog.Server.Contracts.Assets.AssetId.FromGuid(assetId)]);
        var fixture = new ExpansionFixture("plain", defaults);
        fixture.ExpansionAuthority.AssetPins[assetId] = new(
            assetId, "active", "public", new string('a', 64), s_now);

        ArticleTemplateExpansionPlan plan = await fixture.Planner.PlanAsync(fixture.Input("t"));
        Assert.Equal(11, plan.Dependencies.CategoryId);
        Assert.Equal([21, 22], plan.Dependencies.TagIds);
        ArticleTemplateAssetPin pin = Assert.Single(plan.Dependencies.AssetPins);
        Assert.Equal(assetId, pin.AssetId);
        Assert.Equal("active", pin.State);
        Assert.Same(defaults, plan.Defaults);
        Assert.Equal(defaults.TitlePlaceholder, plan.Defaults.TitlePlaceholder);
    }

    [Fact]
    public async Task Verifier_RecomputesAndRejectsTamperAndDrift()
    {
        var fixture = new ExpansionFixture("# {{title}} by {{author}}", defaults: new ArticleTemplateDefaults());
        ArticleTemplateExpansionPlan plan = await fixture.Planner.PlanAsync(fixture.Input("v1"));

        ArticleTemplateVerificationResult valid = await fixture.Verifier.VerifyAsync(plan);
        Assert.True(valid.Valid, string.Join(',', valid.Violations.Select(v => v.Code)));

        // Authority drift: display name change invalidates the pinned plan.
        fixture.ExpansionAuthority.DisplayName = "Renamed Author";
        ArticleTemplateVerificationResult drifted = await fixture.Verifier.VerifyAsync(plan);
        Assert.False(drifted.Valid);
        Assert.Contains(drifted.Violations, v => v.Code == "expansion_plan_recompute_mismatch");

        // Permission loss blocks reuse.
        fixture.ExpansionAuthority.DisplayName = "Test Author";
        var outsiderPlan = new ArticleTemplateExpansionPlan(
            new ArticleTemplateExpansionInput(
                new ArticleTemplateActor(77, [AdminPermissions.ArticleWrite]),
                plan.Input.TemplateId,
                plan.Input.VersionId,
                "v1",
                s_businessTime,
                "UTC",
                "zh-CN"),
            plan.VersionId,
            plan.VersionNumber,
            plan.TemplateRevision,
            plan.Scope,
            plan.ExpandedSource,
            plan.ExpandedSourceDigest,
            plan.Defaults,
            plan.DefaultsDigest,
            plan.Dependencies,
            plan.Warnings,
            plan.IssuedAtUtc,
            plan.ExpiresAtUtc);
        ArticleTemplateVerificationResult denied = await fixture.Verifier.VerifyAsync(outsiderPlan);
        Assert.False(denied.Valid);
        Assert.Contains(denied.Violations, v => v.Code == "expansion_plan_permission_lost");
    }

    [Fact]
    public async Task Verifier_RejectsExpiredPlans()
    {
        var fixture = new ExpansionFixture("plain", defaults: new ArticleTemplateDefaults());
        ArticleTemplateExpansionPlan plan = await fixture.Planner.PlanAsync(fixture.Input("t"));
        fixture.Clock.Value = s_now.AddMinutes(16);
        ArticleTemplateVerificationResult expired = await fixture.Verifier.VerifyAsync(plan);
        Assert.False(expired.Valid);
        Assert.Contains(expired.Violations, v => v.Code == "expansion_plan_expired");
    }

    [Fact]
    public void Input_HasNoArticleIdentityOrExecutionState()
    {
        string[] forbidden =
        [
            "ArticleId", "DraftId", "RevisionId", "PublicationStatus", "PublishedAt",
            "ViewCount", "CommentCount", "SessionId", "HistoryId"
        ];
        Assert.All(
            typeof(ArticleTemplateExpansionPlan).GetProperties()
                .Concat(typeof(ArticleTemplateExpansionInput).GetProperties()),
            property => Assert.DoesNotContain(
                forbidden,
                name => string.Equals(property.Name, name, StringComparison.OrdinalIgnoreCase)));
    }

    private sealed class ExpansionFixture
    {
        internal ExpansionFixture(string sourceText, ArticleTemplateDefaults defaults)
        {
            var source = ArticleTemplateSource.FromUtf8(sourceText);
            string defaultsDigest = ArticleTemplateContract.ComputeDefaultsDigest(defaults);
            var version = new ArticleTemplateVersion(
                ArticleTemplateContract.SchemaVersion,
                TemplateId,
                VersionId,
                1,
                42,
                s_now,
                source,
                defaults,
                defaultsDigest,
                string.Empty) with
            {
                ContentDigest = ComputeVersionDigest(TemplateId, VersionId, source, defaults, defaultsDigest)
            };
            Persistence.Versions.Add(version);
            Persistence.Definitions[TemplateId] = Definition;
            Planner = new(
                Persistence,
                new ArticleTemplatePermissionAuthority(),
                References,
                ExpansionAuthority,
                Clock);
            Verifier = new(Planner, Clock);
        }

        internal Guid TemplateId { get; } = Guid.CreateVersion7();
        internal Guid VersionId { get; } = Guid.CreateVersion7();
        internal StubPersistence Persistence { get; } = new();
        internal StubReferenceAuthority References { get; } = new();
        internal StubExpansionAuthority ExpansionAuthority { get; } = new();
        internal MutableTimeProvider Clock { get; } = new(s_now);
        internal ArticleTemplateExpansionPlanner Planner
        {
            get;
        }
        internal ArticleTemplateExpansionVerifier Verifier
        {
            get;
        }

        internal ArticleTemplateDefinition Definition
        {
            get
            {
                var definition = new ArticleTemplateDefinition(
                    ArticleTemplateContract.SchemaVersion,
                    TemplateId,
                    ArticleTemplateContract.PersonalScope(42),
                    "template",
                    "TEMPLATE",
                    null,
                    ArticleTemplateStatus.Active,
                    1,
                    VersionId,
                    1,
                    s_now,
                    s_now,
                    string.Empty);
                return definition with
                {
                    ContentDigest = ArticleTemplateContract.ComputeDefinitionDigest(definition)
                };
            }
        }

        internal ArticleTemplateExpansionInput Input(
            string? title,
            ArticleTemplateActor? actor = null,
            Guid? templateId = null,
            string? timeZone = null,
            string? locale = null,
            DateTimeOffset? businessTime = null)
            => new(
                actor ?? new ArticleTemplateActor(42, [AdminPermissions.ArticleWrite]),
                templateId ?? TemplateId,
                VersionId,
                title,
                businessTime ?? s_businessTime,
                timeZone ?? "Asia/Shanghai",
                locale ?? "zh-cn");

        private static string ComputeVersionDigest(
            Guid templateId,
            Guid versionId,
            ArticleTemplateSource source,
            ArticleTemplateDefaults defaults,
            string defaultsDigest)
        {
            var version = new ArticleTemplateVersion(
                ArticleTemplateContract.SchemaVersion,
                templateId,
                versionId,
                1,
                42,
                s_now,
                source,
                defaults,
                defaultsDigest,
                string.Empty);
            return ArticleTemplateContract.ComputeVersionDigest(version);
        }
    }

    private sealed class MutableTimeProvider(DateTime initial) : TimeProvider
    {
        internal DateTime Value { get; set; } = initial;
        public override DateTimeOffset GetUtcNow() => new(Value);
    }

    private sealed class StubReferenceAuthority : IArticleTemplateReferenceAuthority
    {
        internal bool Reject
        {
            get; set;
        }

        public Task ValidateAsync(
            ArticleTemplateActor actor,
            ArticleTemplateScope scope,
            ArticleTemplateDefaults defaults,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (Reject)
            {
                throw new ArticleTemplateReferenceException("stale_reference");
            }
            return Task.CompletedTask;
        }
    }

    private sealed class StubExpansionAuthority : IArticleTemplateExpansionAuthority
    {
        internal string DisplayName { get; set; } = "Test Author";
        internal Dictionary<Guid, ArticleTemplateAssetPin> AssetPins { get; } = [];

        public Task<string> ResolveActorDisplayNameAsync(
            long adminPrincipalId,
            CancellationToken cancellationToken = default)
            => Task.FromResult(DisplayName);

        public Task<IReadOnlyList<ArticleTemplateAssetPin>> PinAssetsAsync(
            IReadOnlyList<Guid> assetIds,
            CancellationToken cancellationToken = default)
        {
            cancellationToken.ThrowIfCancellationRequested();
            var pins = new List<ArticleTemplateAssetPin>();
            foreach (Guid assetId in assetIds.Distinct())
            {
                if (!AssetPins.TryGetValue(assetId, out ArticleTemplateAssetPin? pin))
                {
                    throw new ArticleTemplateExpansionException("article_template_asset_reference_stale");
                }
                pins.Add(pin);
            }
            return Task.FromResult<IReadOnlyList<ArticleTemplateAssetPin>>(
                Array.AsReadOnly(pins.OrderBy(pin => pin.AssetId).ToArray()));
        }
    }

    private sealed class StubPersistence : IArticleTemplatePersistence
    {
        internal Dictionary<Guid, ArticleTemplateDefinition> Definitions { get; } = [];
        internal List<ArticleTemplateVersion> Versions { get; } = [];

        public Task<ArticleTemplateDefinition?> GetAsync(
            Guid templateId, CancellationToken cancellationToken = default)
            => Task.FromResult(Definitions.GetValueOrDefault(templateId));

        public Task<ArticleTemplatePage> ListAsync(
            ArticleTemplateScope scope,
            ArticleTemplatePageCursor? cursor,
            int limit,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<ArticleTemplateVersion?> GetVersionAsync(
            Guid templateId, Guid versionId, CancellationToken cancellationToken = default)
            => Task.FromResult(Versions.SingleOrDefault(
                item => item.TemplateId == templateId && item.VersionId == versionId));

        public Task<ArticleTemplateVersionPage> ListVersionsAsync(
            Guid templateId, int? afterVersionNumber, int limit, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<ArticleTemplateWriteReceipt> ExecuteAsync(
            ArticleTemplateScope scope,
            long actorAdminPrincipalId,
            Guid requestId,
            string commandDigest,
            Guid templateId,
            Func<ArticleTemplateMutationSnapshot, CancellationToken, Task<ArticleTemplateMutation>> planner,
            CancellationToken cancellationToken = default)
            => throw new NotSupportedException();

        public Task<ArticleTemplateVerificationSnapshot?> ReadVerificationSnapshotAsync(
            Guid templateId, int receiptLimit, CancellationToken cancellationToken = default)
            => throw new NotSupportedException();
    }
}
