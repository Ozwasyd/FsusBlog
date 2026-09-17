using System.Diagnostics.Metrics;
using System.Security.Cryptography;
using System.Security.Cryptography.X509Certificates;

using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Infrastructure.Observability;

using Microsoft.Extensions.Configuration;

namespace FsusBlog.Server.Tests.Unit;

public sealed class FsusHttp3TransportTests
{
    [Fact]
    public void Evaluate_DefaultConfiguration_LeavesHttp3Disabled()
    {
        IConfiguration configuration = new ConfigurationBuilder().Build();

        FsusHttp3TransportActivation activation = FsusHttp3Transport.Evaluate(
            configuration,
            AppContext.BaseDirectory,
            static () => true);

        Assert.False(activation.Report.EnabledRequested);
        Assert.False(activation.Report.EndpointConfigured);
        Assert.False(activation.Report.QuicProbePerformed);
        Assert.Equal("disabled", activation.Report.Status);
        Assert.Equal(["disabled_by_default"], activation.Report.FallbackReasons);
        Assert.Null(activation.Certificate);
    }

    [Fact]
    public void Evaluate_MissingQuicAndCertificate_FallsBackWithoutRegisteringEndpoint()
    {
        IConfiguration configuration = Configuration(new Dictionary<string, string?>
        {
            ["RuntimeTuning:Http3:Enabled"] = "true",
            ["RuntimeTuning:Http3:Port"] = "5443",
            ["urls"] = "https://127.0.0.1:5443"
        });

        FsusHttp3TransportActivation activation = FsusHttp3Transport.Evaluate(
            configuration,
            AppContext.BaseDirectory,
            static () => false);

        Assert.True(activation.Report.EnabledRequested);
        Assert.False(activation.Report.EndpointConfigured);
        Assert.True(activation.Report.QuicProbePerformed);
        Assert.False(activation.Report.QuicSupported);
        Assert.False(activation.Report.HttpsCertificateReady);
        Assert.True(activation.Report.EndpointConfigurationReady);
        Assert.Equal("fallback", activation.Report.Status);
        Assert.Contains("quic_runtime_unavailable", activation.Report.FallbackReasons);
        Assert.Contains("certificate_path_missing", activation.Report.FallbackReasons);
    }

