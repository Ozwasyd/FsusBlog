using System.Runtime.InteropServices;

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
        using (new MediaFixture.DirectoryCleanup(workspace))
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
            var draft = await SaveDraft(client, author, "TLS paced image", "Published media pressure fixture.", ct);
            var release = await AttachAndPublish(client, author, draft, image.Id, ct);
            var publication = await PublicationId(db, release, ct);
            var raw = RawPath(release.Id, publication, image.Digest);
            var missing = RawPath(release.Id, publication, new string('0', 64));
            var manifest = Wire.DecodePublicArticleMedia(await client.GetByteArrayAsync(ManifestPath(release.Id, publication), ct));
            Assert.Equal(new PublishedArticleImage(image.Digest, 1, image.Bytes.Length, 2048, 2048), Assert.Single(manifest.Images));

            // Prime the route and parser, then refill the same address's burst bucket.
            using (var prime = await ProxyRequest(client, HttpMethod.Get, missing, ct))
                await CheckEmpty(prime, HttpStatusCode.NotFound, ct);
            await Task.Delay(TimeSpan.FromMilliseconds(3250), ct);
            // The manual-clock limiter test covers the exact refill boundary. Here the
            // real HTTP/2 route must share one address budget despite differing headers.
            const int burstRequests = 64;
            var burst = Stopwatch.GetTimestamp();
            var statuses = await Task.WhenAll(Enumerable.Range(0, burstRequests).Select(async i =>
            {
                using var response = await ProxyRequest(client, HttpMethod.Get, missing, ct, spoof: i);
                if (response.StatusCode == HttpStatusCode.TooManyRequests)
                {
                    await CheckEmpty(response, HttpStatusCode.TooManyRequests, ct);
                    Assert.Equal(TimeSpan.FromSeconds(1), response.Headers.RetryAfter?.Delta);
                }
                else
                {
                    await CheckEmpty(response, HttpStatusCode.NotFound, ct);
                }
                return response.StatusCode;
            }));
            var burstElapsed = Stopwatch.GetElapsedTime(burst);
            var admitted = statuses.Count(status => status == HttpStatusCode.NotFound);
            var admittedLimit = 31 + burstElapsed.Ticks / TimeSpan.FromMilliseconds(100).Ticks;
            Assert.InRange((long)admitted, 31L, admittedLimit);
            Assert.Contains(HttpStatusCode.TooManyRequests, statuses);
            _proxyOutput.WriteLine($"Burst: {admitted}×404, {burstRequests - admitted}×429 in {burstElapsed.TotalMilliseconds:F1} ms.");
            await Task.Delay(TimeSpan.FromMilliseconds(120), ct);
            using (var replenished = await ProxyRequest(client, HttpMethod.Get, missing, ct, spoof: burstRequests))
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
            var withdrawn = await RetractDraft(client, author, release, ct);
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
            await CheckEmpty(stale, NotFound, ct);
        }
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
        AssertImageResponse(response, image);
    }

    private static async Task CheckEmpty(HttpResponseMessage response, HttpStatusCode expected, CancellationToken ct)
    {
        Assert.Equal(HttpVersion.Version20, response.Version);
        AssertEmptyImageHeaders(response, expected);
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
