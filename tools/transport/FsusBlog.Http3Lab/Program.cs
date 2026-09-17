using System.Diagnostics;
using System.Net;
using System.Net.Quic;
using System.Net.Security;
using System.Security.Cryptography.X509Certificates;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Bootstrap;

if (args.Length == 0)
{
    WriteError("usage", "expected preflight, serve, or probe command");
    return 2;
}

return args[0] switch
{
    "preflight" => RunPreflight(),
    "serve" => await RunServerAsync(args[1..]),
    "probe" => await RunProbeAsync(args[1..]),
    _ => WriteError("usage", $"unknown command: {args[0]}")
};

static int RunPreflight()
{
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        schema = "fsusblog.http3-preflight.v1",
        status = QuicListener.IsSupported && QuicConnection.IsSupported ? "ready" : "blocked",
        quicListenerSupported = QuicListener.IsSupported,
        quicClientSupported = QuicConnection.IsSupported,
        framework = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
        runtimeIdentifier = System.Runtime.InteropServices.RuntimeInformation.RuntimeIdentifier,
        operatingSystem = System.Runtime.InteropServices.RuntimeInformation.OSDescription
    }));
    return QuicListener.IsSupported && QuicConnection.IsSupported ? 0 : 3;
}

static async Task<int> RunServerAsync(string[] commandArgs)
{
    Dictionary<string, string> options = ParseOptions(commandArgs);
    int fallbackPort = ReadInt(options, "fallback-port", 5080, 1, 65535);
    int httpsPort = ReadInt(options, "https-port", 0, 0, 65535);
    string listenHost = options.GetValueOrDefault("listen-host") ?? "localhost";
    bool allowNonLoopback = string.Equals(
        options.GetValueOrDefault("allow-non-loopback"),
        "true",
        StringComparison.OrdinalIgnoreCase);
    if (!IsLoopbackHost(listenHost) && !allowNonLoopback)
    {
        return WriteError(
            "listen_host_not_loopback",
            "non-loopback lab binding requires --allow-non-loopback true and an isolated local network");
    }

    var builder = WebApplication.CreateBuilder();
    builder.WebHost.UseUrls(httpsPort > 0
        ? $"https://{FormatHost(listenHost)}:{httpsPort}"
        : $"http://{FormatHost(listenHost)}:{fallbackPort}");
    builder.ConfigureFsusKestrelSingleProcessRuntime();
    var app = builder.Build();

    app.MapGet("/transport/public-aot", () => Results.Text(
        "<!doctype html><html><body><main>FsusBlog HTTP transport lab</main></body></html>",
        "text/html"));
    app.MapGet("/transport/static/app.js", () => Results.Bytes("globalThis.fsusLab=true;"u8.ToArray(), "text/javascript"));
    app.MapGet("/transport/static/decoder.wasm", () => Results.Bytes(new byte[32 * 1024], "application/wasm"));
    app.MapGet("/transport/static/font.woff2", () => Results.Bytes(new byte[64 * 1024], "font/woff2"));
    app.MapGet("/transport/search", () => Results.Bytes(new byte[8 * 1024], "application/vnd.fsus.aeds"));
    app.MapGet("/transport/aeds", () => Results.Bytes(new byte[128 * 1024], "application/vnd.fsus.aeds"));
    app.MapGet("/transport/large", () => Results.Bytes(new byte[2 * 1024 * 1024], "application/octet-stream"));
    app.MapPut("/transport/upload", async (HttpRequest request, CancellationToken cancellationToken) =>
    {
        long bytes = 0;
        byte[] buffer = new byte[16 * 1024];
        int read;
        while ((read = await request.Body.ReadAsync(buffer, cancellationToken)) > 0)
        {
            bytes += read;
        }

        return Results.Json(new
        {
            bytes
        });
    });
    app.MapGet("/transport/notification", async (HttpResponse response, CancellationToken cancellationToken) =>
    {
        response.ContentType = "text/event-stream";
        await response.WriteAsync("event: ready\ndata: {}\n\n", cancellationToken);
    });

    await app.RunAsync();
    return 0;
}

