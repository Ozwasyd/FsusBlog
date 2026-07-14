using FsusBlog.Server.Infrastructure.Audit;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Services;
using Microsoft.AspNetCore.HttpOverrides;
using Serilog;
using System.Runtime;
using System.Runtime.InteropServices;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public static class WebApplicationBuilderCompositionExtensions
{
    public static WebApplicationBuilder ConfigureFsusKestrelSingleProcessRuntime(this WebApplicationBuilder builder)
    {
        builder.WebHost.ConfigureKestrel(options =>
        {
            options.AddServerHeader = false;
            options.AllowSynchronousIO = false;

            options.Limits.KeepAliveTimeout = TimeSpan.FromMinutes(2);
            options.Limits.RequestHeadersTimeout = TimeSpan.FromSeconds(10);
            options.Limits.MaxRequestBodySize = FileService.UploadRequestBodyLimitBytes;

            options.Limits.Http2.MaxStreamsPerConnection = 128;
            options.Limits.Http2.HeaderTableSize = 4096;
            options.Limits.Http2.MaxRequestHeaderFieldSize = 8192;
        });

        return builder;
    }

    public static WebApplicationBuilder ConfigureFsusApplication(this WebApplicationBuilder builder)
    {
        FsusHostRuntimeTuningReport runtimeTuningReport = FsusHostRuntimeTuning.Apply(builder.Configuration);
        builder.Services.AddSingleton(runtimeTuningReport);
        if (!OpenApiExportMode.IsEnabled(builder.Configuration))
        {
            builder.Services.AddHostedService<FsusHostRuntimeTuningLogService>();
        }

        builder.Host.UseSerilog((context, services, configuration) => configuration
            .ReadFrom.Configuration(context.Configuration)
            .ReadFrom.Services(services)
            .Enrich.FromLogContext()
            .Enrich.With(services.GetRequiredService<AuditSerilogEnricher>())
            .WriteTo.Logger(audit => audit
                .Filter.ByIncludingOnly(AuditLogEventMapper.IsAuditCandidate)
                .WriteTo.Sink(services.GetRequiredService<AuditSerilogSink>())));

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
    public static FsusHostRuntimeTuningReport Apply(IConfiguration configuration)
    {
        IConfigurationSection section = configuration.GetSection("RuntimeTuning");
        bool enableEnvironmentDefaults = section.GetValue("EnableEnvironmentDefaults", false);
        string? readyToRun = ResolveStartupValue(section, "ReadyToRun", "DOTNET_ReadyToRun", "COMPlus_ReadyToRun", enableEnvironmentDefaults ? "1" : null);
        string? quickJitForLoops = ResolveStartupValue(section, "QuickJitForLoops", "DOTNET_TC_QuickJitForLoops", "COMPlus_TC_QuickJitForLoops", enableEnvironmentDefaults ? "1" : null);
        string? tieredPgo = ResolveStartupValue(section, "TieredPGO", "DOTNET_TieredPGO", "COMPlus_TieredPGO", enableEnvironmentDefaults ? "1" : null);

        ThreadPool.GetMinThreads(out int beforeWorkerThreads, out int beforeCompletionPortThreads);
        int afterWorkerThreads = beforeWorkerThreads;
        int afterCompletionPortThreads = beforeCompletionPortThreads;
        bool threadPoolApplied = TryApplyThreadPoolTuning(section.GetSection("ThreadPool"), beforeWorkerThreads, beforeCompletionPortThreads, out afterWorkerThreads, out afterCompletionPortThreads);

        return new FsusHostRuntimeTuningReport(
            Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_PROFILE_ID") ?? "unbound",
            Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_PROFILE_MANIFEST_DIGEST") ?? "unbound",
            Environment.GetEnvironmentVariable("FSUSBLOG_RUNTIME_PROFILE_DIGEST") ?? "unbound",
            RuntimeInformation.RuntimeIdentifier,
            RuntimeInformation.FrameworkDescription,
            GCSettings.IsServerGC,
            Environment.ProcessorCount,
            GC.GetGCMemoryInfo().TotalAvailableMemoryBytes,
            readyToRun,
            quickJitForLoops,
            tieredPgo,
            false,
            false,
            false,
            threadPoolApplied,
            beforeWorkerThreads,
            beforeCompletionPortThreads,
            afterWorkerThreads,
            afterCompletionPortThreads);
    }

    private static string? ResolveStartupValue(
        IConfiguration section,
        string configurationKey,
        string dotnetEnvironmentKey,
        string compatibilityEnvironmentKey,
        string? fallback)
    {
        string? observed = Environment.GetEnvironmentVariable(dotnetEnvironmentKey);
        if (string.IsNullOrWhiteSpace(observed)) observed = Environment.GetEnvironmentVariable(compatibilityEnvironmentKey);
        return string.IsNullOrWhiteSpace(observed)
            ? ResolveOptionalValue(section, configurationKey, fallback)
            : observed;
    }

    private static string? ResolveOptionalValue(IConfiguration section, string key, string? fallback)
    {
        string? value = section[key];
        return string.IsNullOrWhiteSpace(value) ? fallback : value;
    }

    private static bool TryApplyThreadPoolTuning(
        IConfiguration section,
        int beforeWorkerThreads,
        int beforeCompletionPortThreads,
        out int afterWorkerThreads,
        out int afterCompletionPortThreads)
    {
        afterWorkerThreads = beforeWorkerThreads;
        afterCompletionPortThreads = beforeCompletionPortThreads;

        bool enabled = section.GetValue("Enabled", false);
        int minThreadsPerCpu = Math.Max(0, section.GetValue("MinThreadsPerCpu", 0));
        int configuredWorkerThreads = Math.Max(0, section.GetValue("MinWorkerThreads", 0));
        int configuredCompletionPortThreads = Math.Max(0, section.GetValue("MinCompletionPortThreads", 0));
        if (!enabled && minThreadsPerCpu == 0 && configuredWorkerThreads == 0 && configuredCompletionPortThreads == 0)
        {
            return false;
        }

        int cpuBasedMinThreads = minThreadsPerCpu > 0 ? Environment.ProcessorCount * minThreadsPerCpu : 0;
        int targetWorkerThreads = Math.Max(beforeWorkerThreads, Math.Max(configuredWorkerThreads, cpuBasedMinThreads));
        int targetCompletionPortThreads = Math.Max(beforeCompletionPortThreads, Math.Max(configuredCompletionPortThreads, cpuBasedMinThreads));
        bool applied = ThreadPool.SetMinThreads(targetWorkerThreads, targetCompletionPortThreads);
        ThreadPool.GetMinThreads(out afterWorkerThreads, out afterCompletionPortThreads);
        return applied;
    }
}

internal sealed record FsusHostRuntimeTuningReport(
    string RuntimeProfileId,
    string RuntimeProfileManifestDigest,
    string RuntimeProfileDigest,
    string RuntimeIdentifier,
    string FrameworkDescription,
    bool ServerGc,
    int ProcessorCount,
    long TotalAvailableMemoryBytes,
    string? ReadyToRun,
    string? QuickJitForLoops,
    string? TieredPgo,
    bool ReadyToRunApplied,
    bool QuickJitForLoopsApplied,
    bool TieredPgoApplied,
    bool ThreadPoolApplied,
    int BeforeWorkerThreads,
    int BeforeCompletionPortThreads,
    int AfterWorkerThreads,
    int AfterCompletionPortThreads);

internal sealed class FsusHostRuntimeTuningLogService(
    FsusHostRuntimeTuningReport report,
    ILogger<FsusHostRuntimeTuningLogService> logger) : IHostedService
{
    public Task StartAsync(CancellationToken cancellationToken)
    {
        logger.LogInformation(
            "Runtime tuning effective values | Profile={RuntimeProfileId} ProfileManifestDigest={RuntimeProfileManifestDigest} ProfileDigest={RuntimeProfileDigest} | Runtime={RuntimeIdentifier} Framework={FrameworkDescription} ServerGC={ServerGc} ProcessorCount={ProcessorCount} TotalAvailableMemoryBytes={TotalAvailableMemoryBytes} | ReadyToRunObserved={ReadyToRun} ReadyToRunInProcessApplied={ReadyToRunApplied} | QuickJitForLoopsObserved={QuickJitForLoops} QuickJitForLoopsInProcessApplied={QuickJitForLoopsApplied} | TieredPGOObserved={TieredPgo} TieredPGOInProcessApplied={TieredPgoApplied} | ThreadPoolApplied={ThreadPoolApplied} | WorkerThreads={BeforeWorkerThreads}->{AfterWorkerThreads} | CompletionPortThreads={BeforeCompletionPortThreads}->{AfterCompletionPortThreads}",
            report.RuntimeProfileId,
            report.RuntimeProfileManifestDigest,
            report.RuntimeProfileDigest,
            report.RuntimeIdentifier,
            report.FrameworkDescription,
            report.ServerGc,
            report.ProcessorCount,
            report.TotalAvailableMemoryBytes,
            report.ReadyToRun ?? "(unchanged)",
            report.ReadyToRunApplied,
            report.QuickJitForLoops ?? "(unchanged)",
            report.QuickJitForLoopsApplied,
            report.TieredPgo ?? "(unchanged)",
            report.TieredPgoApplied,
            report.ThreadPoolApplied,
            report.BeforeWorkerThreads,
            report.AfterWorkerThreads,
            report.BeforeCompletionPortThreads,
            report.AfterCompletionPortThreads);
        return Task.CompletedTask;
    }

    public Task StopAsync(CancellationToken cancellationToken) => Task.CompletedTask;
}
