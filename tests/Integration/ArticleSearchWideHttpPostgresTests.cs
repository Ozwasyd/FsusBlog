using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;

namespace FsusBlog.V2.Integration.Tests;

public sealed class ArticleSearchWideHttpPostgresTests
{
    private const int ArticleCount = 40_002;
    private const int MiddleHit = 20_002;
    private const int LastArticle = 1;
    private const long PublicationBase = 9_007_199_254_740_992L;
    private const string LastBody = "lastversionneedle";

    [PostgresFact]
    public async Task WideFas4ServesTheLastPublicArticleWhileOversizedFspkFailsClosed()
    {
        await using var fixture = await ScratchDatabase.CreateTimed(out var ct);
        var token = await Seed(fixture, ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct);
        var client = server.Client;

        var (rare, generation) = await Search(LastBody);
        Assert.Equal(Hit.ForArticle(LastArticle), Assert.Single(rare));
        var (ranked, rankedGeneration) = await Search("boundaryrank");
        Assert.Equal(generation, rankedGeneration);
        // Equal-length title matches tie by article ID, ahead of the body and derived summary match.
        Assert.Equal([Hit.ForArticle(MiddleHit), Hit.ForArticle(LastArticle), Hit.ForArticle(ArticleCount)], ranked);
        await AssertFspkError(WireRoutes.PublicSearchCorpus, HttpStatusCode.ServiceUnavailable,
            "The search corpus is unavailable.", generation);
        await AssertListAndIndex(ArticleCount, generation, [Hit.ForArticle(2), Hit.ForArticle(LastArticle)]);
        await AssertDetail(LastArticle, generation);
        using (var html = await client.GetAsync($"/article/{LastArticle}", ct))
        {
            Assert.Equal(HttpStatusCode.OK, html.StatusCode);
            Assert.Equal(generation, Generation(html));
            Assert.Contains(LastBody, await html.Content.ReadAsStringAsync(ct));
        }

        using (var request = SiteAedsFixture.Request(HttpMethod.Post, WireRoutes.Retract,
            Wire.EncodeArticleCommand(new(LastArticle, 1, Guid.NewGuid(), "", "")), token, handle: null))
        {
            using var response = await client.SendAsync(request, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            var receipt = Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
            Assert.Equal(new Draft(LastArticle, 2, "Boundaryrank", LastBody, false), receipt);
        }

        var (withdrawn, after) = await Search(LastBody);
        Assert.Empty(withdrawn);
        Assert.NotEqual(generation, after);
        var (remaining, remainingGeneration) = await Search("boundaryrank");
        Assert.Equal(after, remainingGeneration);
        Assert.Equal([Hit.ForArticle(MiddleHit), Hit.ForArticle(ArticleCount)], remaining);
        await AssertFspkError($"{WireRoutes.PublicSearchCorpus}?generation={generation}", HttpStatusCode.Conflict,
            "The search corpus changed. Reload it from page 1.", after);
        await AssertFspkError($"{WireRoutes.PublicSearchCorpus}?generation={after}", HttpStatusCode.ServiceUnavailable,
            "The search corpus is unavailable.", after);
        await AssertListAndIndex(ArticleCount - 1, after, [Hit.ForArticle(2)]);
        await AssertDetail(2, after);
        using var missing = await client.GetAsync(ArticlePath(LastArticle), ct);
        Assert.Equal(after, Generation(missing));
        await AssertError(missing, HttpStatusCode.NotFound, "Article not found.", ct);
        using var missingHtml = await client.GetAsync($"/article/{LastArticle}", ct);
        Assert.Equal(HttpStatusCode.NotFound, missingHtml.StatusCode);
        Assert.DoesNotContain(LastBody, await missingHtml.Content.ReadAsStringAsync(ct));

        async Task<(Hit[] Hits, string Generation)> Search(string term)
        {
            using var response = await client.GetAsync($"{WireRoutes.PublicSearch}?q={Uri.EscapeDataString(term)}", ct);
            var packet = await ReadPacket(response, ct);
            return (ReadSearch(packet), Generation(response));
        }

        async Task AssertFspkError(string path, HttpStatusCode status, string message, string expectedGeneration)
        {
            using var response = await client.GetAsync(path, ct);
            Assert.Equal(expectedGeneration, Generation(response));
            Assert.False(response.Headers.Contains(WireHeaders.SearchIndexPages));
            Assert.Null(response.Headers.ETag);
            await AssertError(response, status, message, ct);
        }

        async Task AssertListAndIndex(int count, string expectedGeneration, Hit[] expectedTail)
        {
            var listPath = WireRoutes.PublicList.Replace("{page:int}", "1", StringComparison.Ordinal)
                .Replace("{size:int}", "1", StringComparison.Ordinal);
            using var list = await client.GetAsync(listPath, ct);
            Assert.Equal(expectedGeneration, Generation(list));
            AssertList(await ReadPacket(list, ct), count);

            var lastPage = (count + WireLimits.SearchIndexPageSize - 1) / WireLimits.SearchIndexPageSize;
            using var index = await client.GetAsync($"{WireRoutes.PublicIndex}?page={lastPage}&generation={expectedGeneration}", ct);
            Assert.Equal(expectedGeneration, Generation(index));
            Assert.Equal(lastPage.ToString(CultureInfo.InvariantCulture),
                Assert.Single(index.Headers.GetValues(WireHeaders.SearchIndexPages)));
            Assert.Equal(expectedTail, ReadSearch(await ReadPacket(index, ct)));
        }

        async Task AssertDetail(int id, string expectedGeneration)
        {
            using var response = await client.GetAsync(ArticlePath(id), ct);
            Assert.Equal(expectedGeneration, Generation(response));
            Assert.Equal(Hit.ForArticle(id), ReadDetail(await ReadPacket(response, ct)));
        }
    }

    internal static async Task<string> Seed(ScratchDatabase fixture, CancellationToken ct)
    {
        var (author, token, _) = await fixture.SignIn("FAS4 wide author", ct, minutes: 5);
        await using (var db = await fixture.DataSource.OpenConnectionAsync(ct))
        await using (var tx = await db.BeginTransactionAsync(ct))
        {
            // With equal timestamps, the snapshot's descending ID order puts article 1 at the final ordinal.
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article(id,owner_id,revision,title,body,published_revision,publication_count,deleted,created_at,updated_at)
                overriding system value
                select id,$1,1,case when id in (1,$3) then 'Boundaryrank' else 'Quiet' end,
                    case when id=1 then $4 when id=$2 then 'boundaryrank' else 'silent' end,
                    1,1,false,timestamptz '2025-01-01 UTC',timestamptz '2025-01-01 UTC'
                from generate_series(1,$2) id
                """, author, ArticleCount, MiddleHit, LastBody);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_revision(article_id,revision,title,body,happened_at)
                select id,revision,title,body,created_at from public.article
                """);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_publication(article_id,revision,publication_id,published_at)
                select id,revision,$1+id,created_at from public.article
                """, PublicationBase);
            await FixtureSql.ExecuteAsync(db, tx, ct, """
                insert into public.article_revision_rights(article_id,revision,enabled,license_type,
                    copyright_holder,copyright_year,rights_statement,attribution_template,
                    copy_policy,max_excerpt_chars,allow_code_copy,show_public_badge,proof_binding_enabled)
                select article_id,revision,true,'all-rights-reserved','',0,'','','append-attribution',300,true,true,true
                from public.article_publication;
                insert into public.article_publication_rights(article_id,publication_id,revision)
                select article_id,publication_id,revision from public.article_publication;
                insert into public.article_publication_history
                    (article_id,event_no,revision,publication_no,publication_id,kind,reason,happened_at)
                select article_id,1,revision,publication_no,publication_id,'retained-active','pre-history',published_at
                from public.article_publication
                """);
            await tx.CommitAsync(ct);
        }
        return token;
    }

    private static string ArticlePath(int id) =>
        WireRoutes.PublicArticle.Replace("{id}", id.ToString(CultureInfo.InvariantCulture), StringComparison.Ordinal);

    private static string Generation(HttpResponseMessage response) =>
        Assert.Single(response.Headers.GetValues(WireHeaders.SearchIndexGeneration));

    private static async Task<byte[]> ReadPacket(HttpResponseMessage response, CancellationToken ct)
    {
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        return await response.Content.ReadAsByteArrayAsync(ct);
    }

    private static async Task AssertError(HttpResponseMessage response, HttpStatusCode status, string message, CancellationToken ct)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        var payload = Aeds.Decode(await response.Content.ReadAsByteArrayAsync(ct), FrameType.ApiError);
        Assert.Equal((int)status, I32(payload, WireLayouts.ErrorStatusOffset));
        Assert.Equal(message, Encoding.UTF8.GetString(payload[WireLayouts.ErrorMessageOffset..WireLayouts.ErrorDetailsOffset]).TrimEnd('\0'));
    }

    private static void AssertList(byte[] packet, int count)
    {
        var payload = Aeds.Decode(packet, FrameType.ArticleList);
        Assert.Equal(WireLayouts.ArticleListCursorMagic, I32(payload, 0));
        Assert.Equal(WireLayouts.ArticleListCursorVersion, I32(payload, 4));
        Assert.Equal(count, I32(payload, WireLayouts.ArticleListTotalOffset));
        var meta = WireLayouts.ArticleListCursorOffset + I32(payload, WireLayouts.ArticleListCursorLengthOffset);
        Assert.Equal(1, I32(payload, meta));
        var record = payload[(meta + 12 + I32(payload, meta + 8))..];
        Assert.Equal(Hit.ForArticle(ArticleCount), ReadHit(I32(record, WireLayouts.ArticleIdOffset),
            record[WireLayouts.ArticleListCoordinatesOffset..]));
    }

    private static Hit ReadDetail(byte[] packet)
    {
        var payload = Aeds.Decode(packet, FrameType.ArticleDetail);
        Assert.Equal(WireLayouts.ArticleDetailV5Magic, I32(payload, 0));
        Assert.Equal(WireLayouts.ArticleDetailV5Version, I32(payload, 4));
        var record = payload.Slice(WireLayouts.ArticleDetailHeaderSize, WireLayouts.ArticleDetailV5RecordSize);
        return ReadHit(I32(record, WireLayouts.ArticleIdOffset), record[WireLayouts.ArticleDetailCoordinatesOffset..]);
    }

    private static Hit[] ReadSearch(byte[] packet)
    {
        var payload = Aeds.Decode(packet, FrameType.ArticleSearch);
        Assert.Equal(WireLayouts.ArticleSearchV4Magic, I32(payload, 0));
        Assert.Equal(WireLayouts.ArticleSearchV4Version, I32(payload, 4));
        var result = new Hit[I32(payload, 8)];
        var offset = 12;
        for (var index = 0; index < result.Length; index++)
        {
            var id = I32(payload, offset);
            offset += WireLayouts.ArticleSearchItemPodSize;
            Assert.Equal(0, I32(payload, offset));
            offset += 4;
            offset += 4 + I32(payload, offset);
            result[index] = ReadHit(id, payload[offset..]);
            offset += WireLayouts.ArticlePublicationCoordinateBytes;
        }
        Assert.Equal(payload.Length, offset);
        return result;
    }

    private static Hit ReadHit(int id, ReadOnlySpan<byte> coordinates) =>
        new(id, BinaryPrimitives.ReadInt64LittleEndian(coordinates), I32(coordinates, 8),
            BinaryPrimitives.ReadInt64LittleEndian(coordinates[12..]), I32(coordinates, 20));

    private static int I32(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadInt32LittleEndian(bytes[offset..]);

    private readonly record struct Hit(int Id, long Revision, int RevisionNo, long Publication, int PublicationNo)
    {
        internal static Hit ForArticle(int id) => new(id, 1, 1, PublicationBase + id, 1);
    }
}
