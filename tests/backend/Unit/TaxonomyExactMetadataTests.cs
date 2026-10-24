using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;

using NSubstitute;

namespace FsusBlog.Server.Tests.Unit;

public sealed class TaxonomyExactMetadataTests
{
    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void Codec_RoundTrip_PreservesIdNameAndDescription()
    {
        TaxonomyExactMetadataCoreModel original = new(7, "技术", "描述 😀");

        byte[] encoded = PodBinaryCodec.EncodeTaxonomyExactMetadata(original);
        bool ok = PodBinaryCodec.TryDecodeTaxonomyExactMetadata(encoded, out TaxonomyExactMetadataCoreModel decoded);

        Assert.True(ok);
        Assert.Equal(original, decoded);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void Codec_RoundTrip_MapsEmptyDescriptionToNull()
    {
        TaxonomyExactMetadataCoreModel original = new(3, "Life", null);

        byte[] encoded = PodBinaryCodec.EncodeTaxonomyExactMetadata(original);
        bool ok = PodBinaryCodec.TryDecodeTaxonomyExactMetadata(encoded, out TaxonomyExactMetadataCoreModel decoded);

        Assert.True(ok);
        Assert.Equal(3, decoded.Id);
        Assert.Equal("Life", decoded.Name);
        Assert.Null(decoded.Description);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "taxonomy-pod-no-trailing-bytes")]
    public void Codec_RejectsTrailingBytes()
    {
        byte[] encoded = PodBinaryCodec.EncodeTaxonomyExactMetadata(new TaxonomyExactMetadataCoreModel(1, "Tech", "desc"));
        byte[] trailing = [.. encoded, 0];

        Assert.False(PodBinaryCodec.TryDecodeTaxonomyExactMetadata(trailing, out _));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void CategoryListCodec_DoesNotCarryDescription()
    {
        List<CategoryListItemResponse> items =
        [
            new() { Id = 1, Name = "Tech", ArticleCount = 2 }
        ];

        byte[] encoded = PodBinaryCodec.EncodeCategoryList(items);
        Assert.True(PodBinaryCodec.TryDecodeCategoryList(encoded, out List<CategoryListItemResponse> decoded));
        Assert.Single(decoded);
        Assert.Equal(1, decoded[0].Id);
        Assert.Equal("Tech", decoded[0].Name);
        Assert.Equal(2, decoded[0].ArticleCount);
        Assert.Null(decoded[0].GetType().GetProperty("Description"));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void MatchCanonicalTagId_ResolvesDisplayNameAndAliasToSameId()
    {
        (int Id, string Name)[] tags = [(11, "CSharp")];
        (string NormalizedName, int TagId)[] aliases = [("C#", 11)];

        Assert.Equal(11, PublicTagUrlIdentity.MatchCanonicalTagId(tags, aliases, " csharp "));
        Assert.Equal(11, PublicTagUrlIdentity.MatchCanonicalTagId(tags, aliases, "C#"));
        Assert.Equal(
            TaxonomyExactMetadataCache.ForTag(11),
            TaxonomyExactMetadataCache.ForTag(PublicTagUrlIdentity.MatchCanonicalTagId(tags, aliases, "C#")!.Value));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "taxonomy-canonical-tag-identity-unambiguous")]
    public void MatchCanonicalTagId_ReturnsNullForMissingOrAmbiguousNames()
    {
        (int Id, string Name)[] tags = [(1, "Alpha"), (2, "alpha")];
        Assert.Null(PublicTagUrlIdentity.MatchCanonicalTagId(tags, [], "alpha"));
        Assert.Null(PublicTagUrlIdentity.MatchCanonicalTagId([(1, "Alpha")], [("BETA", 9)], "missing"));
        Assert.Null(PublicTagUrlIdentity.MatchCanonicalTagId([], [], " "));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void CacheIdentities_AreKeyedByKindAndCanonicalId()
    {
        Assert.Equal("category:7", TaxonomyExactMetadataCache.ForCategory(7));
        Assert.Equal("tag:11", TaxonomyExactMetadataCache.ForTag(11));
        Assert.NotEqual(TaxonomyExactMetadataCache.ForCategory(11), TaxonomyExactMetadataCache.ForTag(11));
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "taxonomy-invalid-exact-identity-no-cache")]
    public async Task ExactRead_NonPositiveId_ReturnsBinaryNotFoundWithoutCache()
    {
        IOwnedFrameCache cache = Substitute.For<IOwnedFrameCache>();
        IAedsEncoder aeds = new AedsEncoder();

        IResult missingCategory = await BinaryEndpoints.ReadCategoryExactMetadataAsync(
            0,
            Substitute.For<SqlSugar.ISqlSugarClient>(),
            cache,
            aeds);
        IResult missingTag = await BinaryEndpoints.ReadTagExactMetadataAsync(
            -1,
            Substitute.For<SqlSugar.ISqlSugarClient>(),
            cache,
            aeds);
        IResult missingName = await BinaryEndpoints.ReadTagExactMetadataByNameAsync(
            "  ",
            Substitute.For<SqlSugar.ISqlSugarClient>(),
            cache,
            aeds);

        Assert.IsType<BinaryFrameResult>(missingCategory);
        Assert.IsType<BinaryFrameResult>(missingTag);
        Assert.IsType<BinaryFrameResult>(missingName);
        await cache.DidNotReceive().TryGetOwnedFrameAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<AedsFrameType>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task ExactRead_CacheMissStoresDedicatedFrameByCanonicalIdentity()
    {
        IOwnedFrameCache cache = Substitute.For<IOwnedFrameCache>();
        cache.TryGetOwnedFrameAsync(
                CachePolicyId.TaxonomyExactMetadataFrame,
                "tag:11",
                AedsFrameType.TaxonomyExactMetadata,
                Arg.Any<CancellationToken>())
            .Returns(new OwnedFrameCacheReadResult(false, null));

        IResult result = await BinaryEndpoints.ReadTaxonomyExactMetadataAsync(
            TaxonomyExactMetadataCache.ForTag(11),
            () => Task.FromResult<TaxonomyExactMetadataCoreModel?>(new TaxonomyExactMetadataCoreModel(11, "CSharp", "alias-canonical")),
            cache,
            new AedsEncoder(),
            "标签不存在");

        Assert.IsType<BinaryPreencodedFrameResult>(result);
        await cache.Received(1).SetOwnedFrameAsync(
            CachePolicyId.TaxonomyExactMetadataFrame,
            "tag:11",
            Arg.Any<OwnedAedsFrame>(),
            TimeSpan.FromMinutes(10),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative, InvariantId = "taxonomy-missing-entity-notfound-no-cache")]
    public async Task ExactRead_MissingEntity_ReturnsNotFoundAndDoesNotCache()
    {
        IOwnedFrameCache cache = Substitute.For<IOwnedFrameCache>();
        cache.TryGetOwnedFrameAsync(
                CachePolicyId.TaxonomyExactMetadataFrame,
                "category:9",
                AedsFrameType.TaxonomyExactMetadata,
                Arg.Any<CancellationToken>())
            .Returns(new OwnedFrameCacheReadResult(false, null));

        IResult result = await BinaryEndpoints.ReadTaxonomyExactMetadataAsync(
            TaxonomyExactMetadataCache.ForCategory(9),
            () => Task.FromResult<TaxonomyExactMetadataCoreModel?>(null),
            cache,
            new AedsEncoder(),
            "分类不存在");

        Assert.IsType<BinaryFrameResult>(result);
        using var responseBody = new MemoryStream();
        var context = new DefaultHttpContext();
        context.Response.Body = responseBody;
        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status404NotFound, context.Response.StatusCode);
        var decoded = new AedsEncoder().TryDecode(responseBody.ToArray());
        Assert.True(decoded.IsSuccess, decoded.Error.Message);
        Assert.Equal(AedsFrameType.ApiError, decoded.Value.FrameType);
        Assert.True(PodBinaryCodec.TryDecodeApiError(decoded.Value.Payload, out var errorPod));
        var error = PodBinaryCodec.ToErrorDetail(errorPod);
        Assert.Equal(ErrorCode.NotFound, error.Code);
        Assert.Equal("分类不存在", error.Message);
        await cache.DidNotReceive().SetOwnedFrameAsync(
            Arg.Any<CachePolicyId>(),
            Arg.Any<string>(),
            Arg.Any<OwnedAedsFrame>(),
            Arg.Any<TimeSpan?>(),
            Arg.Any<CancellationToken>());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void ExactMetadataPolicy_IsIndependentOfListFrames()
    {
        var registry = new CachePolicyRegistry();
        Assert.True(registry.TryGet(CachePolicyId.TaxonomyExactMetadataFrame, out CachePolicy exact));
        Assert.True(registry.TryGet(CachePolicyId.CategoryFrame, out CachePolicy category));
        Assert.True(registry.TryGet(CachePolicyId.TagFrame, out CachePolicy tag));
        Assert.Equal("taxonomy-exact-metadata-frame", exact.Resource);
        Assert.NotEqual(category.Resource, exact.Resource);
        Assert.NotEqual(tag.Resource, exact.Resource);
        Assert.Null(exact.InvalidationTags);
        Assert.True(exact.RegisterKeysForPrefixInvalidation);
        Assert.True(AedsFrameSensitivity.IsPublicImmutable(AedsFrameType.TaxonomyExactMetadata));
    }

    [Theory]
    [InlineData("/api/binary/category/7.aeds")]
    [InlineData("/api/binary/tag/11.aeds")]
    [InlineData("/api/binary/tag/by-name.aeds")]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void ExactRoutes_AreNotPublicHotReadL0(string path)
    {
        Assert.False(PublicHotReadFastPath.TryClassifyRouteForTests(path, out _));
    }
}
