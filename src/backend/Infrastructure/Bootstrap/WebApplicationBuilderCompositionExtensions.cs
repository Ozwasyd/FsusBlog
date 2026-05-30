using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Observability;
using Microsoft.AspNetCore.HttpOverrides;
using Serilog;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public static class WebApplicationBuilderCompositionExtensions
{
    public static WebApplicationBuilder ConfigureFsusApplication(this WebApplicationBuilder builder)
    {
        FsusHostRuntimeTuning.Apply();

        builder.Host.UseSerilog((context, services, configuration) => configuration
            .ReadFrom.Configuration(context.Configuration)
            .ReadFrom.Services(services)
            .Enrich.FromLogContext()
            .Enrich.With(services.GetRequiredService<AuditSerilogEnricher>())
            .WriteTo.Sink(services.GetRequiredService<AuditSerilogSink>()));

        builder.Services.Configure<ForwardedHeadersOptions>(options =>
        {
            ReverseProxyForwardedHeaders.Configure(
                options,
                builder.Configuration,
                builder.Environment.IsProduction());
        });

        builder.Services
            .AddFsusApiFoundation(builder.Configuration)
            .AddFsusRuntimeServices(builder.Configuration)
            .AddFsusObservability(builder.Configuration, builder.Environment)
            .AddFsusRateLimiting();

        return builder;
    }
}

internal static class FsusHostRuntimeTuning
{
    public static void Apply()
    {
        SetIfMissing("DOTNET_ReadyToRun", "1");
        SetIfMissing("DOTNET_TC_QuickJitForLoops", "1");
        SetIfMissing("DOTNET_TieredPGO", "1");

        ThreadPool.GetMinThreads(out int workerThreads, out _);
        int minThreadsBasedOnCpu = Environment.ProcessorCount * 50;
        int targetMinThreads = Math.Max(minThreadsBasedOnCpu, workerThreads);
        ThreadPool.SetMinThreads(targetMinThreads, targetMinThreads);
    }

    private static void SetIfMissing(string key, string value)
    {
        if (!string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key)))
        {
            return;
        }

        Environment.SetEnvironmentVariable(key, value);
    }
}
