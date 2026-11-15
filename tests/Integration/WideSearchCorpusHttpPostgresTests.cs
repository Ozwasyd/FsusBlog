using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;

namespace FsusBlog.V2.Integration.Tests;

public sealed class WideSearchCorpusHttpPostgresTests
{
    private const string Feature = "FSUSBLOG_WIDE_SEARCH_CORPUS";
    private const int ArticleCount = 40_002;
    private const long PublicationBase = 9_007_199_254_740_992L;
    private const int ManifestHeaderBytes = 60;
    private const int ManifestPageBytes = 60;
    private const int PageSize = WireLimits.SearchIndexPageSize;

    [PostgresFact]
    public async Task WideCorpusServesExactPagesAndRejectsStalePinsEvenWhenPageBytesAreUnchanged()
    {
        if (OperatingSystem.IsWindows()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(2));
        var ct = deadline.Token;
        await using var fixture = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        await using (var disabled = await ServerProcess.Start(fixture.ConnectionString, ct, Settings(false)))
        {
            await ExpectGet(disabled.Client, WireRoutes.PublicSearchWideManifest, HttpStatusCode.NotFound, ct);
            await ExpectGet(disabled.Client, PagePath(1), HttpStatusCode.NotFound, ct);
        }

        var token = await ArticleSearchWideHttpPostgresTests.Seed(fixture, ct);
        await using var server = await ServerProcess.Start(fixture.ConnectionString, ct, Settings(true));
        var client = server.Client;
        var current = await GetManifest(client, ArticleCount, ct);
        var first = await GetPage(client, current, 1, ct);
        await GetPage(client, current, current.Pages.Length / 2, ct);
        var tail = await GetPage(client, current, current.Pages.Length, ct);
        Assert.Equal((40_001, ArticleCount), (tail.Descriptor.First, tail.Descriptor.Last));
        Assert.Equal(2, tail.Descriptor.Count);

        using (var legacy = await client.GetAsync(WireRoutes.PublicSearchCorpus, ct))
        {
            await AssertError(legacy, HttpStatusCode.ServiceUnavailable, ct);
            Assert.Equal(Format(current.Generation), Header(legacy, WireHeaders.SearchIndexGeneration));
            AssertNoWideHeaders(legacy);
        }
        await AssertHead(client, current, ct);

        using (var ranged = new HttpRequestMessage(HttpMethod.Get, PagePath(1) + current.Pin))
        {
            ranged.Headers.Range = new RangeHeaderValue(0, 0);
            using var response = await client.SendAsync(ranged, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Null(response.Content.Headers.ContentRange);
            AssertHeaders(response, current);
            Assert.Equal(first.Bytes, await response.Content.ReadAsByteArrayAsync(ct));
        }
        await AssertNotModified(client, current, first.Validator, ct);
        await AssertRejectedCoordinates(client, current, ct);

        using (var retract = new HttpRequestMessage(HttpMethod.Post, WireRoutes.Retract))
        {
            retract.Headers.Add("Cookie", $"fsus-v2-session={token}");
            retract.Content = new ByteArrayContent(Wire.EncodeArticleCommand(new(ArticleCount, 1, Guid.NewGuid(), "", "")));
            retract.Content.Headers.ContentType = new(Aeds.ContentType);
            using var response = await client.SendAsync(retract, ct);
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(new Draft(ArticleCount, 2, "Quiet", "boundaryrank", false),
                Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct)));
        }

        var replacement = await GetManifest(client, ArticleCount - 1, ct);
        Assert.NotEqual(current.Generation, replacement.Generation);
        Assert.NotEqual(current.Digest, replacement.Digest);
        Assert.Equal(first.Descriptor, replacement.Pages[0]);
        var currentTail = await GetPage(client, replacement, replacement.Pages.Length, ct);
        Assert.Equal((40_001, 40_001, 1),
            (currentTail.Descriptor.First, currentTail.Descriptor.Last, currentTail.Descriptor.Count));
        await AssertHead(client, replacement, ct);
        await AssertNotModified(client, replacement, first.Validator, ct);

