using System.Text;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

[Trait("Category", "Unit")]
public sealed class ArticleTemplatePlanImmutabilityTests
{
    private static readonly DateTime s_now = new(2026, 10, 8, 12, 0, 0, DateTimeKind.Utc);

    [Fact]
    public void Plan_DetachesInputAndReturnedSourceBytes()
    {
        byte[] source = Encoding.UTF8.GetBytes("﻿# source  \r\n");
        byte[] expected = [.. source];
        ArticleTemplateExpansionPlan plan = CreatePlan(source);
        string digest = plan.ContentDigest;

        source[0] ^= 1;
        byte[] returned = plan.ExpandedSource;
        returned[0] ^= 1;

        Assert.Equal(expected, plan.ExpandedSource);
        Assert.NotSame(returned, plan.ExpandedSource);
        Assert.Equal(digest, ArticleTemplateContract.ComputeExpansionPlanDigest(plan));
        Assert.Equal(ArticleTemplateExpansionPlanner.ComputeSha256(expected), plan.ExpandedSourceDigest);
    }

    [Fact]
    public void Dependencies_DetachAllCallerOwnedCollections()
    {
        int[] tags = [11];
        var pin = new ArticleTemplateAssetPin(Guid.CreateVersion7(), "active", "public", new string('a', 64), s_now);
        ArticleTemplateAssetPin[] assets = [pin];
        var property = new ArticleTemplatePropertyDefault(Guid.CreateVersion7(), ArticleTemplatePropertyValueKind.Text, "safe");
        ArticleTemplatePropertyDefault[] properties = [property];
        var value = new ArticlePropertyValueEntry(property.DefinitionId, 1, new string('b', 64),
            ArticlePropertyValuePresence.Present, new ArticlePropertyTextValue("safe"), new string('c', 64));
        var propertyPin = new ArticleTemplatePropertyPin(ArticlePropertyDefinitionOwner.User(42, "synthetic-site"),
            property.DefinitionId, 1, value.DefinitionDigest, ArticlePropertyValueType.Text, ArticlePropertyCardinality.Single,
            ArticlePropertyDefinitionStatus.Active, new string('d', 64), new string('e', 64), new string('f', 64), value);
        ArticleTemplatePropertyPin[] propertyPins = [propertyPin];
        var dependencies = new ArticleTemplateExpansionDependencies(null, tags, assets, properties, null, null, null, propertyPins);
        ArticleTemplateExpansionPlan plan = CreatePlan([], dependencies);
        string digest = plan.ContentDigest;

        tags[0] = 99;
        assets[0] = pin with
        {
            State = "retired"
        };
        properties[0] = new ArticleTemplatePropertyDefault(Guid.CreateVersion7(), ArticleTemplatePropertyValueKind.Text, "changed");
        propertyPins[0] = propertyPin with
        {
            SchemaRevision = 2
        };

        Assert.Equal(11, Assert.Single(plan.Dependencies.TagIds));
        Assert.Equal(pin, Assert.Single(plan.Dependencies.AssetPins));
        Assert.Same(property, Assert.Single(plan.Dependencies.PropertyDefaults));
        Assert.Same(propertyPin, Assert.Single(plan.Dependencies.PropertyPins));
        Assert.Throws<NotSupportedException>(() => ((IList<int>)dependencies.TagIds)[0] = 99);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleTemplateAssetPin>)dependencies.AssetPins)[0] = pin);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleTemplatePropertyDefault>)dependencies.PropertyDefaults)[0] = property);
        Assert.Throws<NotSupportedException>(() => ((IList<ArticleTemplatePropertyPin>)dependencies.PropertyPins)[0] = propertyPin);
        Assert.Equal(digest, ArticleTemplateContract.ComputeExpansionPlanDigest(plan));
    }

    [Fact]
    public void Actor_DetachesPermissionsAndExposesNoMutableAuthority()
    {
        var permissions = new HashSet<string> { AdminPermissions.ArticleWrite };
        var actor = new ArticleTemplateActor(42, permissions);
        permissions.Clear();

        Assert.Contains(AdminPermissions.ArticleWrite, actor.Permissions);
        if (actor.Permissions is ICollection<string> mutable)
        {
            Assert.Throws<NotSupportedException>(() => mutable.Clear());
        }
        Assert.Contains(AdminPermissions.ArticleWrite, actor.Permissions);
    }

    [Fact]
    public void Dependencies_RejectOverBudgetBeforeCopying()
    {
        Assert.Throws<ArticleTemplateBudgetExceededException>(() => new ArticleTemplateExpansionDependencies(
            null, new int[ArticleTemplateContract.MaxTags + 1], [], [], null, null, null));
        Assert.Throws<ArticleTemplateBudgetExceededException>(() => new ArticleTemplateExpansionDependencies(
            null, [], new ArticleTemplateAssetPin[ArticleTemplateContract.MaxAssets + 1], [], null, null, null));
        Assert.Throws<ArticleTemplateBudgetExceededException>(() => new ArticleTemplateExpansionDependencies(
            null, [], [], new ArticleTemplatePropertyDefault[ArticleTemplateContract.MaxPropertyDefaults + 1], null, null, null));
        Assert.Throws<ArticleTemplateBudgetExceededException>(() => new ArticleTemplateExpansionDependencies(
            null, [], [], [], null, null, null, new ArticleTemplatePropertyPin[ArticleTemplateContract.MaxPropertyDefaults + 1]));
    }

    [Fact]
    public async Task Verifier_RejectsFutureIssuanceWithoutReplanning()
    {
        IArticleTemplateExpansionPlanner planner = Substitute.For<IArticleTemplateExpansionPlanner>();
        var verifier = new ArticleTemplateExpansionVerifier(planner, new FixedClock(s_now));
        ArticleTemplateExpansionPlan plan = CreatePlan([], issuedAtUtc: s_now.AddMinutes(1));

        ArticleTemplateVerificationResult result = await verifier.VerifyAsync(plan);

        Assert.False(result.Valid);
        Assert.Contains(result.Violations, violation => violation.Code == "expansion_plan_issuance_future");
        Assert.Empty(planner.ReceivedCalls());
    }

    [Fact]
    public async Task Verifier_RejectsExpiredAndAlteredTtlWithoutReplanning()
    {
        IArticleTemplateExpansionPlanner planner = Substitute.For<IArticleTemplateExpansionPlanner>();
        var verifier = new ArticleTemplateExpansionVerifier(planner, new FixedClock(s_now));
        ArticleTemplateExpansionPlan expired = CreatePlan([], issuedAtUtc: s_now.AddMinutes(-15));
        ArticleTemplateExpansionPlan altered = CreatePlan([], expiresAtUtc: s_now.AddHours(1));

        ArticleTemplateVerificationResult expiredResult = await verifier.VerifyAsync(expired);
        ArticleTemplateVerificationResult alteredResult = await verifier.VerifyAsync(altered);

        Assert.Contains(expiredResult.Violations, violation => violation.Code == "expansion_plan_expired");
        Assert.Contains(alteredResult.Violations, violation => violation.Code == "expansion_plan_expiry_tamper");
        Assert.Empty(planner.ReceivedCalls());
    }

    private static ArticleTemplateExpansionPlan CreatePlan(
        byte[] source,
        ArticleTemplateExpansionDependencies? dependencies = null,
        DateTime? issuedAtUtc = null,
        DateTime? expiresAtUtc = null)
    {
        var input = new ArticleTemplateExpansionInput(
            new ArticleTemplateActor(42, [AdminPermissions.ArticleWrite]),
            Guid.CreateVersion7(), Guid.CreateVersion7(), null, new DateTimeOffset(s_now), "UTC", "zh-CN");
        var defaults = new ArticleTemplateDefaults();
        DateTime issued = issuedAtUtc ?? s_now;
        return new ArticleTemplateExpansionPlan(
            input, input.VersionId, 1, 1, ArticleTemplateContract.PersonalScope(42), source,
            ArticleTemplateExpansionPlanner.ComputeSha256(source), defaults,
            ArticleTemplateContract.ComputeDefaultsDigest(defaults),
            dependencies ?? new ArticleTemplateExpansionDependencies(null, [], [], [], null, null, null),
            [], issued, expiresAtUtc ?? issued.AddMinutes(15));
    }

    private sealed class FixedClock(DateTime now) : TimeProvider
    {
        public override DateTimeOffset GetUtcNow() => new(now);
    }
}
