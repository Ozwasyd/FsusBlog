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
        var projection = new RelatedReadingProjection(new[] { source, lateSimilar, newer, sameCategory, sameTag, tiedOlder, outsideWindow }.Concat(fillers).ToArray(), CancellationToken.None);
        var frame = Assert.IsType<byte[]>(projection.Read(source.Id, CancellationToken.None));
        Assert.Same(frame, projection.Read(source.Id, CancellationToken.None));
        var actual = View(frame);
        Assert.Equal(new[] { tiedOlder.Id, lateSimilar.Id, sameCategory.Id, sameTag.Id }, actual.Related[..4]);
        Assert.Equal((tiedOlder.Id, newer.Id), (actual.Previous, actual.Next));
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
        await using var database = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromSeconds(45));
        var (_, token, _) = await database.SignIn("related-author", ct, minutes: 1);
        await using var server = await ServerProcess.Start(database.ConnectionString, ct);

        var article = await Command(WireRoutes.Save, 0, 0, "Published source", "Visible body");
        var privateArticle = await Command(WireRoutes.Save, 0, 0, "Private marker", "DRAFT_ONLY");
        var source = await Command(WireRoutes.Publish, article.Id, article.Revision);
        var empty = await Read(source.Id);
        Assert.Equal(OK, empty.Status);
        var blank = View(empty.Bytes);
        Assert.Empty(blank.Related);
        Assert.Equal(((int?)null, (int?)null), (blank.Previous, blank.Next));

        var hidden = await Read(privateArticle.Id);
        var missing = await Read(2000000000);
        Assert.Equal((NotFound, NotFound), (hidden.Status, missing.Status));
        Aeds.Decode(hidden.Bytes, FrameType.ApiError);
        Aeds.Decode(missing.Bytes, FrameType.ApiError);
        Assert.DoesNotContain("Private marker", Encoding.UTF8.GetString(hidden.Bytes));

        var navigation = await Command(WireRoutes.Publish, privateArticle.Id, privateArticle.Revision);
        var next = await Read(source.Id);
        Assert.NotEqual(empty.Generation, next.Generation);
        Assert.Equal((navigation.Id, source.Id), (View(next.Bytes).Next, View((await Read(navigation.Id)).Bytes).Previous));
        Assert.Empty(View(next.Bytes).Related);
        Assert.Equal(Conflict, (await Read(source.Id, "9223372036854775807")).Status);

        await Command(WireRoutes.Retract, navigation.Id, navigation.Revision);
        var after = await Read(source.Id);
        Assert.Equal(empty.Generation, after.Generation); // The visible coordinate set came back to the first state.
        Assert.Equal(empty.Bytes, after.Bytes);
        Assert.Equal(NotFound, (await Read(navigation.Id)).Status);
        await Command(WireRoutes.Retract, source.Id, source.Revision);
        Assert.Equal(NotFound, (await Read(source.Id)).Status);

        async Task<(HttpStatusCode Status, byte[] Bytes, string Generation)> Read(int id, string? publication = null)
        {
            var path = WireRoutes.PublicRelatedReading.Replace("{articleId:int}", id.ToString());
            using var response = await server.Client.GetAsync(publication is null ? path : path + "?publication=" + publication, ct);
            Assert.True(response.Headers.CacheControl?.NoStore);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            return (response.StatusCode, await response.Content.ReadAsByteArrayAsync(ct),
                Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration)));
        }

        Task<Draft> Command(string path, int id, long revision, string title = "", string body = "") =>
            SiteAedsFixture.ArticleCommand(server.Client, path, token, null, new(id, revision, Guid.NewGuid(), title, body), ct);
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
        int? previous = null, next = null;
        if (payload[WireLayouts.RelatedReadingPreviousOffset] != 0)
        {
            previous = BinaryPrimitives.ReadInt32LittleEndian(payload[offset..]);
            offset += WireLayouts.RelatedReadingItemSize;
        }
        if (payload[WireLayouts.RelatedReadingNextOffset] != 0) next = BinaryPrimitives.ReadInt32LittleEndian(payload[offset..]);
        return (ids, previous, next);
    }
}
