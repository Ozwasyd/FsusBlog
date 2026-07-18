using Npgsql;

using OpenTelemetry.Metrics;
using OpenTelemetry.Resources;
using OpenTelemetry.Trace;

namespace FsusBlog.Server.Infrastructure.Observability;

public static class FsusObservabilityServiceCollectionExtensions
{
    public static IServiceCollection AddFsusObservability(
        this IServiceCollection services,
        IConfiguration configuration,
        IWebHostEnvironment environment)
    {
        var options = new FsusObservabilityOptions();
        configuration.GetSection("Observability").Bind(options);

        string? envOtlpEndpoint = Environment.GetEnvironmentVariable("OTEL_EXPORTER_OTLP_ENDPOINT");
        string? endpoint = FirstNonEmpty(envOtlpEndpoint, options.OtlpEndpoint);
        bool exporterEnabled = options.Enabled
            && (options.ExporterEnabled || !string.IsNullOrWhiteSpace(endpoint));

        services.Configure<FsusObservabilityOptions>(configuration.GetSection("Observability"));
        services.AddSingleton(new ObservabilityRuntimeState(
            options.Enabled,
            exporterEnabled,
            options.ServiceName,
            options.ServiceVersion,
            string.IsNullOrWhiteSpace(endpoint) ? null : endpoint));

        if (!options.Enabled)
        {
            return services;
        }

        services.AddOpenTelemetry()
            .ConfigureResource(resource => resource
                .AddService(
                    serviceName: string.IsNullOrWhiteSpace(options.ServiceName) ? FsusObservability.DefaultServiceName : options.ServiceName,
                    serviceVersion: string.IsNullOrWhiteSpace(options.ServiceVersion) ? FsusObservability.ServiceVersion : options.ServiceVersion)
                .AddAttributes([
                    new KeyValuePair<string, object>("deployment.environment", environment.EnvironmentName),
                    new KeyValuePair<string, object>("fsus.exporter.enabled", exporterEnabled)
                ]))
            .WithTracing(tracing =>
            {
                tracing
                    .AddSource(FsusObservability.ActivitySourceName)
                    .AddAspNetCoreInstrumentation(instrumentation =>
                    {
                        instrumentation.RecordException = true;
                        instrumentation.EnrichWithHttpRequest = static (activity, request) =>
                        {
                            if (activity.IsAllDataRequested)
                            {
                                FsusObservability.SetTag(activity, "fsus.route_kind", FsusObservability.ResolveRouteKind(request.HttpContext));
                            }
                        };
                        instrumentation.EnrichWithHttpResponse = static (activity, response) =>
                        {
                            if (activity.IsAllDataRequested)
                            {
                                FsusObservability.SetTag(activity, "fsus.http.status_code", response.StatusCode);
                            }
                        };
                    })
                    .AddHttpClientInstrumentation()
                    .AddNpgsql();

                if (exporterEnabled)
                {
                    tracing.AddOtlpExporter(exporter =>
                    {
                        if (!string.IsNullOrWhiteSpace(endpoint))
                        {
                            exporter.Endpoint = new Uri(endpoint, UriKind.Absolute);
                        }
                    });
                }
            })
            .WithMetrics(metrics =>
            {
                metrics
                    .AddMeter(
                        FsusObservability.MeterName,
                        "FsusBlog.NotificationStream",
                        "FsusBlog.PublicHotRead",
                        "FsusBlog.PublicHotRead.Retiring",
                        "FsusBlog.PublicAot.MemoryCache")
                    .AddAspNetCoreInstrumentation()
                    .AddHttpClientInstrumentation()
                    .AddRuntimeInstrumentation()
                    .AddNpgsqlInstrumentation();

                if (exporterEnabled)
                {
                    metrics.AddOtlpExporter(exporter =>
                    {
                        if (!string.IsNullOrWhiteSpace(endpoint))
                        {
                            exporter.Endpoint = new Uri(endpoint, UriKind.Absolute);
                        }
                    });
                }
            });

        return services;
    }

    private static string? FirstNonEmpty(params string?[] values)
    {
        for (int i = 0; i < values.Length; i++)
        {
            if (!string.IsNullOrWhiteSpace(values[i]))
            {
                return values[i];
            }
        }

        return null;
    }
}

public sealed record ObservabilityRuntimeState(
    bool Enabled,
    bool ExporterEnabled,
    string ServiceName,
    string ServiceVersion,
    string? OtlpEndpoint);
