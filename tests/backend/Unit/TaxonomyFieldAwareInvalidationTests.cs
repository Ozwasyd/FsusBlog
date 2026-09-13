using FsusBlog.Core.Cache;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Taxonomy;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TaxonomyFieldAwareInvalidationTests
{
    [Fact]
    public void Classify_NoOp_WhenNormalizedNameAndDescriptionAreUnchanged()
    {
        BinaryEndpoints.TaxonomyFieldChange category = BinaryEndpoints.ClassifyTaxonomyFieldChange(
            "  Tech  ",
            "  notes  ",
            "Tech",
            "notes",
            preserveDescription: false,
            treatNameAsTag: false);
        BinaryEndpoints.TaxonomyFieldChange tag = BinaryEndpoints.ClassifyTaxonomyFieldChange(
            " CSharp ",
            "\tcache locality\n",
            PublicTagUrlIdentity.NormalizeDisplayName(" CSharp "),
            "cache locality",
            preserveDescription: false,
            treatNameAsTag: true);

        Assert.False(category.NameChanged);
        Assert.False(category.DescriptionChanged);
        Assert.True(category.IsNoOp);
        Assert.False(tag.NameChanged);
        Assert.False(tag.DescriptionChanged);
        Assert.True(tag.IsNoOp);
    }

    [Fact]
    public void Classify_LegacyPayload_DoesNotTreatMissingDescriptionAsChange()
    {
        BinaryEndpoints.TaxonomyFieldChange change = BinaryEndpoints.ClassifyTaxonomyFieldChange(
            "Tech",
            "kept",
            "Tech",
            incomingDescription: null,
            preserveDescription: true,
            treatNameAsTag: false);

        Assert.True(change.IsNoOp);
        Assert.False(change.DescriptionChanged);
    }

    [Fact]
    public void Classify_DescriptionOnly_AndRenameWithDescription()
    {
        BinaryEndpoints.TaxonomyFieldChange descriptionOnly = BinaryEndpoints.ClassifyTaxonomyFieldChange(
            "Tech",
            "old",
            "Tech",
            "new",
            preserveDescription: false,
            treatNameAsTag: false);
        BinaryEndpoints.TaxonomyFieldChange rename = BinaryEndpoints.ClassifyTaxonomyFieldChange(
            "Tech",
            "old",
            "Backend",
            "new",
            preserveDescription: false,
            treatNameAsTag: false);

        Assert.True(descriptionOnly.IsDescriptionOnly);
        Assert.False(descriptionOnly.NameChanged);
        Assert.True(rename.NameChanged);
        Assert.True(rename.DescriptionChanged);
        Assert.False(rename.IsDescriptionOnly);
    }

    [Fact]
    public async Task Dispatch_NoOp_PerformsNoDownstreamWork()
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(BinaryEndpoints.TaxonomyUpdateOutcome.NoOp, false, false),
            7,
            isCategory: true,
            cache,
            dispatcher,
            publicAot,
            "taxonomy-category-updated",
            CancellationToken.None);

        await cache.DidNotReceive().RemoveAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await dispatcher.DidNotReceive().InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
        await dispatcher.DidNotReceive().InvalidateTaxonomyMetadataAsync(
            Arg.Any<string>(),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Dispatch_DescriptionOnlyCategory_InvalidatesExactMetadataAndSitemapGeneration()
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(BinaryEndpoints.TaxonomyUpdateOutcome.Updated, false, true),
            7,
            isCategory: true,
            cache,
            dispatcher,
            publicAot,
            "taxonomy-category-updated",
            CancellationToken.None);

        await cache.Received(1).RemoveAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            TaxonomyExactMetadataCache.ForCategory(7),
            Arg.Any<CancellationToken>());
        await dispatcher.DidNotReceive().InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
        await publicAot.Received(1).InvalidateFilterRouteFamilyAsync(
            PublicRouteIdentity.BuildCategoryRouteKey(7),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await dispatcher.Received(1).InvalidateTaxonomyMetadataAsync(
            PublicRouteIdentity.BuildCategoryRouteKey(7),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Dispatch_DescriptionOnlyTag_InvalidatesExactMetadataAndSitemapGeneration()
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(BinaryEndpoints.TaxonomyUpdateOutcome.Updated, false, true),
            11,
            isCategory: false,
            cache,
            dispatcher,
            publicAot,
            "taxonomy-tag-updated",
            CancellationToken.None);

        await cache.Received(1).RemoveAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            TaxonomyExactMetadataCache.ForTag(11),
            Arg.Any<CancellationToken>());
        await dispatcher.DidNotReceive().InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
        await publicAot.Received(1).InvalidateFilterRouteFamilyAsync(
            PublicRouteIdentity.BuildTagIdRouteKey(11),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
        await dispatcher.Received(1).InvalidateTaxonomyMetadataAsync(
            PublicRouteIdentity.BuildTagIdRouteKey(11),
            Arg.Any<string>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    public async Task Dispatch_NameAndDescription_FollowsRenameInvalidationPath()
    {
        ICacheInvalidationStore cache = Substitute.For<ICacheInvalidationStore>();
        ICacheInvalidationDispatcher dispatcher = Substitute.For<ICacheInvalidationDispatcher>();
        IPublicAotInvalidationService publicAot = Substitute.For<IPublicAotInvalidationService>();

        await BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync(
            new BinaryEndpoints.TaxonomyUpdateApplyResult(BinaryEndpoints.TaxonomyUpdateOutcome.Updated, true, true),
            7,
            isCategory: true,
            cache,
            dispatcher,
            publicAot,
            "taxonomy-category-updated",
            CancellationToken.None);

        await cache.Received(1).RemoveAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            TaxonomyExactMetadataCache.ForCategory(7),
            Arg.Any<CancellationToken>());
        await dispatcher.Received(1).InvalidateCategoryTagAsync(Arg.Any<CancellationToken>());
    }

    [Fact]
    public void UpdateHelpers_ClassifyBeforeOutbox_AndSkipAliasesUntilNameChanges()
    {
        string category = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.UpdateCategoryAndEnqueueProjectionAsync));
        string tag = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.UpdateTagAndEnqueueProjectionAsync));
        string dispatch = RuntimeMetadataInspection.DescribeMethods(
            typeof(BinaryEndpoints),
            nameof(BinaryEndpoints.DispatchTaxonomyUpdateSideEffectsAsync));

        Assert.Contains("ClassifyTaxonomyFieldChange", category, StringComparison.Ordinal);
        Assert.Contains("get_NameChanged", category, StringComparison.Ordinal);
        Assert.Contains("InsertTaxonomyProjectionOutboxAsync", category, StringComparison.Ordinal);
        Assert.Contains("ClassifyTaxonomyFieldChange", tag, StringComparison.Ordinal);
        Assert.Contains("get_NameChanged", tag, StringComparison.Ordinal);
        Assert.Contains("InsertTaxonomyProjectionOutboxAsync", tag, StringComparison.Ordinal);
        Assert.Contains("TagUrlAlias", tag, StringComparison.Ordinal);
        Assert.Contains("InvalidateCategoryTagAsync", dispatch, StringComparison.Ordinal);
        Assert.Contains("InvalidateTaxonomyMetadataAsync", dispatch, StringComparison.Ordinal);
        Assert.Contains("ForCategory", dispatch, StringComparison.Ordinal);
        Assert.Contains("ForTag", dispatch, StringComparison.Ordinal);
        Assert.Contains("RemoveAsync", dispatch, StringComparison.Ordinal);
    }
}
