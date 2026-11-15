using System.Diagnostics;
using System.Globalization;
using System.Net;
using System.Net.Security;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

namespace FsusBlog.V2.Integration.Tests;

internal sealed class NativeCaddyProxy(Process child, HttpClient client, X509Certificate2 authority,
    string fingerprint) : IAsyncDisposable
{
    internal HttpClient Client { get; } = client;
    internal string Fingerprint { get; } = fingerprint;

    internal static Uri NewAddress()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;
        return new Uri("https://127.0.0.1:" + port.ToString(CultureInfo.InvariantCulture));
    }

    internal static async Task<NativeCaddyProxy> Start(Uri upstream, string tls, CancellationToken ct, Uri? address = null)
    {
        if (OperatingSystem.IsWindows()) throw new PlatformNotSupportedException("The Caddy fixture uses Unix TLS key permissions.");
        address ??= NewAddress();
        var certificatePath = Path.Combine(tls, "leaf.pem");
        var keyPath = Path.Combine(tls, "leaf.key");
        using var issuerKey = RSA.Create(2048);
        using var leafKey = RSA.Create(2048);
        var issuer = new CertificateRequest("CN=FsusBlog native proxy test CA", issuerKey, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
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

            var caddy = Environment.GetEnvironmentVariable(CaddyPostgresFactAttribute.CaddyPath)!;
            if (!Path.IsPathFullyQualified(caddy) || !File.Exists(caddy))
                throw new InvalidOperationException("Supply the absolute path to the native Caddy executable.");
            var start = new ProcessStartInfo(caddy)
            {
                UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true
            };
            foreach (var argument in new[] { "run", "--config", FindCaddyfile(), "--adapter", "caddyfile" })
                start.ArgumentList.Add(argument);
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

internal sealed class CaddyPostgresFactAttribute : FactAttribute
{
    internal const string CaddyPath = "FSUSBLOG_TEST_CADDY_BIN";

    public CaddyPostgresFactAttribute(bool requiresMigrate = false)
    {
        if (string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(ScratchDatabase.Variable)) ||
            string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(CaddyPath)))
            Skip = $"Set {ScratchDatabase.Variable} and {CaddyPath} to exercise the production TLS proxy.";
        else if (requiresMigrate && !File.Exists(Environment.GetEnvironmentVariable(PublicationTransparencyFact.MigrationPath)))
            Skip = $"Set {PublicationTransparencyFact.MigrationPath} to generate the archived checkpoint.";
    }
}