    [Fact]
    public void Evaluate_MixedHttpAndHttpsEndpoints_FallsBackInsteadOfChangingHttpDefaults()
    {
        string directory = Directory.CreateTempSubdirectory("fsus-http3-mixed-").FullName;
        try
        {
            string path = CreateCertificate(directory, "test-password");
            IConfiguration configuration = Configuration(new Dictionary<string, string?>
            {
                ["RuntimeTuning:Http3:Enabled"] = "true",
                ["RuntimeTuning:Http3:Port"] = "5443",
                ["RuntimeTuning:Http3:CertificatePath"] = path,
                ["RuntimeTuning:Http3:CertificatePassword"] = "test-password",
                ["urls"] = "http://127.0.0.1:5080;https://127.0.0.1:5443"
            });

            FsusHttp3TransportActivation activation = FsusHttp3Transport.Evaluate(
                configuration,
                directory,
                static () => true);

            Assert.False(activation.Report.EndpointConfigured);
            Assert.False(activation.Report.EndpointConfigurationReady);
            Assert.Contains("endpoint_set_not_isolated", activation.Report.FallbackReasons);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Evaluate_ValidLocalCertificateAndQuic_ConfiguresCoexistenceEndpoint()
    {
        string directory = Directory.CreateTempSubdirectory("fsus-http3-cert-").FullName;
        try
        {
            string path = CreateCertificate(directory, "test-password");
            IConfiguration configuration = Configuration(new Dictionary<string, string?>
            {
                ["RuntimeTuning:Http3:Enabled"] = "true",
                ["RuntimeTuning:Http3:Port"] = "5443",
                ["RuntimeTuning:Http3:CertificatePath"] = path,
                ["RuntimeTuning:Http3:CertificatePassword"] = "test-password",
                ["urls"] = "https://127.0.0.1:5443"
            });

            FsusHttp3TransportActivation activation = FsusHttp3Transport.Evaluate(
                configuration,
                directory,
                static () => true);

            Assert.True(activation.Report.EndpointConfigured);
            Assert.True(activation.Report.QuicSupported);
            Assert.True(activation.Report.HttpsCertificateReady);
            Assert.True(activation.Report.EndpointConfigurationReady);
            Assert.Equal("ready", activation.Report.Status);
            Assert.Empty(activation.Report.FallbackReasons);
            activation.Certificate?.Dispose();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Evaluate_MissingQuicRetainsCertificateForHttpsH1H2Fallback()
    {
        string directory = Directory.CreateTempSubdirectory("fsus-http3-no-quic-").FullName;
        try
        {
            string path = CreateCertificate(directory, "test-password");
            IConfiguration configuration = Configuration(new Dictionary<string, string?>
            {
                ["RuntimeTuning:Http3:Enabled"] = "true",
                ["RuntimeTuning:Http3:Port"] = "5443",
                ["RuntimeTuning:Http3:CertificatePath"] = path,
                ["RuntimeTuning:Http3:CertificatePassword"] = "test-password",
                ["urls"] = "https://127.0.0.1:5443"
            });

            FsusHttp3TransportActivation activation = FsusHttp3Transport.Evaluate(
                configuration,
                directory,
                static () => false);

            Assert.False(activation.Report.EndpointConfigured);
            Assert.True(activation.Report.EndpointConfigurationReady);
            Assert.True(activation.Report.HttpsCertificateReady);
            Assert.Contains("quic_runtime_unavailable", activation.Report.FallbackReasons);
            Assert.NotNull(activation.Certificate);
            activation.Certificate.Dispose();
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Fact]
    public void Evaluate_MissingMatchingHttpsEndpoint_FallsBackWithoutChangingListeners()
    {
        string directory = Directory.CreateTempSubdirectory("fsus-http3-conflict-").FullName;
        try
        {
            string path = CreateCertificate(directory, "test-password");
            IConfiguration configuration = Configuration(new Dictionary<string, string?>
            {
                ["RuntimeTuning:Http3:Enabled"] = "true",
                ["RuntimeTuning:Http3:Port"] = "5443",
                ["RuntimeTuning:Http3:CertificatePath"] = path,
                ["RuntimeTuning:Http3:CertificatePassword"] = "test-password",
                ["urls"] = "http://127.0.0.1:8080;https://127.0.0.1:5444"
            });

            FsusHttp3TransportActivation activation = FsusHttp3Transport.Evaluate(
                configuration,
                directory,
                static () => true);

            Assert.False(activation.Report.EndpointConfigured);
            Assert.False(activation.Report.EndpointConfigurationReady);
            Assert.True(activation.Report.HttpsCertificateReady);
            Assert.Contains("https_endpoint_missing", activation.Report.FallbackReasons);
            Assert.Null(activation.Certificate);
        }
        finally
        {
            Directory.Delete(directory, recursive: true);
        }
    }

    [Theory]
    [InlineData("HTTP/1.1", "/article/42", "http1", "public-aot")]
    [InlineData("HTTP/2", "/assets/app.js", "http2", "static")]
    [InlineData("HTTP/3", "/assets/decoder.wasm", "http3", "wasm")]
    [InlineData("HTTP/3", "/api/binary/article/search/query.aeds", "http3", "search")]
    [InlineData("HTTP/3", "/api/binary/article/list/1.aeds", "http3", "aeds")]
    [InlineData("HTTP/2", "/api/binary/upload/id/part", "http2", "upload")]
    [InlineData("HTTP/2", "/api/notifications/stream", "http2", "notification-stream")]
    public void TransportMetrics_NormalizeProtocolAndUseBoundedRouteClasses(
        string protocol,
        string path,
        string expectedProtocol,
        string expectedRouteClass)
    {
        Assert.Equal(expectedProtocol, HttpTransportObservability.NormalizeProtocol(protocol));
        Assert.Equal(expectedRouteClass, HttpTransportObservability.ClassifyRoute(path));
    }

    [Fact]
    public void TransportMetrics_EmitOnlyBoundedProtocolRouteAndFallbackTags()
    {
        var measurements = new System.Collections.Concurrent.ConcurrentBag<(string Name, Dictionary<string, object?> Tags)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == HttpTransportObservability.MeterName
                && (instrument.Name == "fsus.http.transport.request.count"
                    || instrument.Name == "fsus.http3.startup.count"))
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static tag => tag.Key, static tag => tag.Value))));
        listener.Start();

        HttpTransportObservability.RecordRequest("HTTP/3", "/assets/decoder.wasm");
        HttpTransportObservability.RecordHttp3Startup("fallback", ["quic_runtime_unavailable"]);

        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.http.transport.request.count"
            && Equals(measurement.Tags["fsus.http.protocol"], "http3")
            && Equals(measurement.Tags["fsus.http.route_class"], "wasm"));
        Assert.Contains(measurements, measurement =>
            measurement.Name == "fsus.http3.startup.count"
            && Equals(measurement.Tags["fsus.http3.startup_status"], "fallback")
            && Equals(measurement.Tags["fsus.http3.fallback_reason"], "quic_runtime_unavailable"));
    }

    private static IConfiguration Configuration(Dictionary<string, string?> values)
        => new ConfigurationBuilder().AddInMemoryCollection(values).Build();

    private static string CreateCertificate(string directory, string password)
    {
        using RSA rsa = RSA.Create(2048);
        var request = new CertificateRequest(
            "CN=fsusblog.test",
            rsa,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
        request.CertificateExtensions.Add(new X509BasicConstraintsExtension(false, false, 0, true));
        request.CertificateExtensions.Add(new X509KeyUsageExtension(X509KeyUsageFlags.DigitalSignature, true));
        var san = new SubjectAlternativeNameBuilder();
        san.AddDnsName("fsusblog.test");
        san.AddDnsName("localhost");
        request.CertificateExtensions.Add(san.Build());
        using X509Certificate2 certificate = request.CreateSelfSigned(
            DateTimeOffset.UtcNow.AddMinutes(-5),
            DateTimeOffset.UtcNow.AddDays(1));
        string path = Path.Combine(directory, "server.pfx");
        File.WriteAllBytes(path, certificate.Export(X509ContentType.Pfx, password));
        return path;
    }
}
