using System.Diagnostics;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Shared.Contracts.Outputs;

namespace FsusBlog.Server.Tests.TestInfrastructure;

internal static partial class PublicAotCrashWorkerProgram
{
    private static async Task<int> RunAsync(PublicAotCrashWorkerRequest request)
    {
        string assemblyPath = typeof(PublicAotCrashWorkerProgram).Assembly.Location;
        string executablePath = Environment.ProcessPath
            ?? throw new InvalidOperationException("The worker executable identity is unavailable.");
        int childProcessId = Environment.ProcessId;
        var handshake = new PublicAotCrashWorkerHandshake(
            "fsusblog.public-aot-crash-worker-handshake.v1",
            TextIdentity(request.InvocationId.ToString("D")),
            request.ParentProcessId,
            childProcessId,
            FileIdentity(executablePath),
            FileIdentity(assemblyPath),
            CommandIdentity(executablePath, assemblyPath),
            PathIdentity(request.SandboxRoot),
            PathIdentity(request.CacheRoot),
            request.CrashState.ToString());
        Console.Out.WriteLine($"{HandshakePrefix}{JsonSerializer.Serialize(handshake, s_jsonOptions)}");
        Console.Out.Flush();

        PublicAotFileShellCache cache = BuildCache(
            request.CacheRoot,
            (state, _) =>
            {
                if (state == request.CrashState)
                {
                    var durableState = new PublicAotCrashWorkerDurableState(
                        "fsusblog.public-aot-crash-worker-durable-state.v1",
                        handshake.InvocationIdentity,
                        childProcessId,
                        handshake.CacheRootIdentity,
                        state.ToString());
                    Console.Out.WriteLine(
                        $"{CrashStatePrefix}{JsonSerializer.Serialize(durableState, s_jsonOptions)}");
                    Console.Out.Flush();
                    Process.GetCurrentProcess().Kill();
                }

                return Task.CompletedTask;
            });
        var entry = new PublicAotCacheEntry
        {
            CacheKey = CacheKey,
            RouteKey = "article:process-crash",
            PageId = PublicPageId.ArticleDetail,
            Source = PublicAotWriteSource.ServerSsrBackfill,
            GeneratedAtUtc = DateTimeOffset.UtcNow.AddSeconds(-1),
            ExpiresAtUtc = DateTimeOffset.UtcNow.AddMinutes(30),
            RendererVersion = "renderer-v2",
            FrontendAssetVersion = FrontendAssetVersion,
            Value = ExpectedValue
        };
        await cache.SetAsync(entry);
        Console.Error.WriteLine($"{FailurePrefix}completed-without-crash");
        return CompletedWithoutCrashExitCode;
    }
}
