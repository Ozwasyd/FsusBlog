using System.Net.Quic;
using System.Security.Cryptography.X509Certificates;

using Microsoft.AspNetCore.Server.Kestrel.Core;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal sealed record FsusHttp3TransportReport(
    bool EnabledRequested,
    bool EndpointConfigured,
    bool QuicProbePerformed,
    bool QuicSupported,
    bool HttpsCertificateReady,
    bool EndpointConfigurationReady,
    int Port,
    string Status,
    IReadOnlyList<string> FallbackReasons);

internal sealed record FsusHttp3TransportActivation(
    FsusHttp3TransportReport Report,
    X509Certificate2? Certificate);

internal static class FsusHttp3Transport
{
    internal const string ConfigurationSectionName = "RuntimeTuning:Http3";
    internal const int DefaultPort = 5443;

    public static FsusHttp3TransportReport Configure(WebApplicationBuilder builder)
    {
        FsusHttp3TransportActivation activation = Evaluate(
            builder.Configuration,
            builder.Environment.ContentRootPath,
            static () => QuicListener.IsSupported);
        FsusHttp3TransportReport report = activation.Report;
        builder.Services.AddSingleton(report);

        if (!report.EnabledRequested
            || !report.EndpointConfigurationReady
            || activation.Certificate is null)
        {
            return report;
        }

        X509Certificate2 certificate = activation.Certificate;
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.ConfigureHttpsDefaults(httpsOptions =>
                httpsOptions.ServerCertificate = certificate);
            if (report.EndpointConfigured)
            {
                options.ConfigureEndpointDefaults(listenOptions =>
                    listenOptions.Protocols = HttpProtocols.Http1AndHttp2AndHttp3);
            }
        });

        return report;
    }

    internal static FsusHttp3TransportActivation Evaluate(
        IConfiguration configuration,
        string contentRootPath,
        Func<bool> quicSupportProbe)
    {
        IConfigurationSection section = configuration.GetSection(ConfigurationSectionName);
        bool enabled = section.GetValue("Enabled", false);
        int port = section.GetValue("Port", DefaultPort);
        if (!enabled)
        {
            return new FsusHttp3TransportActivation(
                new FsusHttp3TransportReport(
                    false,
                    false,
                    false,
                    false,
                    false,
                    true,
                    port,
                    "disabled",
                    ["disabled_by_default"]),
                null);
        }

        var reasons = new List<string>(4);
        bool quicSupported;
        try
        {
            quicSupported = quicSupportProbe();
        }
        catch (Exception exception) when (exception is DllNotFoundException
            or PlatformNotSupportedException
            or TypeInitializationException)
        {
            quicSupported = false;
        }

        if (!quicSupported)
        {
            reasons.Add("quic_runtime_unavailable");
        }

        bool endpointConfigurationReady = port is >= 1 and <= 65535;
        if (!endpointConfigurationReady)
        {
            reasons.Add("port_invalid");
        }
        else if (!HasMatchingHttpsEndpoint(configuration, port))
        {
            endpointConfigurationReady = false;
            reasons.Add("https_endpoint_missing");
        }
        else if (!HasIsolatedHttpsEndpointSet(configuration, port))
        {
            endpointConfigurationReady = false;
            reasons.Add("endpoint_set_not_isolated");
        }

        X509Certificate2? certificate = null;
        string? configuredCertificatePath = section["CertificatePath"];
        if (string.IsNullOrWhiteSpace(configuredCertificatePath))
        {
            reasons.Add("certificate_path_missing");
        }
        else
        {
            try
            {
                string certificatePath = Path.IsPathRooted(configuredCertificatePath)
                    ? configuredCertificatePath
                    : Path.GetFullPath(
                        configuredCertificatePath,
                        string.IsNullOrWhiteSpace(contentRootPath) ? AppContext.BaseDirectory : contentRootPath);
                certificate = X509CertificateLoader.LoadPkcs12FromFile(
                    certificatePath,
                    section["CertificatePassword"],
                    X509KeyStorageFlags.EphemeralKeySet);
                DateTime now = DateTime.UtcNow;
                if (!certificate.HasPrivateKey
                    || now < certificate.NotBefore.ToUniversalTime()
                    || now > certificate.NotAfter.ToUniversalTime())
                {
                    certificate.Dispose();
                    certificate = null;
                    reasons.Add("certificate_invalid");
                }
            }
            catch (Exception exception) when (exception is IOException
                or UnauthorizedAccessException
                or ArgumentException
                or System.Security.Cryptography.CryptographicException)
            {
                reasons.Add("certificate_unavailable");
            }
        }

        bool httpsCertificateReady = certificate is not null;
        bool configured = quicSupported
            && endpointConfigurationReady
            && httpsCertificateReady;
        if (!endpointConfigurationReady || !httpsCertificateReady)
        {
            certificate?.Dispose();
            certificate = null;
        }

        return new FsusHttp3TransportActivation(
            new FsusHttp3TransportReport(
                true,
                configured,
                true,
                quicSupported,
                httpsCertificateReady,
                endpointConfigurationReady,
                port,
                configured ? "ready" : "fallback",
                reasons),
            certificate);
    }

    private static bool HasMatchingHttpsEndpoint(IConfiguration configuration, int port)
    {
        IEnumerable<string?> urls = ParseUrls(configuration["urls"])
            .Concat(configuration.GetSection("Kestrel:Endpoints")
                .GetChildren()
                .Select(static endpoint => endpoint["Url"]));

        foreach (string? value in urls)
        {
            if (Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
                && uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                && uri.Port == port)
            {
                return true;
            }
        }

        string? httpsPorts = configuration["https_ports"];
        if (!string.IsNullOrWhiteSpace(httpsPorts))
        {
            foreach (string candidate in httpsPorts.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries))
            {
                if (int.TryParse(candidate, out int parsedPort) && parsedPort == port)
                {
                    return true;
                }
            }
        }

        return false;
    }

    private static bool HasIsolatedHttpsEndpointSet(IConfiguration configuration, int port)
    {
        if (!string.IsNullOrWhiteSpace(configuration["http_ports"]))
        {
            return false;
        }

        IEnumerable<string?> urls = ParseUrls(configuration["urls"])
            .Concat(configuration.GetSection("Kestrel:Endpoints")
                .GetChildren()
                .Select(static endpoint => endpoint["Url"]));
        foreach (string? value in urls)
        {
            if (!Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
                || !uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                || uri.Port != port)
            {
                return false;
            }
        }

        string? httpsPorts = configuration["https_ports"];
        if (!string.IsNullOrWhiteSpace(httpsPorts)
            && httpsPorts.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Any(candidate => !int.TryParse(candidate, out int parsedPort) || parsedPort != port))
        {
            return false;
        }

        return true;
    }

    private static IEnumerable<string> ParseUrls(string? urls)
        => string.IsNullOrWhiteSpace(urls)
            ? []
            : urls.Split(';', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);
}
