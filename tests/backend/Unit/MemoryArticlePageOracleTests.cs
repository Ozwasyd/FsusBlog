using System.Collections.Frozen;
using System.IO.Compression;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Mapping.Models;
using FsusBlog.Core.Mapping.Projectors;
using FsusBlog.Server.Infrastructure.Projections;
using FsusBlog.Server.Infrastructure.PublicReadArtifacts;
using FsusBlog.Server.Models.ReadModels;
using FsusBlog.Shared.Contracts.Outputs;

using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Tests.Unit;

// P01 fixture contribution only: canonical managed projection/serving oracles,
// not workload/performance/platform qualification or an alternative publisher.
public sealed class MemoryArticlePageOracleTests
{
    [Theory]
    [InlineData("summary-x", "snippet-x", "snippet-x")]
    [InlineData("summary-x", null, "summary-x")]
    [InlineData("summary-x", "", "summary-x")]
    [InlineData("summary-x", " \t", "summary-x")]
    [InlineData("旧摘要", "公开摘要 🚀", "公开摘要 🚀")]
    [InlineData(null, "snippet-x", "snippet-x")]
    public void CanonicalProjectionSelectsThePublicSummaryBeforeEncoding(string? summary, string? snippet, string expected)
    {
        ArticleListItemReadModel source = Source(summary, snippet);
        ArticleListItemResponse response = ArticleProjection.ToResponse(source);
        ArticleListCoreModel projected = ArticleProjection.ToCoreListModel(source);
        Assert.Equal(expected, response.Summary);
        Assert.Equal(expected, projected.Summary);
        Assert.Equal(expected, projected.Snippet);
        byte[] payload = Encode(projected);
        Assert.True(PodBinaryCodec.TryDecodeArticlePage(payload, out CorePageResult<ArticleListCoreModel> page));
        ArticleListCoreModel decoded = Assert.Single(page.Items);
        Assert.Equal(response.Summary, decoded.Summary);
        Assert.Null(decoded.Snippet); // The wire has one display-summary slice, no separate snippet.
        Assert.Equal(source.Id, decoded.Id);
        Assert.Equal(source.Title, decoded.Title);
        Assert.Equal(source.Views, decoded.Views);
        Assert.Equal(source.CreateTime, decoded.CreateTime);
        Assert.Equal(source.CategoryId, decoded.Category.Id);
        Assert.Equal(source.CategoryName, decoded.Category.Name);
        Assert.Equal(response.Tags.Select(tag => tag.Id), decoded.Tags.Select(tag => tag.Id));
        Assert.Equal(response.Tags.Select(tag => tag.Name), decoded.Tags.Select(tag => tag.Name));
        Assert.Equal(source.CurrentRevisionId, decoded.CurrentRevisionId);
        Assert.Equal(source.RevisionNo, decoded.RevisionNo);
        Assert.Equal(source.CurrentPublicationId, decoded.CurrentPublicationId);
        Assert.Equal(source.PublicationNo, decoded.PublicationNo);
        Assert.True(PodBinaryCodec.TryDecodePublicArticleListCardProjection(payload, out var cards));
        Assert.Equal(expected, Assert.Single(cards.Items).Summary);
    }

    [Fact]
    public void OriginalBenchmarkSnippetAssertionFailsOnItsContradictoryNonWireFixture()
    {
        var pod = PodProjector.ProjectArticleList(21, 88, DateTime.UnixEpoch.AddHours(2),
            5, "cat-x", "title-x", "summary-x", false, out _);
        var source = new ArticleListCoreModel(pod, 21, "title-x", "summary-x", null, "snippet-x",
            88, DateTime.UnixEpoch.AddHours(2), new ArticleCategoryCoreModel(5, "cat-x"),
            [new TagCoreModel(1, "tag-1"), new TagCoreModel(2, "tag-2")], false);
        byte[] payload = Encode(source);
        Assert.True(PodBinaryCodec.TryDecodeArticlePage(payload, out var page));
        ArticleListCoreModel decoded = Assert.Single(page.Items);
        Assert.Equal("summary-x", decoded.Summary);
        Assert.Null(decoded.Snippet);
        Assert.False(source.Snippet == decoded.Snippet); // Retain the original failing predicate.
        Assert.Equal(payload, Encode(source with
        {
            Snippet = "different-snippet"
        }));
        Assert.False(payload.AsSpan().SequenceEqual(Encode(source with
        {
            Summary = "different-summary"
        })));
        byte[] damaged = payload[..^1];
        Assert.False(PodBinaryCodec.TryDecodeArticlePage(damaged, out _));
    }