        // The first page keeps the same validator, so rejecting the old plan must precede conditional GET.
        using (var stale = new HttpRequestMessage(HttpMethod.Get, PagePath(1) + current.Pin))
        {
            stale.Headers.IfNoneMatch.Add(EntityTagHeaderValue.Parse(first.Validator));
            using var response = await client.SendAsync(stale, ct);
            await AssertError(response, HttpStatusCode.Conflict, ct);
            Assert.Null(response.Headers.ETag);
        }
        await ExpectGet(client, PagePath(1) + Pin(current.Generation, replacement.Digest), HttpStatusCode.Conflict, ct);
        await ExpectGet(client, PagePath(1) + Pin(replacement.Generation, current.Digest), HttpStatusCode.Conflict, ct);
        using var oldHead = new HttpRequestMessage(HttpMethod.Head, WireRoutes.PublicSearchWideManifest + current.Pin);
        using var rejectedHead = await client.SendAsync(oldHead, ct);
        Assert.Equal(HttpStatusCode.Conflict, rejectedHead.StatusCode);
        Assert.True(rejectedHead.Headers.CacheControl?.NoStore);
        Assert.False(rejectedHead.Headers.Contains(WireHeaders.SearchIndexGeneration));
        AssertNoWideHeaders(rejectedHead);
        Assert.Empty(await rejectedHead.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task AssertRejectedCoordinates(HttpClient client, Manifest current, CancellationToken ct)
    {
        await ExpectGet(client, PagePath(1), HttpStatusCode.BadRequest, ct);
        await ExpectGet(client, WireRoutes.PublicSearchWidePage.Replace("{page}", "01", StringComparison.Ordinal) + current.Pin,
            HttpStatusCode.BadRequest, ct);
        await ExpectGet(client, PagePath(1) + $"?generation=0{Format(current.Generation)}&digest={current.Digest}",
            HttpStatusCode.BadRequest, ct);
        await ExpectGet(client, PagePath(1) + Pin(current.Generation, new string('A', 64)), HttpStatusCode.BadRequest, ct);
        await ExpectGet(client, PagePath(1) + current.Pin + $"&generation={Format(current.Generation)}",
            HttpStatusCode.BadRequest, ct);
        await ExpectGet(client, PagePath(current.Pages.Length + 1) + current.Pin, HttpStatusCode.NotFound, ct);
        using var missingPins = new HttpRequestMessage(HttpMethod.Head, WireRoutes.PublicSearchWideManifest);
        using var response = await client.SendAsync(missingPins, ct);
        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task<Manifest> GetManifest(HttpClient client, int documentCount, CancellationToken ct)
    {
        while (true)
        {
            using var response = await client.GetAsync(WireRoutes.PublicSearchWideManifest, ct);
            if (response.StatusCode == HttpStatusCode.ServiceUnavailable)
            {
                await AssertError(response, HttpStatusCode.ServiceUnavailable, ct);
                AssertNoWideHeaders(response);
                Assert.False(response.Headers.Contains(WireHeaders.SearchIndexGeneration));
                await Task.Delay(TimeSpan.FromMilliseconds(25), ct);
                continue;
            }

            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
            var manifest = ParseManifest(await response.Content.ReadAsByteArrayAsync(ct), documentCount);
            AssertHeaders(response, manifest);
            return manifest;
        }
    }

    private static Manifest ParseManifest(byte[] frame, int documentCount)
    {
        Assert.Equal(33004, (int)FrameType.PublicSearchWideManifest);
        var body = Aeds.Decode(frame, FrameType.PublicSearchWideManifest);
        Assert.True(body.Length >= ManifestHeaderBytes);
        Assert.Equal(1, I32(body, 0));
        var generation = I64(body, 4);
        Assert.InRange(generation, 0, long.MaxValue);
        Assert.Equal(documentCount, I32(body, 12));
        var pageCount = I32(body, 16);
        Assert.Equal((documentCount + PageSize - 1) / PageSize, pageCount);
        Assert.Equal(ManifestHeaderBytes + pageCount * ManifestPageBytes, body.Length);
        var byteCount = I64(body, 20);
        var digest = body.Slice(28, 32).ToArray();
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        hash.AppendData("public-search-fspk-manifest-v1\0"u8);
        hash.AppendData(body.Slice(12, 16));
        hash.AppendData(body[ManifestHeaderBytes..]);
        Assert.Equal(digest, hash.GetHashAndReset());

        var pages = new Page[pageCount];
        long offset = 0;
        for (var i = 0; i < pages.Length; i++)
        {
            var row = body.Slice(ManifestHeaderBytes + ManifestPageBytes * i, ManifestPageBytes);
            var expectedFirst = 1 + PageSize * i;
            var expectedLast = Math.Min(documentCount, expectedFirst + PageSize - 1);
            Assert.Equal((i + 1, expectedLast - expectedFirst + 1, expectedFirst, expectedLast, offset),
                (I32(row, 0), I32(row, 4), I32(row, 8), I32(row, 12), I64(row, 16)));
            var length = I32(row, 24);
            Assert.InRange(length, WireLayouts.SearchPackagePayloadOffset + WireLayouts.SearchShardHeaderSize,
                WireLimits.SearchCorpusPageBytes);
            pages[i] = new(expectedLast - expectedFirst + 1, expectedFirst, expectedLast, length,
                Convert.ToHexStringLower(row[28..]));
            offset += length;
        }
        Assert.Equal(byteCount, offset);
        Assert.InRange(byteCount, 1, WireLimits.SearchWideCorpusTotalBytes);
        return new(generation, Convert.ToHexStringLower(digest), pages);
    }

    private static async Task<(Page Descriptor, string Validator, byte[] Bytes)> GetPage(HttpClient client, Manifest manifest,
        int page, CancellationToken ct)
    {
        using var response = await client.GetAsync(PagePath(page) + manifest.Pin, ct);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        AssertHeaders(response, manifest);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        var descriptor = manifest.Pages[page - 1];
        var validator = "\"" + descriptor.Sha256 + "\"";
        Assert.Equal(validator, response.Headers.ETag?.ToString());
        var bytes = await response.Content.ReadAsByteArrayAsync(ct);
        Assert.Equal(descriptor.Length, bytes.Length);
        Assert.Equal(descriptor.Sha256, Convert.ToHexStringLower(SHA256.HashData(bytes)));
        AssertPageCoordinates(bytes, descriptor);
        return (descriptor, validator, bytes);
    }

    private static void AssertPageCoordinates(byte[] bytes, Page page)
    {
        Assert.True(bytes.AsSpan(0, 4).SequenceEqual("FSPK"u8));
        Assert.Equal(4, I32(bytes, 4));
        Assert.Equal(1, I32(bytes, 8));
        var package = WireLayouts.SearchPackageEntryOffset;
        Assert.Equal(0, I32(bytes, package));
        Assert.Equal(0, I32(bytes, package + 4));
        var start = I32(bytes, package + 8);
        Assert.Equal(WireLayouts.SearchPackagePayloadOffset, start);
        Assert.Equal(bytes.Length - start, I32(bytes, package + 12));
        var shard = bytes.AsSpan(start);
        Assert.True(shard[..4].SequenceEqual("FHS2"u8));
        Assert.Equal(4, I32(shard, 4));
        Assert.Equal(page.Count, I32(shard, 20));
        var documents = I32(shard, 40);
        for (var i = 0; i < page.Count; i++)
        {
            var row = shard.Slice(documents + i * WireLayouts.SearchDocumentRecordSize, WireLayouts.SearchDocumentRecordSize);
            var id = page.First + i;
            Assert.Equal(id, I32(row, 0));
            Assert.Equal((1L, 1, PublicationBase + id, 1), (I64(row, 52), I32(row, 60), I64(row, 64), I32(row, 72)));
        }
        Assert.Equal(page.Last, page.First + page.Count - 1);
    }

    private static async Task AssertHead(HttpClient client, Manifest manifest, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Head, WireRoutes.PublicSearchWideManifest + manifest.Pin);
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(HttpStatusCode.NoContent, response.StatusCode);
        AssertHeaders(response, manifest);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task AssertNotModified(HttpClient client, Manifest manifest, string validator, CancellationToken ct)
    {
        using var request = new HttpRequestMessage(HttpMethod.Get, PagePath(1) + manifest.Pin);
        request.Headers.IfNoneMatch.Add(EntityTagHeaderValue.Parse(validator));
        using var response = await client.SendAsync(request, ct);
        Assert.Equal(HttpStatusCode.NotModified, response.StatusCode);
        Assert.Equal(validator, response.Headers.ETag?.ToString());
        AssertHeaders(response, manifest);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task ExpectGet(HttpClient client, string path, HttpStatusCode status, CancellationToken ct)
    {
        using var response = await client.GetAsync(path, ct);
        await AssertError(response, status, ct);
    }

    private static async Task AssertError(HttpResponseMessage response, HttpStatusCode status, CancellationToken ct)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        var frame = await response.Content.ReadAsByteArrayAsync(ct);
        Assert.Equal((int)status, I32(Aeds.Decode(frame, FrameType.ApiError), WireLayouts.ErrorStatusOffset));
    }

    private static void AssertHeaders(HttpResponseMessage response, Manifest manifest)
    {
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Format(manifest.Generation), Header(response, WireHeaders.SearchIndexGeneration));
        Assert.Equal(manifest.Digest, Header(response, WireHeaders.SearchCorpusDigest));
        Assert.Equal(Format(manifest.Pages.Length), Header(response, WireHeaders.SearchIndexPages));
    }

    private static void AssertNoWideHeaders(HttpResponseMessage response)
    {
        Assert.False(response.Headers.Contains(WireHeaders.SearchCorpusDigest));
        Assert.False(response.Headers.Contains(WireHeaders.SearchIndexPages));
    }

    private static IReadOnlyDictionary<string, string> Settings(bool enabled) =>
        new Dictionary<string, string> { [Feature] = enabled ? "true" : "false" };
    private static string PagePath(int page) => WireRoutes.PublicSearchWidePage.Replace("{page}", Format(page), StringComparison.Ordinal);
    private static string Format(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static string Header(HttpResponseMessage response, string name) => Assert.Single(response.Headers.GetValues(name));
    private static string Pin(long generation, string digest) => $"?generation={Format(generation)}&digest={digest}";
    private static int I32(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadInt32LittleEndian(bytes[offset..]);
    private static long I64(ReadOnlySpan<byte> bytes, int offset) => BinaryPrimitives.ReadInt64LittleEndian(bytes[offset..]);

    private sealed record Page(int Count, int First, int Last, int Length, string Sha256);
    private sealed record Manifest(long Generation, string Digest, Page[] Pages)
    {
        internal string Pin => WideSearchCorpusHttpPostgresTests.Pin(Generation, Digest);
    }
}
