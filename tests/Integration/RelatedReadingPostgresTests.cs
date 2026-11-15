using System.Buffers.Binary;
using System.Net;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;

namespace FsusBlog.V2.Integration.Tests;

public sealed class RelatedReadingPostgresTests
{
    private static readonly DateTimeOffset Epoch = DateTimeOffset.UnixEpoch.AddDays(100);

    [Fact]
    public void ProjectionRanksTheRecentCandidateWindowAndReusesEncodedFrames()
    {
        var source = At(1, 125, "owl habitat", 3, [7, 8]);
        var lateSimilar = At(2, 124, "owl habitat report", 3, [7, 8]);
        var newer = At(3, 126, "owl habitat latest", 0, []);
        var sameCategory = At(4, 127, "green leaf", 3, []);
        var sameTag = At(5, 130, "owl habitat trail", 9, [7, 8]);
        var tiedOlder = At(6, 124, "owl habitat report", 3, [7, 8]);
        var outsideWindow = At(7, 1, "owl habitat report", 3, [7, 8]);
        var fillers = Enumerable.Range(20, 119).Select(id => At(id, 2 + id / 20, $"filler {id}", 3, [])).ToArray();
        var rows = new[] { source, lateSimilar, newer, sameCategory, sameTag, tiedOlder, outsideWindow }.Concat(fillers).ToArray();
        var projection = new RelatedReadingProjection(rows, CancellationToken.None);
        var frame = Assert.IsType<byte[]>(projection.Read(source.Id, CancellationToken.None));
        Assert.Same(frame, projection.Read(source.Id, CancellationToken.None));
        var actual = View(frame);
        Assert.Equal(new[] { tiedOlder.Id, lateSimilar.Id, sameCategory.Id, sameTag.Id }, actual.Related[..4]);
        Assert.Equal(tiedOlder.Id, actual.Previous);
        Assert.Equal(newer.Id, actual.Next);
        Assert.DoesNotContain(outsideWindow.Id, actual.Related);
        Assert.DoesNotContain(newer.Id, actual.Related);
        Assert.Contains("同分类 / 共同标签 / 全文关键词 / 发布时间接近", Encoding.UTF8.GetString(frame));
        Assert.Null(projection.Read(999, CancellationToken.None));
        using var cancelled = new CancellationTokenSource();
        cancelled.Cancel();
        Assert.Throws<OperationCanceledException>(() => projection.Read(source.Id, cancelled.Token));
    }

    [PostgresFact]
    public async Task EmptyMissingPrivateAndWithdrawnSourcesHaveDistinctAdmittedResponses()
    {
        using var deadline = new CancellationTokenSource(TimeSpan.FromSeconds(45));
        var ct = deadline.Token;
        await using var database = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using var connection = await database.DataSource.OpenConnectionAsync(ct);
        var (user, token, _) = await database.SignIn("related-author", ct, minutes: 1);
        await using var server = await ServerProcess.Start(database.ConnectionString, ct);

        var article = await Command(WireRoutes.Save, 0, 0, "Published source", "Visible body");
        var privateArticle = await Command(WireRoutes.Save, 0, 0, "Private marker", "DRAFT_ONLY");
        var source = await Command(WireRoutes.Publish, article.Id, article.Revision);
        var empty = await Read(source.Id);
        Assert.Equal(HttpStatusCode.OK, empty.Status);
        var blank = View(empty.Bytes);
        Assert.Empty(blank.Related);
        Assert.Null(blank.Previous);
        Assert.Null(blank.Next);

        var hidden = await Read(privateArticle.Id);
        var missing = await Read(2000000000);
        Assert.Equal(HttpStatusCode.NotFound, hidden.Status);
        Assert.Equal(hidden.Status, missing.Status);
        Assert.Equal(FrameType.ApiError, Type(hidden.Bytes));
        Assert.Equal(FrameType.ApiError, Type(missing.Bytes));
        Assert.DoesNotContain("Private marker", Encoding.UTF8.GetString(hidden.Bytes));

        var navigation = await Command(WireRoutes.Publish, privateArticle.Id, privateArticle.Revision);
        var next = await Read(source.Id);
        Assert.NotEqual(empty.Generation, next.Generation);
        Assert.Equal(navigation.Id, View(next.Bytes).Next);
        Assert.Equal(source.Id, View((await Read(navigation.Id)).Bytes).Previous);
        Assert.Empty(View(next.Bytes).Related);
        Assert.Equal(HttpStatusCode.Conflict, (await Read(source.Id, "9223372036854775807")).Status);

        _ = await Command(WireRoutes.Retract, navigation.Id, navigation.Revision);
        var after = await Read(source.Id);
        Assert.Equal(empty.Generation, after.Generation); // The visible coordinate set came back to the first state.
        Assert.Equal(empty.Bytes, after.Bytes);
        Assert.Equal(HttpStatusCode.NotFound, (await Read(navigation.Id)).Status);
        _ = await Command(WireRoutes.Retract, source.Id, source.Revision);
        Assert.Equal(HttpStatusCode.NotFound, (await Read(source.Id)).Status);

        async Task<(HttpStatusCode Status, byte[] Bytes, string Generation)> Read(int id, string? publication = null)
        {
            var path = WireRoutes.PublicRelatedReading.Replace("{articleId:int}", id.ToString());
            using var response = await server.Client.GetAsync(publication is null ? path : path + "?publication=" + publication, ct);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return (response.StatusCode, await response.Content.ReadAsByteArrayAsync(ct),
                Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        }

        async Task<Draft> Command(string path, int id, long revision, string title = "", string body = "")
        {
            var command = new ArticleCommand(id, revision, Guid.NewGuid(), title, body);
            using var request = SiteAedsFixture.Request(HttpMethod.Post, path, Wire.EncodeArticleCommand(command),
                token, handle: null);
            using var response = await server.Client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
        }
    }

    private static FrameType Type(byte[] frame)
    {
        _ = Aeds.Decode(frame, out var type);
        return type;
    }

    private static Article At(int id, int day, string title, int category, int[] tags) =>
        new(id, id, id, 1, 1, title, "", Epoch.AddDays(day), Epoch.AddDays(day), Epoch.AddDays(day),
            null, category > 0 ? new(category, $"Category {category}") : null,
            tags.Select(tag => new TaxonomyName(tag, $"Tag {tag}")).ToArray());

    private static (int[] Related, int? Previous, int? Next) View(byte[] frame)
    {
        var payload = Aeds.Decode(frame, FrameType.ArticleRelatedReading);
        var ids = new int[BinaryPrimitives.ReadInt32LittleEndian(payload)];
        var offset = WireLayouts.RelatedReadingHeaderSize;
        for (var index = 0; index < ids.Length; index++, offset += WireLayouts.RelatedReadingItemSize)
            ids[index] = BinaryPrimitives.ReadInt32LittleEndian(payload[offset..]);
        int? previous = null;
        int? next = null;
        if (payload[WireLayouts.RelatedReadingPreviousOffset] != 0)
        {
            previous = BinaryPrimitives.ReadInt32LittleEndian(payload[offset..]);
            offset += WireLayouts.RelatedReadingItemSize;
        }
        if (payload[WireLayouts.RelatedReadingNextOffset] != 0)
            next = BinaryPrimitives.ReadInt32LittleEndian(payload[offset..]);
        return (ids, previous, next);
    }
}