    [Theory]
    [InlineData("", "identity")]
    [InlineData("br", "br")]
    [InlineData("gzip", "gzip")]
    public async Task ManagedServingPreservesBytesAndConditionalHeadersForEveryEncoding(string acceptEncoding, string effectiveEncoding)
    {
        ArticleListItemReadModel source = Source("unused-original-summary", new string('s', 4096));
        byte[] payload = Encode(ArticleProjection.ToCoreListModel(source));
        var options = new PublicHotReadOptions { MinPrecompressedFrameBytes = 1 };
        PublicBinaryArtifact artifact = PublicHotReadBinaryArtifactFactory.FromPayload(
            new AedsEncoder(), AedsFrameType.ArticleList, payload, "public,max-age=60", 1, options);
        Assert.False(artifact.BrotliFrame.IsEmpty);
        Assert.False(artifact.GzipFrame.IsEmpty);
        var lists = new Dictionary<PublicListKey, PublicBinaryArtifact>
        {
            [new(PublicListKind.Home, 0, 1, 10)] = artifact
        }.ToFrozenDictionary();
        var store = new PublicHotReadStore();
        store.Publish(new PublicHotReadSnapshot(1, FrozenDictionary<int, PublicBinaryArtifact>.Empty,
            lists, default, default, FrozenDictionary<string, PublicHtmlArtifact>.Empty,
            PublicHotReadPublicationEvidence.CreateVerified(1, DateTimeOffset.UtcNow)));

        DefaultHttpContext get = Context(HttpMethods.Get, acceptEncoding);
        await Serve(get, store, options);
        Assert.Equal(StatusCodes.Status200OK, get.Response.StatusCode);
        Assert.Equal("application/octet-stream", get.Response.ContentType);
        Assert.Equal("2", get.Response.Headers["X-Fsus-Frame-Version"].ToString());
        Assert.Equal(effectiveEncoding, get.Response.Headers["X-Fsus-Frame-Encoding"].ToString());
        byte[] transferred = ((MemoryStream)get.Response.Body).ToArray();
        Assert.Equal(transferred.Length, get.Response.ContentLength);
        Assert.Equal(artifact.Frame.ToArray(), Inflate(transferred, effectiveEncoding));

        DefaultHttpContext head = Context(HttpMethods.Head, acceptEncoding);
        await Serve(head, store, options);
        Assert.Equal(StatusCodes.Status200OK, head.Response.StatusCode);
        Assert.Empty(((MemoryStream)head.Response.Body).ToArray());
        Assert.Equal(get.Response.ContentLength, head.Response.ContentLength);
        foreach (string header in new[] { "ETag", "Content-Type", "Content-Encoding", "Cache-Control", "Vary", "X-Fsus-Frame-Version", "X-Fsus-Frame-Encoding" })
        {
            Assert.Equal(get.Response.Headers[header].ToString(), head.Response.Headers[header].ToString());
        }

        DefaultHttpContext conditional = Context(HttpMethods.Get, acceptEncoding);
        conditional.Request.Headers.IfNoneMatch = get.Response.Headers.ETag;
        await Serve(conditional, store, options);
        Assert.Equal(StatusCodes.Status304NotModified, conditional.Response.StatusCode);
        Assert.Equal(get.Response.Headers.ETag.ToString(), conditional.Response.Headers.ETag.ToString());
        Assert.Empty(((MemoryStream)conditional.Response.Body).ToArray());

        DefaultHttpContext mismatch = Context(HttpMethods.Get, acceptEncoding);
        string otherTag = effectiveEncoding == "identity" ? artifact.BrotliETag : artifact.ETag;
        Assert.NotEqual(get.Response.Headers.ETag.ToString(), otherTag);
        mismatch.Request.Headers.IfNoneMatch = otherTag;
        await Serve(mismatch, store, options);
        Assert.Equal(StatusCodes.Status200OK, mismatch.Response.StatusCode);
        Assert.Equal(transferred, ((MemoryStream)mismatch.Response.Body).ToArray());
    }

    private static ArticleListItemReadModel Source(string? summary, string? snippet)
        => new()
        {
            Id = 21,
            Title = "公开标题",
            Summary = summary,
            Snippet = snippet,
            Views = 88,
            CreateTime = DateTime.UnixEpoch.AddHours(2),
            CategoryId = 5,
            CategoryName = "cat-x",
            Tags = [new() { Id = 1, Name = "tag-1" }, new() { Id = 2, Name = "tag-2" }, new() { Id = 3, Name = "excluded-third-tag" }],
            IsDeleted = false,
            CurrentRevisionId = 101,
            RevisionNo = 2,
            CurrentPublicationId = 202,
            PublicationNo = 1
        };

    private static byte[] Encode(ArticleListCoreModel item)
        => PodBinaryCodec.EncodeArticlePage(new CorePageResult<ArticleListCoreModel>([item], 1));

    private static DefaultHttpContext Context(string method, string encoding)
    {
        var context = new DefaultHttpContext();
        context.Request.Method = method;
        context.Request.Path = "/api/binary/article/list/home/1/10.aeds";
        context.Request.Headers.AcceptEncoding = encoding;
        context.Response.Body = new MemoryStream();
        return context;
    }

    private static Task Serve(DefaultHttpContext context, PublicHotReadStore store, PublicHotReadOptions options)
        => PublicHotReadFastPath.TryServeAsync(context,
            _ => throw new InvalidOperationException("A published fixture hit must not enter fallback."),
            store, options, new PublicHotReadCounters());

    private static byte[] Inflate(byte[] transferred, string encoding)
    {
        if (encoding == "identity")
        {
            return transferred;
        }
        using var input = new MemoryStream(transferred);
        using Stream decoder = encoding == "br"
            ? new BrotliStream(input, CompressionMode.Decompress)
            : new GZipStream(input, CompressionMode.Decompress);
        using var output = new MemoryStream();
        decoder.CopyTo(output);
        return output.ToArray();
    }
}