static async Task<int> RunProbeAsync(string[] commandArgs)
{
    Dictionary<string, string> options = ParseOptions(commandArgs);
    if (!options.TryGetValue("url", out string? urlValue)
        || !Uri.TryCreate(urlValue, UriKind.Absolute, out Uri? url))
    {
        return WriteError("url_invalid", "--url must be an absolute URL");
    }

    int requestedMajor = ReadInt(options, "version", 3, 1, 3);
    int requests = ReadInt(options, "requests", 20, 1, 10_000);
    int concurrency = ReadInt(options, "concurrency", 1, 1, 256);
    int timeoutMs = ReadInt(options, "timeout-ms", 15_000, 1, 300_000);
    int cancelAfterMs = ReadInt(options, "cancel-after-ms", 0, 0, 300_000);
    int bodyBytes = ReadInt(options, "body-bytes", 0, 0, 64 * 1024 * 1024);
    string connectionMode = ReadChoice(options, "connection-mode", "reuse", ["reuse", "cold"]);
    string policyName = ReadChoice(options, "policy", "exact", ["exact", "or-lower", "or-higher"]);
    string methodName = ReadChoice(options, "method", "GET", ["GET", "PUT", "POST"]);
    Version requestedVersion = requestedMajor switch
    {
        1 => HttpVersion.Version11,
        2 => HttpVersion.Version20,
        _ => HttpVersion.Version30
    };
    HttpVersionPolicy policy = policyName switch
    {
        "or-lower" => HttpVersionPolicy.RequestVersionOrLower,
        "or-higher" => HttpVersionPolicy.RequestVersionOrHigher,
        _ => HttpVersionPolicy.RequestVersionExact
    };

    X509Certificate2? authority = LoadAuthority(options.GetValueOrDefault("ca-cert"));
    Process? serverProcess = null;
    if (options.TryGetValue("server-pid", out string? pidValue)
        && int.TryParse(pidValue, out int pid))
    {
        try
        {
            serverProcess = Process.GetProcessById(pid);
        }
        catch (ArgumentException)
        {
        }
    }

    ResourceSample before = ResourceSample.Capture(serverProcess);
    long experimentStarted = Stopwatch.GetTimestamp();
    var results = new ProbeResult[requests];
    using var gate = new SemaphoreSlim(concurrency);
    HttpClient? sharedClient = connectionMode == "reuse" ? CreateClient(authority, timeoutMs) : null;
    try
    {
        await Task.WhenAll(Enumerable.Range(0, requests).Select(async index =>
        {
            await gate.WaitAsync();
            try
            {
                using HttpClient? coldClient = connectionMode == "cold" ? CreateClient(authority, timeoutMs) : null;
                HttpClient client = sharedClient ?? coldClient!;
                using var cancellation = cancelAfterMs > 0
                    ? new CancellationTokenSource(cancelAfterMs)
                    : new CancellationTokenSource();
                using var request = new HttpRequestMessage(new HttpMethod(methodName), url)
                {
                    Version = requestedVersion,
                    VersionPolicy = policy,
                    Content = bodyBytes > 0 ? new ByteArrayContent(new byte[bodyBytes]) : null
                };
                long started = Stopwatch.GetTimestamp();
                try
                {
                    using HttpResponseMessage response = await client.SendAsync(
                        request,
                        HttpCompletionOption.ResponseHeadersRead,
                        cancellation.Token);
                    byte[] body = await response.Content.ReadAsByteArrayAsync(cancellation.Token);
                    results[index] = new ProbeResult(
                        true,
                        response.Version.Major,
                        (int)response.StatusCode,
                        Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                        body.Length,
                        null);
                }
                catch (OperationCanceledException)
                {
                    results[index] = new ProbeResult(
                        false,
                        0,
                        0,
                        Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                        0,
                        cancelAfterMs > 0 ? "cancelled" : "timeout");
                }
                catch (HttpRequestException exception)
                {
                    results[index] = new ProbeResult(
                        false,
                        0,
                        0,
                        Stopwatch.GetElapsedTime(started).TotalMilliseconds,
                        0,
                        ClassifyHttpFailure(exception));
                }
            }
            finally
            {
                gate.Release();
            }
        }));
    }
    finally
    {
        sharedClient?.Dispose();
        authority?.Dispose();
    }

    TimeSpan elapsed = Stopwatch.GetElapsedTime(experimentStarted);
    ResourceSample after = ResourceSample.Capture(serverProcess);
    double[] successfulDurations = results
        .Where(static result => result.Success)
        .Select(static result => result.DurationMs)
        .Order()
        .ToArray();
    int http3Success = results.Count(static result => result.Success && result.ActualMajor == 3);
    int fallback = requestedMajor == 3
        ? results.Count(static result => result.Success && result.ActualMajor < 3)
        : 0;
    var errorCategories = results
        .Where(static result => !result.Success)
        .GroupBy(static result => result.ErrorCategory ?? "unknown", StringComparer.Ordinal)
        .ToDictionary(static group => group.Key, static group => group.Count(), StringComparer.Ordinal);
    int successful = results.Count(static result => result.Success);
    Console.WriteLine(JsonSerializer.Serialize(new
    {
        schema = "fsusblog.http3-probe.v1",
        status = successful == requests ? "complete" : "partial",
        target = new
        {
            url = url.ToString(),
            method = methodName,
            bodyBytes
        },
        request = new
        {
            requestedVersion = requestedMajor,
            policy = policyName,
            connectionMode,
            requests,
            concurrency,
            timeoutMs,
            cancelAfterMs
        },
        outcome = new
        {
            attempts = requests,
            successful,
            failed = requests - successful,
            http3Success,
            fallback,
            protocolDistribution = results
                .Where(static result => result.Success)
                .GroupBy(static result => $"http{result.ActualMajor}", StringComparer.Ordinal)
                .ToDictionary(static group => group.Key, static group => group.Count(), StringComparer.Ordinal),
            errorCategories,
            bytes = results.Sum(static result => (long)result.Bytes),
            elapsedMs = elapsed.TotalMilliseconds,
            throughputRequestsPerSecond = elapsed.TotalSeconds > 0 ? successful / elapsed.TotalSeconds : 0,
            latencyMs = new
            {
                p50 = Percentile(successfulDurations, 0.50),
                p95 = Percentile(successfulDurations, 0.95),
                p99 = Percentile(successfulDurations, 0.99)
            }
        },
        serverResources = new
        {
            available = before.Available && after.Available,
            cpuMilliseconds = before.Available && after.Available
                ? Math.Max(0, (after.Cpu - before.Cpu).TotalMilliseconds)
                : 0,
            rssBytesBefore = before.RssBytes,
            rssBytesAfter = after.RssBytes,
            rssBytesPeak = Math.Max(before.RssBytes, after.RssBytes)
        },
        caveat = "local Kestrel-only transport evidence; not a public-network or CDN claim"
    }));

    return successful == requests ? 0 : 4;
}

