using System.Buffers.Binary;
using System.Globalization;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server;
using FsusBlog.V2.Server.Content;
using Npgsql;
using SkiaSharp;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PublishedArticleMediaHttpPostgresTests
{
    [PostgresFact]
    public async Task ExplicitImagesAreScopedToCurrentPublicationAndRemainHiddenWhenDisabled()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var owner = await MediaFixture.CreateSession(db.DataSource, "image release author", ct);
        var other = await MediaFixture.CreateSession(db.DataSource, "independent image author", ct);
        var root = Directory.CreateTempSubdirectory("fsusblog-public-image-");
        using (new MediaFixture.DirectoryCleanup(root))
        {
            var privateRoot = MediaFixture.CreateOwnedDirectory(root.FullName, "private");
            var publicRoot = MediaFixture.CreateOwnedDirectory(root.FullName, "public");
            var enabled = MediaFixture.PublicSettings(privateRoot, publicRoot);
            int otherArticle;
            long otherPublication;
            Asset shared;
            byte[] activeArticleFrame;
            await using (var server = await ServerProcess.Start(db.ConnectionString, ct, enabled))
            {
                var client = server.Client;
                var source = MediaFixture.SolidImage(SKEncodedImageFormat.Png, SKColors.SteelBlue);
                var chosen = await Upload(client, owner, "chosen-private.png", "image/png", source, ct);
                var unselected = await Upload(client, owner, "unselected-private.jpg", "image/jpeg",
                    MediaFixture.SolidImage(SKEncodedImageFormat.Jpeg, SKColors.SeaGreen), ct);
                Assert.NotEqual(chosen.Digest, unselected.Digest);
                var initial = await PostDraft(client, WireRoutes.Save,
                    Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Current public image", "Scoped image fixture.")), owner, ct);
                var draft = await Attach(client, owner, initial, chosen.Id, ct);
                draft = await Attach(client, owner, draft, unselected.Id, ct);
                var mutation = new ArticlePublishImages(draft.Id, draft.Revision, Guid.NewGuid(), [chosen.Id]);
                var frame = Wire.EncodeArticlePublishImages(mutation);

                using (var attachments = await Send(client, HttpMethod.Get,
                    WireRoutes.ArticleMedia.Replace("{id:int}", Invariant(draft.Id)) + "?revision=" + Invariant(draft.Revision), ct, owner))
                {
                    Assert.Equal(HttpStatusCode.OK, attachments.StatusCode);
                    Assert.Equal("1", Assert.Single(attachments.Headers.GetValues(WireHeaders.ArticlePublishImagesEnabled)));
                }
                await RejectPublish(null, HttpStatusCode.Unauthorized);
                await RejectPublish(owner, HttpStatusCode.Conflict, currentSession: "");
                await RejectPublish(owner, HttpStatusCode.Conflict, currentSession: other.SiteSessionId);
                await RejectPublish(other, HttpStatusCode.NotFound);
                await RejectPublish(owner, HttpStatusCode.BadRequest, headerKey: Guid.NewGuid());
                using (var stale = await Send(client, HttpMethod.Post, WireRoutes.ArticlePublishImages, ct, owner,
                    Wire.EncodeArticlePublishImages(mutation with { ExpectedRevision = initial.Revision })))
                    await AssertAedsError(stale, HttpStatusCode.Conflict, ct);
                using (var unpublished = await client.GetAsync(ArticlePath(draft.Id), ct))
                    Assert.Equal(HttpStatusCode.NotFound, unpublished.StatusCode);
                Assert.Empty(Directory.EnumerateFileSystemEntries(publicRoot));

                var released = await PostDraft(client, WireRoutes.ArticlePublishImages, frame, owner, ct, mutation.IdempotencyKey);
                Assert.True(released.Published);
                Assert.Equal(draft.Revision + 1, released.Revision);
                Assert.Equal(draft.Body, released.Body);
                Assert.Equal(released, await PostDraft(client, WireRoutes.ArticlePublishImages, frame, owner, ct, mutation.IdempotencyKey));

                var publication = await PublicationId(db.DataSource, released, ct);
                var manifestPath = ManifestPath(released.Id, publication);
                var rawPath = RawPath(released.Id, publication, chosen.Digest);
                using (var response = await client.GetAsync(manifestPath, ct))
                {
                    Assert.Equal(HttpStatusCode.OK, response.StatusCode);
                    Assert.True(response.Headers.CacheControl?.NoStore);
                    Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
                    var bytes = await response.Content.ReadAsByteArrayAsync(ct);
                    var value = Wire.DecodePublicArticleMedia(bytes);
                    Assert.Equal((released.Id, publication), (value.ArticleId, value.Publication));
                    Assert.Equal(new PublishedArticleImage(chosen.Digest, 1, chosen.Bytes.Length, 3, 2), Assert.Single(value.Images));
                    foreach (var asset in new[] { chosen, unselected })
                    {
                        Assert.Equal(-1, bytes.AsSpan().IndexOf(asset.Id.ToByteArray(bigEndian: true)));
                        Assert.Equal(-1, bytes.AsSpan().IndexOf(Encoding.UTF8.GetBytes(asset.Name)));
                    }
                }
                using (var article = await client.GetAsync(ArticlePath(released.Id), ct))
                {
                    Assert.Equal(HttpStatusCode.OK, article.StatusCode);
                    Assert.Equal("1", Assert.Single(article.Headers.GetValues(WireHeaders.PublicArticleMediaPresent)));
                    var html = await article.Content.ReadAsStringAsync(ct);
                    Assert.Contains(rawPath, html);
                    foreach (var asset in new[] { chosen, unselected })
                    {
                        Assert.DoesNotContain(asset.Name, html);
                        Assert.DoesNotContain(asset.Id.ToString("D"), html);
                    }
                }

                await AssertImage(client, rawPath, chosen, ct);
                var guesses = new[] { RawPath(released.Id, publication, new string('0', 64)), RawPath(released.Id, publication, unselected.Digest) };
                foreach (var guess in guesses)
                    await AssertEmptyImageResponse(client, HttpMethod.Get, guess, HttpStatusCode.NotFound, ct);
                await AssertEmptyImageResponse(client, HttpMethod.Get, rawPath + "?unexpected=1", HttpStatusCode.NotFound, ct);
                foreach (var candidate in new[] { rawPath, guesses[0] })
                {
                    await AssertEmptyImageResponse(client, HttpMethod.Get, candidate, HttpStatusCode.RequestedRangeNotSatisfiable, ct,
                        new("Range", "bytes=0-3"));
                    await AssertEmptyImageResponse(client, HttpMethod.Post, candidate, HttpStatusCode.MethodNotAllowed, ct);
                }

                shared = await Upload(client, other, "same-content-different-owner.png", "image/png", source, ct);
                Assert.NotEqual(chosen.Id, shared.Id);
                Assert.Equal(chosen.Digest, shared.Digest);
                var secondDraft = await PostDraft(client, WireRoutes.Save,
                    Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "Independent publication", "Shared image bytes.")), other, ct);
                secondDraft = await Attach(client, other, secondDraft, shared.Id, ct);
                var secondRelease = await PostDraft(client, WireRoutes.ArticlePublishImages,
                    Wire.EncodeArticlePublishImages(new(secondDraft.Id, secondDraft.Revision, Guid.NewGuid(), [shared.Id])), other, ct);
                otherArticle = secondRelease.Id;
                otherPublication = await PublicationId(db.DataSource, secondRelease, ct);
                Assert.Equal(chosen.Digest + ".media", Path.GetFileName(Assert.Single(Directory.EnumerateFileSystemEntries(publicRoot))));
                var otherPath = RawPath(otherArticle, otherPublication, shared.Digest);
                await AssertImage(client, otherPath, shared, ct);
                await AssertEmptyImageResponse(client, HttpMethod.Get, RawPath(otherArticle, publication, chosen.Digest), HttpStatusCode.NotFound, ct);

                var withdrawn = await PostDraft(client, WireRoutes.Retract,
                    Wire.EncodeArticleCommand(new(released.Id, released.Revision, Guid.NewGuid(), "", "")), owner, ct);
                Assert.False(withdrawn.Published);
                await AssertEmptyImageResponse(client, HttpMethod.Get, rawPath, HttpStatusCode.NotFound, ct,
                    new("If-None-Match", '"' + chosen.Digest + '"'));
                await AssertEmptyImageResponse(client, HttpMethod.Head, rawPath, HttpStatusCode.NotFound, ct);
                using (var old = await client.GetAsync(manifestPath, ct))
                {
                    Assert.Equal(HttpStatusCode.NotFound, old.StatusCode);
                    Assert.True(old.Headers.CacheControl?.NoStore);
                    Assert.Empty(await old.Content.ReadAsByteArrayAsync(ct));
                }
                await AssertImage(client, otherPath, shared, ct);
                using (var binary = await client.GetAsync(DetailPath(otherArticle), ct))
                {
                    Assert.Equal(HttpStatusCode.OK, binary.StatusCode);
                    Assert.Equal("1", Assert.Single(binary.Headers.GetValues(WireHeaders.PublicArticleMediaPresent)));
                    activeArticleFrame = await binary.Content.ReadAsByteArrayAsync(ct);
                    Assert.True(Aeds.Decode(activeArticleFrame, FrameType.ArticleDetail).Length > 0);
                }
                using var ownerBytes = await Send(client, HttpMethod.Get, PrivatePath(chosen.Id), ct, owner);
                Assert.Equal(chosen.Bytes, await ownerBytes.Content.ReadAsByteArrayAsync(ct));

                async Task RejectPublish(MediaFixture.Session? caller, HttpStatusCode status, string? currentSession = null, Guid? headerKey = null)
                {
                    using var response = await Send(client, HttpMethod.Post, WireRoutes.ArticlePublishImages, ct, caller, frame,
                        headerKey, currentSession);
                    await AssertAedsError(response, status, ct);
                }
            }

            enabled[PublishedMediaEndpoints.StorageSetting] = "";
            await using var disabled = await ServerProcess.Start(db.ConnectionString, ct, enabled);
            using (var article = await disabled.Client.GetAsync(ArticlePath(otherArticle), ct))
            {
                Assert.Equal(HttpStatusCode.OK, article.StatusCode);
                Assert.False(article.Headers.Contains(WireHeaders.PublicArticleMediaPresent));
                Assert.DoesNotContain(shared.Digest, await article.Content.ReadAsStringAsync(ct));
            }
            using (var binary = await disabled.Client.GetAsync(DetailPath(otherArticle), ct))
            {
                Assert.Equal(HttpStatusCode.OK, binary.StatusCode);
                Assert.False(binary.Headers.Contains(WireHeaders.PublicArticleMediaPresent));
                Assert.Equal(activeArticleFrame, await binary.Content.ReadAsByteArrayAsync(ct));
            }
            using (var file = await disabled.Client.GetAsync(RawPath(otherArticle, otherPublication, shared.Digest), ct))
            {
                Assert.Equal(HttpStatusCode.NotFound, file.StatusCode);
                Assert.Empty(await file.Content.ReadAsByteArrayAsync(ct));
            }
            using (var manifest = await disabled.Client.GetAsync(ManifestPath(otherArticle, otherPublication), ct))
                Assert.Equal(HttpStatusCode.NotFound, manifest.StatusCode);
            using (var privateImage = await Send(disabled.Client, HttpMethod.Get, PrivatePath(shared.Id), ct, other))
                Assert.Equal(shared.Bytes, await privateImage.Content.ReadAsByteArrayAsync(ct));
        }
    }

    [PostgresFact]
    public async Task UnlistedImageRequestsConsumeTheSameNoStoreAddressLimit()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct);
        var root = Directory.CreateTempSubdirectory("fsusblog-public-image-limit-");
        using (new MediaFixture.DirectoryCleanup(root))
        {
            var privateRoot = MediaFixture.CreateOwnedDirectory(root.FullName, "private");
            var publicRoot = MediaFixture.CreateOwnedDirectory(root.FullName, "public");
            await using var server = await ServerProcess.Start(db.ConnectionString, ct, MediaFixture.PublicSettings(privateRoot, publicRoot));
            using var window = CancellationTokenSource.CreateLinkedTokenSource(ct);
            window.CancelAfter(TimeSpan.FromSeconds(30));
            var path = RawPath(1, 1, new string('0', 64));
            for (var request = 0; request < 600; request++)
                await AssertEmptyImageResponse(server.Client, HttpMethod.Get, path, HttpStatusCode.NotFound, window.Token);
            await AssertEmptyImageResponse(server.Client, HttpMethod.Get, path, HttpStatusCode.TooManyRequests, window.Token);
            Assert.Empty(Directory.EnumerateFileSystemEntries(publicRoot));
        }
    }

    private static async Task AssertImage(HttpClient client, string path, Asset image, CancellationToken ct)
    {
        using var get = await client.GetAsync(path, ct);
        using var head = await Send(client, HttpMethod.Head, path, ct);
        foreach (var response in new[] { get, head })
        {
            Assert.Equal(HttpStatusCode.OK, response.StatusCode);
            Assert.Equal(image.ContentType, response.Content.Headers.ContentType?.MediaType);
            Assert.Equal(image.Bytes.LongLength, response.Content.Headers.ContentLength);
            Assert.Equal(new[] { "none" }, response.Headers.AcceptRanges);
            AssertImageHeaders(response);
        }
        var bytes = await get.Content.ReadAsByteArrayAsync(ct);
        Assert.Equal(image.Bytes, bytes);
        Assert.Equal(image.Digest, Convert.ToHexStringLower(SHA256.HashData(bytes)));
        Assert.Empty(await head.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task AssertEmptyImageResponse(HttpClient client, HttpMethod method, string path, HttpStatusCode status,
        CancellationToken ct, KeyValuePair<string, string>? header = null)
    {
        using var response = await Send(client, method, path, ct, header: header);
        Assert.Equal(status, response.StatusCode);
        AssertImageHeaders(response);
        Assert.Null(response.Content.Headers.ContentType);
        Assert.Null(response.Content.Headers.ContentRange);
        Assert.Equal(0, response.Content.Headers.ContentLength.GetValueOrDefault());
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
        if (status == HttpStatusCode.MethodNotAllowed)
            Assert.Equal(new[] { "GET", "HEAD" }, response.Content.Headers.Allow.Order(StringComparer.Ordinal));
    }

    private static void AssertImageHeaders(HttpResponseMessage response)
    {
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal("same-origin", Assert.Single(response.Headers.GetValues("Cross-Origin-Resource-Policy")));
        Assert.Equal("nosniff", Assert.Single(response.Headers.GetValues("X-Content-Type-Options")));
        Assert.Null(response.Headers.ETag);
        Assert.Null(response.Content.Headers.LastModified);
    }

    private static async Task AssertAedsError(HttpResponseMessage response, HttpStatusCode status, CancellationToken ct)
    {
        Assert.Equal(status, response.StatusCode);
        Assert.True(response.Headers.CacheControl?.NoStore);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        var payload = Aeds.Decode(await response.Content.ReadAsByteArrayAsync(ct), FrameType.ApiError);
        Assert.Equal((int)status, BinaryPrimitives.ReadInt32LittleEndian(payload[WireLayouts.ErrorStatusOffset..]));
    }

    private static Task<Draft> Attach(HttpClient client, MediaFixture.Session author, Draft draft, Guid asset, CancellationToken ct) =>
        PostDraft(client, WireRoutes.ArticleMediaCommand,
            Wire.EncodeArticleMediaCommand(new(draft.Id, draft.Revision, Guid.NewGuid(), asset, true)), author, ct);

    private static async Task<Draft> PostDraft(HttpClient client, string path, byte[] frame, MediaFixture.Session actor, CancellationToken ct,
        Guid? key = null)
    {
        using var response = await Send(client, HttpMethod.Post, path, ct, actor, frame, key);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(Aeds.ContentType, response.Content.Headers.ContentType?.MediaType);
        return Wire.DecodeDraft(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static async Task<Asset> Upload(HttpClient client, MediaFixture.Session owner, string name, string type, byte[] source, CancellationToken ct)
    {
        using var uploaded = await MediaFixture.Upload(client, owner, Guid.NewGuid(), name, type, source, ct);
        Assert.Equal(HttpStatusCode.OK, uploaded.StatusCode);
        var id = MediaFixture.FirstListedAsset(await uploaded.Content.ReadAsByteArrayAsync(ct), 1);
        using var raw = await Send(client, HttpMethod.Get, PrivatePath(id), ct, owner);
        Assert.Equal(HttpStatusCode.OK, raw.StatusCode);
        Assert.Equal(type, raw.Content.Headers.ContentType?.MediaType);
        var canonical = await raw.Content.ReadAsByteArrayAsync(ct);
        return new(id, name, type, canonical, Convert.ToHexStringLower(SHA256.HashData(canonical)));
    }

    private static async Task<HttpResponseMessage> Send(HttpClient client, HttpMethod method, string path, CancellationToken ct,
        MediaFixture.Session? actor = null, byte[]? bytes = null, Guid? mutation = null, string? currentSession = null,
        KeyValuePair<string, string>? header = null)
    {
        var handle = actor is not null && currentSession != "" ? currentSession ?? actor.SiteSessionId : null;
        using var request = SiteAedsFixture.Request(method, path, bytes, actor?.Token, handle, SiteAedsFixture.IsHttps(client));
        if (mutation is { } key) request.Headers.Add(WireHeaders.ClientMutationId, key.ToString("D"));
        if (header is { } additional) request.Headers.Add(additional.Key, additional.Value);
        return await client.SendAsync(request, ct);
    }

    private static async Task<long> PublicationId(NpgsqlDataSource source, Draft draft, CancellationToken ct)
    {
        await using var db = await source.OpenConnectionAsync(ct);
        return Assert.IsType<long>(await FixtureSql.ScalarAsync(db, null, ct, "SELECT publication_id FROM public.article_publication WHERE article_id=$1 AND revision=$2", draft.Id, draft.Revision));
    }

    private static string Invariant(long value) => value.ToString(CultureInfo.InvariantCulture);
    private static string ArticlePath(int article) => "/article/" + Invariant(article);
    private static string DetailPath(int article) => WireRoutes.PublicArticle.Replace("{id}", Invariant(article), StringComparison.Ordinal);
    private static string PrivatePath(Guid asset) => WireRoutes.PrivateMediaRead.Replace("{id}", asset.ToString("D"), StringComparison.Ordinal);
    private static string ManifestPath(int article, long publication) => WireRoutes.PublicArticleMedia
        .Replace("{id:int}", Invariant(article), StringComparison.Ordinal)
        .Replace("{publication:long}", Invariant(publication), StringComparison.Ordinal);
    private static string RawPath(int article, long publication, string digest) => WireRoutes.PublicArticleMediaFile
        .Replace("{id:int}", Invariant(article), StringComparison.Ordinal)
        .Replace("{publication:long}", Invariant(publication), StringComparison.Ordinal)
        .Replace("{digest}", digest, StringComparison.Ordinal);

    private sealed record Asset(Guid Id, string Name, string ContentType, byte[] Bytes, string Digest);
}
