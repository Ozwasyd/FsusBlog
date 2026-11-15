using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;
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

    [PublishedMediaProxyFact]
    public async Task TrustedCaddyPacesPublishedImagesAndReleasesCancelledReads()
    {
        if (!OperatingSystem.IsMacOS() && !OperatingSystem.IsLinux()) return;
        using var deadline = new CancellationTokenSource(TimeSpan.FromMinutes(3));
        var ct = deadline.Token;
        await using var db = await ScratchDatabase.Create(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)!, ct);
        var author = await CreateSession(db.DataSource, "TLS image pacing author", ct);
        var workspace = Directory.CreateTempSubdirectory("fsus-published-media-caddy-");
        try
        {
            var privateRoot = OwnedDirectory(workspace, "private");
            var publicRoot = OwnedDirectory(workspace, "public");
            var tls = OwnedDirectory(workspace, "tls");
            await using var upstream = await ServerProcess.Start(db.ConnectionString, ct, new Dictionary<string, string>
            {
                [MediaEndpoints.StorageSetting] = privateRoot,
                [PublishedMediaEndpoints.StorageSetting] = publicRoot,
                [LoopbackProxy.ConfigurationKey] = "true"
            }, ready =>
            {
                ready.Headers.Add("X-Forwarded-For", "127.0.0.1");
                ready.Headers.Add("X-Forwarded-Proto", "https");
            });
            await using var proxy = await NativeMediaProxy.Start(upstream.Client.BaseAddress!, tls, ct);
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

    private sealed class NativeMediaProxy(Process child, HttpClient client, X509Certificate2 authority,
        string fingerprint) : IAsyncDisposable
    {
        internal HttpClient Client { get; } = client;
        internal string Fingerprint { get; } = fingerprint;

        [UnsupportedOSPlatform("windows")]
        internal static async Task<NativeMediaProxy> Start(Uri upstream, string tls, CancellationToken ct)
        {
            var listener = new TcpListener(IPAddress.Loopback, 0);
            listener.Start();
            var port = ((IPEndPoint)listener.LocalEndpoint).Port;
            listener.Stop();
            var address = new Uri("https://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture));
            var certificatePath = Path.Combine(tls, "leaf.pem");
            var keyPath = Path.Combine(tls, "leaf.key");
            using var issuerKey = RSA.Create(2048);
            using var leafKey = RSA.Create(2048);
            var issuer = new CertificateRequest("CN=FsusBlog native media test CA", issuerKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
            issuer.CertificateExtensions.Add(new X509BasicConstraintsExtension(true, true, 0, critical: true));
            issuer.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.KeyCertSign, critical: true));
            var now = DateTimeOffset.UtcNow;
            var ca = issuer.CreateSelfSigned(now.AddMinutes(-5), now.AddHours(1));
            try
            {
                var request = new CertificateRequest("CN=FsusBlog native loopback test", leafKey, HashAlgorithmName.SHA256,
                    RSASignaturePadding.Pkcs1);
                var san = new SubjectAlternativeNameBuilder();
                san.AddIpAddress(IPAddress.Loopback);
                request.CertificateExtensions.Add(san.Build(critical: true));
                request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, critical: true));
                request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, critical: true));
                request.CertificateExtensions.Add(new X509EnhancedKeyUsageExtension(new OidCollection
                {
                    new("1.3.6.1.5.5.7.3.1")
                }, critical: true));
                using var leaf = request.Create(ca, now.AddMinutes(-1), now.AddMinutes(30), RandomNumberGenerator.GetBytes(16));
                await File.WriteAllTextAsync(certificatePath, leaf.ExportCertificatePem(), ct);
                await File.WriteAllTextAsync(keyPath, leafKey.ExportPkcs8PrivateKeyPem(), ct);
                File.SetUnixFileMode(keyPath, UnixFileMode.UserRead | UnixFileMode.UserWrite);
                var pin = leaf.GetCertHashString(HashAlgorithmName.SHA256);

                var caddy = Environment.GetEnvironmentVariable(PublishedMediaProxyFactAttribute.CaddyPath)!;
                if (!Path.IsPathFullyQualified(caddy) || !File.Exists(caddy))
                    throw new InvalidOperationException("Supply the absolute path to the native Caddy executable.");
                var start = Command(caddy, ["run", "--config", FindCaddyfile(), "--adapter", "caddyfile"]);
                start.Environment["FSUSBLOG_PUBLIC_ADDRESS"] = address.GetLeftPart(UriPartial.Authority);
                start.Environment["FSUSBLOG_PROXY_BIND"] = "127.0.0.1";
                start.Environment["FSUSBLOG_UPSTREAM_PORT"] = upstream.Port.ToString(CultureInfo.InvariantCulture);
                start.Environment["FSUSBLOG_TLS_CERTIFICATE"] = certificatePath;
                start.Environment["FSUSBLOG_TLS_KEY"] = keyPath;
                start.Environment["XDG_DATA_HOME"] = Path.Combine(tls, "caddy-data");
                start.Environment["XDG_CONFIG_HOME"] = Path.Combine(tls, "caddy-config");
                var child = Process.Start(start) ?? throw new InvalidOperationException("Native Caddy did not start.");
                var output = child.StandardOutput.ReadToEndAsync();
                var errors = child.StandardError.ReadToEndAsync();
                var client = new HttpClient(new HttpClientHandler
                {
                    UseCookies = false, UseProxy = false, AllowAutoRedirect = false,
                    ServerCertificateCustomValidationCallback = (_, certificate, _, validation) =>
                        Trust(certificate, validation, ca, pin)
                })
                {
                    BaseAddress = address,
                    DefaultRequestVersion = HttpVersion.Version20,
                    DefaultVersionPolicy = HttpVersionPolicy.RequestVersionExact
                };
                try
                {
                    for (var attempt = 0; attempt < 100 && !child.HasExited; attempt++)
                    {
                        try
                        {
                            using var ready = await client.GetAsync("/health/ready", ct);
                            if (ready.StatusCode == HttpStatusCode.NoContent)
                            {
                                Assert.Equal(HttpVersion.Version20, ready.Version);
                                return new(child, client, ca, pin);
                            }
                        }
                        catch (HttpRequestException) { }
                        await Task.Delay(50, ct);
                    }
                    throw new InvalidOperationException("Native Caddy did not expose the verified TLS readiness route.");
                }
                catch (Exception error)
                {
                    client.Dispose();
                    await Stop(child);
                    throw new InvalidOperationException(error.Message + "\n" + await output + await errors, error);
                }
            }
            catch { ca.Dispose(); throw; }
        }

        public async ValueTask DisposeAsync()
        {
            Client.Dispose();
            try { await Stop(child); }
            finally { authority.Dispose(); }
        }

        private static bool Trust(X509Certificate2? peer, SslPolicyErrors validation, X509Certificate2 authority, string pin)
        {
            if (peer is null || (validation & ~SslPolicyErrors.RemoteCertificateChainErrors) != SslPolicyErrors.None ||
                peer.GetCertHashString(HashAlgorithmName.SHA256) != pin) return false;
            using var chain = new X509Chain();
            chain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
            chain.ChainPolicy.CustomTrustStore.Add(authority);
            chain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
            chain.ChainPolicy.ApplicationPolicy.Add(new Oid("1.3.6.1.5.5.7.3.1"));
            return chain.Build(peer);
        }

        private static string FindCaddyfile()
        {
            for (DirectoryInfo? folder = new(AppContext.BaseDirectory); folder is not null; folder = folder.Parent)
            {
                var path = Path.Combine(folder.FullName, "deploy", "Caddyfile");
                if (File.Exists(path)) return path;
            }
            throw new FileNotFoundException("Could not locate the delivered Caddyfile.");
        }

        private static async Task Stop(Process child)
        {
            using (child)
            {
                if (!child.HasExited) child.Kill(entireProcessTree: true);
                await child.WaitForExitAsync().WaitAsync(TimeSpan.FromSeconds(10));
            }
        }
    }
}

internal sealed class PublishedMediaProxyFactAttribute : FactAttribute
{
    internal const string CaddyPath = "FSUSBLOG_TEST_CADDY_BIN";

    public PublishedMediaProxyFactAttribute()
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)) ||
            string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(CaddyPath)))
            Skip = $"Set {ScratchDatabase.Variable} and {CaddyPath} to exercise the production TLS proxy.";
    }
}
