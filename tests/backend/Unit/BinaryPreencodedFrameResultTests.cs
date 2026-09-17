using System.Security.Cryptography;

using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Infrastructure.Results;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

public sealed class BinaryPreencodedFrameResultTests
{
    private const string ETag = "\"frame-etag\"";

    [Theory]
    [InlineData(ETag)]
    [InlineData("\"other\", \"frame-etag\"")]
    [InlineData("W/\"frame-etag\"")]
    [InlineData("*")]
    public async Task MatchingIfNoneMatch_Returns304WithoutBody(string ifNoneMatch)
    {
        byte[] frame = CreateFrame([1, 2, 3]);
        DefaultHttpContext context = CreateContext(ifNoneMatch);
        var result = new BinaryPreencodedFrameResult(
            frame,
            metadata: new BinaryFrameResponseMetadata(ETag: ETag));

        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status304NotModified, context.Response.StatusCode);
        Assert.Equal(0, context.Response.ContentLength);
        Assert.Equal(ETag, context.Response.Headers.ETag);
        Assert.Empty(ReadBody(context));
    }

    [Theory]
    [InlineData("\"other\"")]
    [InlineData("\"frame-etagged\"")]
    public async Task NonMatchingIfNoneMatch_Returns200WithFullFrame(string ifNoneMatch)
    {
        byte[] frame = CreateFrame([4, 5, 6]);
        DefaultHttpContext context = CreateContext(ifNoneMatch);
        var result = new BinaryPreencodedFrameResult(
            frame,
            metadata: new BinaryFrameResponseMetadata(ETag: ETag));

        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(frame.Length, context.Response.ContentLength);
        Assert.Equal(frame, ReadBody(context));
    }

    [Fact]
    public async Task Metadata_AppliesStrongEtagTieredCacheControlAndEncodingVary()
    {
        const string CacheControl = "public,max-age=60,s-maxage=300";
        byte[] frame = CreateFrame([7, 8, 9]);
        DefaultHttpContext context = CreateContext();
        var result = new BinaryPreencodedFrameResult(
            frame,
            metadata: new BinaryFrameResponseMetadata(
                ETag: ETag,
                CacheControl: CacheControl,
                ContentEncoding: "br",
                VaryAcceptEncoding: true));

        await result.ExecuteAsync(context);

        Assert.Equal(StatusCodes.Status200OK, context.Response.StatusCode);
        Assert.Equal(ETag, context.Response.Headers.ETag);
        Assert.Equal(CacheControl, context.Response.Headers.CacheControl);
        Assert.Equal("br", context.Response.Headers.ContentEncoding);
        Assert.Equal("Accept-Encoding", context.Response.Headers.Vary);
        Assert.Equal("none", context.Response.Headers.AcceptRanges);
        Assert.Equal(frame, ReadBody(context));
    }

    [Fact]
    public async Task Metadata_WithoutEncodingVariationDoesNotInventVaryHeader()
    {
        byte[] frame = CreateFrame([10, 11, 12]);
        DefaultHttpContext context = CreateContext();
        var result = new BinaryPreencodedFrameResult(
            frame,
            metadata: new BinaryFrameResponseMetadata(
                ETag: ETag,
                CacheControl: "public,max-age=0,must-revalidate",
                VaryAcceptEncoding: false));

        await result.ExecuteAsync(context);

        Assert.Equal(0, context.Response.Headers.Vary.Count);
        Assert.Equal(frame, ReadBody(context));
    }

    private static byte[] CreateFrame(byte[] payload)
        => new AedsEncoder().Encode(AedsFrameType.ArticleDetail, payload);

    private static DefaultHttpContext CreateContext(string? ifNoneMatch = null)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = HttpMethods.Get;
        if (ifNoneMatch is not null)
        {
            context.Request.Headers.IfNoneMatch = ifNoneMatch;
        }

        context.Response.Body = new MemoryStream();
        return context;
    }

    private static byte[] ReadBody(DefaultHttpContext context)
        => ((MemoryStream)context.Response.Body).ToArray();
}

public sealed class PublicHotReadBinaryArtifactEtagTests
{
    [Fact]
    public void ContentEtag_IsStrongStableAndChangesWithFrameBytes()
    {
        byte[] payload = [1, 2, 3];
        var encoder = new AedsEncoder();
        var options = new PublicHotReadOptions
        {
            EnablePrecompressedBinaryVariants = false
        };

        PublicBinaryArtifact first = PublicHotReadBinaryArtifactFactory.FromPayload(
            encoder,
            AedsFrameType.ArticleDetail,
            payload,
            "public,max-age=60",
            1,
            options);
        PublicBinaryArtifact same = PublicHotReadBinaryArtifactFactory.FromPayload(
            encoder,
            AedsFrameType.ArticleDetail,
            payload,
            "public,max-age=60",
            2,
            options);
        PublicBinaryArtifact changed = PublicHotReadBinaryArtifactFactory.FromPayload(
            encoder,
            AedsFrameType.ArticleDetail,
            [1, 2, 4],
            "public,max-age=60",
            3,
            options);

        byte[] frame = encoder.Encode(AedsFrameType.ArticleDetail, payload);
        byte[] hash = SHA256.HashData(frame);
        string expected = string.Concat("\"", Convert.ToHexStringLower(hash.AsSpan(0, 8)), "\"");

        Assert.Equal(expected, first.ETag);
        Assert.Equal(first.ETag, same.ETag);
        Assert.NotEqual(first.ETag, changed.ETag);
        Assert.False(first.ETag.StartsWith("W/", StringComparison.Ordinal));
    }
}