static HttpClient CreateClient(X509Certificate2? authority, int timeoutMs)
{
    var handler = new SocketsHttpHandler
    {
        EnableMultipleHttp2Connections = true,
        PooledConnectionIdleTimeout = TimeSpan.FromMinutes(1),
        SslOptions = new SslClientAuthenticationOptions
        {
            RemoteCertificateValidationCallback = authority is null
                ? null
                : (_, certificate, chain, errors) => ValidateCertificate(authority, certificate, chain, errors)
        }
    };
    return new HttpClient(handler, disposeHandler: true)
    {
        Timeout = TimeSpan.FromMilliseconds(timeoutMs)
    };
}

static bool ValidateCertificate(
    X509Certificate2 authority,
    X509Certificate? certificate,
    X509Chain? _,
    SslPolicyErrors errors)
{
    if (certificate is null
        || errors.HasFlag(SslPolicyErrors.RemoteCertificateNameMismatch)
        || errors.HasFlag(SslPolicyErrors.RemoteCertificateNotAvailable))
    {
        return false;
    }

    using var leaf = new X509Certificate2(certificate);
    using var customChain = new X509Chain();
    customChain.ChainPolicy.TrustMode = X509ChainTrustMode.CustomRootTrust;
    customChain.ChainPolicy.CustomTrustStore.Add(authority);
    customChain.ChainPolicy.RevocationMode = X509RevocationMode.NoCheck;
    return customChain.Build(leaf);
}

