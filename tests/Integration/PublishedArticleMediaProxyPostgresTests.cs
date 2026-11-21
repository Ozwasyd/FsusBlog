using System.Diagnostics;
using System.Net;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Operations;
using SkiaSharp;
using Xunit.Abstractions;

namespace FsusBlog.V2.Integration.Tests;

public sealed partial class PublishedArticleMediaHttpPostgresTests
{
    private const int MiB = 1024 * 1024;
    private readonly ITestOutputHelper _proxyOutput;

    public PublishedArticleMediaHttpPostgresTests(ITestOutputHelper output) => _proxyOutput = output;

    [CaddyPostgresFact]
    public async Task TrustedCaddyPacesPublishedImagesAndReleasesCancelledReads()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        await using var db = await ScratchDatabase.CreateTimed(out var ct, TimeSpan.FromMinutes(3));
        var author = await MediaFixture.CreateSession(db.DataSource, "TLS image pacing author", ct);
        var workspace = Directory.CreateTempSubdirectory("fsus-published-media-caddy-");
        try
        {
            var privateRoot = MediaFixture.CreateOwnedDirectory(workspace.FullName, "private");
            var publicRoot = MediaFixture.CreateOwnedDirectory(workspace.FullName, "public");
            var tls = MediaFixture.CreateOwnedDirectory(workspace.FullName, "tls");
            var address = NativeCaddyProxy.NewAddress();
            await using var upstream = await ServerProcess.Start(db.ConnectionString, ct, new Dictionary<string, string>
            {
                ["FSUSBLOG_PUBLIC_ORIGIN"] = address.GetLeftPart(UriPartial.Authority),
                [MediaEndpoints.StorageSetting] = privateRoot,
                [PublishedMediaEndpoints.StorageSetting] = publicRoot,
                [LoopbackProxy.ConfigurationKey] = "true"
            }, ready => PublicationFixture.Forward(ready, address.Authority));
            await using var proxy = await NativeCaddyProxy.Start(upstream.Client.BaseAddress!, tls, ct, address);
            var client = proxy.Client;
            _proxyOutput.WriteLine($"Caddy SHA-256 leaf pin {proxy.Fingerprint}, HTTP/2 on {client.BaseAddress}");
            var image = await Upload(client, author, "pacing-fixture.png", "image/png", NoiseImage(), ct);
            Assert.InRange(image.Bytes.Length, 11 * MiB, 15 * MiB);
            var draft = await PostDraft(client, WireRoutes.Save,
                Wire.EncodeArticleCommand(new(0, 0, Guid.NewGuid(), "TLS paced image", "Published media pressure fixture.")), author, ct);
            draft = await Attach(client, author, draft, image.Id, ct);
            var release = await PostDraft(client, WireRoutes.ArticlePublishImages,
                Wire.EncodeArticlePublishImages(new(draft.Id, draft.Revision, Guid.NewGuid(), [image.Id])), author, ct);
            var publication = await PublicationId(db.DataSource, release, ct);
            var raw = RawPath(release.Id, publication, image.Digest);
            var missing = RawPath(release.Id, publication, new string('0', 64));
            var manifest = Wire.DecodePublicArticleMedia(await client.GetByteArrayAsync(ManifestPath(release.Id, publication), ct));
            Assert.Equal(new PublishedArticleImage(image.Digest, 1, image.Bytes.Length, 2048, 2048), Assert.Single(manifest.Images));

            // Prime the route and parser, then refill the same address's burst bucket.
            using (var prime = await ProxyRequest(client, HttpMethod.Get, missing, ct))
                await CheckEmpty(prime, HttpStatusCode.NotFound, ct);
            await Task.Delay(TimeSpan.FromMilliseconds(3250), ct);
            var burst = Stopwatch.GetTimestamp();
            for (var i = 0; i <= 31; i++)
            {
                using var response = await ProxyRequest(client, HttpMethod.Get, missing, ct, spoof: i);
                await CheckEmpty(response, i == 31 ? HttpStatusCode.TooManyRequests : HttpStatusCode.NotFound, ct);
                if (i == 31) Assert.Equal(TimeSpan.FromSeconds(1), response.Headers.RetryAfter?.Delta);
            }
            var burstElapsed = Stopwatch.GetElapsedTime(burst);
            Assert.True(burstElapsed < TimeSpan.FromMilliseconds(100), $"The 32-request TLS burst consumed {burstElapsed.TotalMilliseconds:F1} ms.");
            _proxyOutput.WriteLine($"Burst: 31×404, 1×429 in {burstElapsed.TotalMilliseconds:F1} ms with varying forged forwarding headers.");
            await Task.Delay(TimeSpan.FromMilliseconds(120), ct);
            using (var replenished = await ProxyRequest(client, HttpMethod.Get, missing, ct, spoof: 40))
                await CheckEmpty(replenished, HttpStatusCode.NotFound, ct);
            await Task.Delay(TimeSpan.FromMilliseconds(3250), ct);

            var expectedTail = TimeSpan.FromSeconds((image.Bytes.Length - MiB) / (8.0 * MiB));
            var holdsStarted = Stopwatch.GetTimestamp();
            var holds = Enumerable.Range(0, 4).Select(_ => ProxyRequest(client, HttpMethod.Get, raw, ct)).ToArray();
            try
            {
                var responses = await Task.WhenAll(holds);
                foreach (var response in responses) CheckResponse(response, image);
                using (var excessive = await ProxyRequest(client, HttpMethod.Head, raw, ct))
                    await CheckEmpty(excessive, HttpStatusCode.TooManyRequests, ct);

                responses[0].Dispose();
                var cancelled = Stopwatch.GetTimestamp();
                await WaitForReadLease(client, raw, image, ct);
                var elapsed = Stopwatch.GetElapsedTime(holdsStarted);
                Assert.True(elapsed < expectedTail, $"A slot did not return before the natural transfer tail ({elapsed} vs {expectedTail}).");
                _proxyOutput.WriteLine($"One of four HTTP/2 bodies cancelled. HEAD re-admitted after {Stopwatch.GetElapsedTime(cancelled).TotalMilliseconds:F1} ms.");
            }
            finally
            {
                foreach (var hold in holds)
                    if (hold.IsCompletedSuccessfully) hold.Result.Dispose();
            }

            await WaitForReadLease(client, raw, image, ct);
            using var download = await ProxyRequest(client, HttpMethod.Get, raw, ct);
            CheckResponse(download, image);
            var headersAt = Stopwatch.GetTimestamp();
            await using var body = await download.Content.ReadAsStreamAsync(ct);
            using var digest = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
            var buffer = new byte[64 * 1024];
            for (var read = 0; read < MiB; read += buffer.Length)
            {
                await body.ReadExactlyAsync(buffer, ct);
                digest.AppendData(buffer);
            }
            var threshold = Stopwatch.GetTimestamp();
            var prefix = Stopwatch.GetElapsedTime(headersAt, threshold);
            var total = MiB;
            int received;
            while ((received = await body.ReadAsync(buffer, ct)) != 0)
            {
                total += received;
                digest.AppendData(buffer.AsSpan(0, received));
            }
            var tail = Stopwatch.GetElapsedTime(threshold);
            Assert.Equal(image.Bytes.Length, total);
            Assert.Equal(image.Digest, Convert.ToHexStringLower(digest.GetHashAndReset()));
            Assert.True(prefix < TimeSpan.FromMilliseconds(110), $"Initial MiB took {prefix.TotalMilliseconds:F1} ms even after headers.");
            Assert.InRange(tail.TotalMilliseconds, expectedTail.TotalMilliseconds - 100, expectedTail.TotalMilliseconds + 1500);
            _proxyOutput.WriteLine($"GET bytes={total}, sha256={image.Digest}, first MiB={prefix.TotalMilliseconds:F1} ms, " +
                $"rest={tail.TotalMilliseconds:F1} ms, nominal tail={expectedTail.TotalMilliseconds:F1} ms.");

            using var interrupted = await ProxyRequest(client, HttpMethod.Get, raw, ct);
            CheckResponse(interrupted, image);
            await using var interruptedBody = await interrupted.Content.ReadAsStreamAsync(ct);
            for (var read = 0; read < MiB; read += buffer.Length)
                await interruptedBody.ReadExactlyAsync(buffer, ct);
            var withdrawn = await PostDraft(client, WireRoutes.Retract,
                Wire.EncodeArticleCommand(new(release.Id, release.Revision, Guid.NewGuid(), "", "")), author, ct);
            Assert.False(withdrawn.Published);
            var receivedBeforeWithdrawal = MiB;
            await Assert.ThrowsAnyAsync<IOException>(async () =>
            {
                int rest;
                while ((rest = await interruptedBody.ReadAsync(buffer, ct)) != 0)
                    receivedBeforeWithdrawal += rest;
            });
            Assert.True(receivedBeforeWithdrawal < image.Bytes.Length);
            using var stale = await ProxyRequest(client, HttpMethod.Head, raw, ct);
            await CheckEmpty(stale, HttpStatusCode.NotFound, ct);
        }
        finally { workspace.Delete(recursive: true); }
    }

    private static async Task WaitForReadLease(HttpClient client, string path, Asset image, CancellationToken ct)
    {
        for (var i = 0; i < 12; i++)
        {
            using var response = await ProxyRequest(client, HttpMethod.Head, path, ct);
            if (response.StatusCode == HttpStatusCode.OK)
            {
                CheckResponse(response, image);
                Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
                return;
            }
            await CheckEmpty(response, HttpStatusCode.TooManyRequests, ct);
            await Task.Delay(TimeSpan.FromMilliseconds(20), ct);
        }
        throw new InvalidOperationException("The published media read lease did not become available.");
    }

    private static async Task<HttpResponseMessage> ProxyRequest(HttpClient client, HttpMethod method, string path,
        CancellationToken ct, int? spoof = null)
    {
        using var request = new HttpRequestMessage(method, path)
        {
            Version = HttpVersion.Version20,
            VersionPolicy = HttpVersionPolicy.RequestVersionExact
        };
        if (spoof is { } suffix)
        {
            request.Headers.Add("X-Forwarded-For", $"192.0.2.{suffix + 1}");
            request.Headers.Add("Forwarded", $"for=198.51.100.{suffix + 1};proto=http");
        }
        return await client.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, ct);
    }

    private static void CheckResponse(HttpResponseMessage response, Asset image)
    {
        Assert.Equal(HttpVersion.Version20, response.Version);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
        Assert.Equal(image.Bytes.LongLength, response.Content.Headers.ContentLength);
        Assert.Equal(image.ContentType, response.Content.Headers.ContentType?.MediaType);
        Assert.Equal("none", Assert.Single(response.Headers.AcceptRanges));
        AssertImageHeaders(response);
    }

    private static async Task CheckEmpty(HttpResponseMessage response, HttpStatusCode expected, CancellationToken ct)
    {
        Assert.Equal(HttpVersion.Version20, response.Version);
        Assert.Equal(expected, response.StatusCode);
        AssertImageHeaders(response);
        Assert.Null(response.Content.Headers.ContentType);
        Assert.Empty(await response.Content.ReadAsByteArrayAsync(ct));
    }

    private static byte[] NoiseImage()
    {
        const int side = 2048;
        using var image = new SKBitmap(new SKImageInfo(side, side, SKColorType.Rgba8888, SKAlphaType.Opaque));
        Assert.Equal(side * 4, image.RowBytes);
        var bytes = new byte[side * side * 4];
        new Random(1780).NextBytes(bytes);
        for (var i = 3; i < bytes.Length; i += 4) bytes[i] = byte.MaxValue;
        Marshal.Copy(bytes, 0, image.GetPixels(), bytes.Length);
        using var encoded = image.Encode(SKEncodedImageFormat.Png, 90);
        return encoded.ToArray();
    }
}