static X509Certificate2? LoadAuthority(string? path)
{
    if (string.IsNullOrWhiteSpace(path))
    {
        return null;
    }

    return X509CertificateLoader.LoadCertificateFromFile(path);
}

static string ClassifyHttpFailure(HttpRequestException exception)
    => exception.HttpRequestError switch
    {
        HttpRequestError.SecureConnectionError => "tls_handshake",
        HttpRequestError.HttpProtocolError => "http_protocol",
        HttpRequestError.VersionNegotiationError => "version_negotiation",
        HttpRequestError.ConnectionError => "quic_or_tcp_connection",
        HttpRequestError.NameResolutionError => "dns",
        _ => "http_request"
    };

static double Percentile(double[] sorted, double percentile)
{
    if (sorted.Length == 0)
    {
        return 0;
    }

    int index = Math.Clamp((int)Math.Ceiling(sorted.Length * percentile) - 1, 0, sorted.Length - 1);
    return sorted[index];
}

static Dictionary<string, string> ParseOptions(string[] values)
{
    var options = new Dictionary<string, string>(StringComparer.Ordinal);
    for (int index = 0; index < values.Length; index++)
    {
        string key = values[index];
        if (!key.StartsWith("--", StringComparison.Ordinal) || index + 1 >= values.Length)
        {
            continue;
        }

        options[key[2..]] = values[++index];
    }

    return options;
}

static int ReadInt(
    IReadOnlyDictionary<string, string> options,
    string name,
    int fallback,
    int minimum,
    int maximum)
{
    if (!options.TryGetValue(name, out string? value))
    {
        return fallback;
    }

    if (!int.TryParse(value, out int parsed) || parsed < minimum || parsed > maximum)
    {
        throw new ArgumentOutOfRangeException(name, $"--{name} must be between {minimum} and {maximum}");
    }

    return parsed;
}

static string ReadChoice(
    IReadOnlyDictionary<string, string> options,
    string name,
    string fallback,
    IReadOnlyList<string> allowed)
{
    string value = options.GetValueOrDefault(name) ?? fallback;
    if (!allowed.Contains(value, StringComparer.OrdinalIgnoreCase))
    {
        throw new ArgumentOutOfRangeException(name, $"--{name} must be one of {string.Join(',', allowed)}");
    }

    return value.ToUpperInvariant() is "GET" or "PUT" or "POST"
        ? value.ToUpperInvariant()
        : value.ToLowerInvariant();
}

static int WriteError(string code, string message)
{
    Console.Error.WriteLine(JsonSerializer.Serialize(new
    {
        status = "failed",
        code,
        message
    }));
    return 2;
}

static bool IsLoopbackHost(string host)
    => host.Equals("localhost", StringComparison.OrdinalIgnoreCase)
        || (IPAddress.TryParse(host, out IPAddress? address) && IPAddress.IsLoopback(address));

static string FormatHost(string host)
    => IPAddress.TryParse(host, out IPAddress? address) && address.AddressFamily == System.Net.Sockets.AddressFamily.InterNetworkV6
        ? $"[{host}]"
        : host;

internal sealed record ProbeResult(
    bool Success,
    int ActualMajor,
    int StatusCode,
    double DurationMs,
    int Bytes,
    string? ErrorCategory);

internal readonly record struct ResourceSample(
    bool Available,
    TimeSpan Cpu,
    long RssBytes)
{
    public static ResourceSample Capture(Process? process)
    {
        if (process is null || process.HasExited)
        {
            return new ResourceSample(false, TimeSpan.Zero, 0);
        }

        process.Refresh();
        return new ResourceSample(true, process.TotalProcessorTime, process.WorkingSet64);
    }
}
