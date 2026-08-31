using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers.Initializer;
using FsusBlog.Server.Infrastructure.Observability;
using FsusBlog.Server.Infrastructure.Operations;
using FsusBlog.Server.Infrastructure.PublicAot;
using FsusBlog.Server.Infrastructure.SchemaMigration;
using FsusBlog.Server.Infrastructure.Storage;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Services.Security;

using Microsoft.Extensions.Options;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

public sealed class LifecycleHostedBootstrapService(
    IServiceProvider serviceProvider,
    IWebHostEnvironment environment,
    StartupRuntimeState runtimeState,
    IOptions<LifecycleBootstrapOptions> options,
    ILogger<LifecycleHostedBootstrapService> logger,
    DeploymentRuntimeState? deploymentRuntimeState = null,
    IConfiguration? configuration = null) : IHostedService
{
    private const string SchemaMigrationTask = "schemaMigration";
    private const string AccountSubjectHashInvariantTask = "accountSubjectHashInvariant";
    private const string PasskeyProjectionInvariantTask = "passkeyProjectionInvariant";
    private const string PublicOriginTask = "publicOrigin";
    private const string SearchIndexTask = "searchIndex";
    private const string CacheInitializerTask = "cacheInitializer";
    private const string AotDiskCacheTask = "aotDiskCache";
    private const string BootstrapRollbackTask = "bootstrapRollback";
    private const string BootstrapTask = "bootstrap";

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        var compensations = new Stack<StartupCompensation>();

        try
        {
            await using ObservedAsyncServiceScope scope = DependencyInjectionScopeTelemetry.CreateAsyncScope(
                serviceProvider,
                "lifecycle_bootstrap");
            foreach (StartupTaskStep step in CreateStartupTaskPlan(scope.ServiceProvider))
            {
                StartupTaskOutcome outcome = await RunStartupTaskAsync(step, cancellationToken);
                runtimeState.ReportStartupTask(step.TaskName, outcome.Status, outcome.Detail);

                if (outcome.Compensation is StartupCompensation compensation)
                {
                    compensations.Push(compensation);
                }
            }

            await CleanupCompensationsAsync(compensations, cancellationToken);
            runtimeState.ReportStartupTask(BootstrapRollbackTask, "skipped", "not_needed");

            runtimeState.ReportStartupTask(BootstrapTask, "ok");
            deploymentRuntimeState?.MarkStartupCompleted();
            Console.WriteLine("Hello,world.System Ready (API Engine Mode).");
        }
        catch (Exception ex)
        {
            await RollbackCompensationsAsync(compensations, cancellationToken);
            runtimeState.ReportStartupTask(BootstrapTask, "failed", ex.GetType().Name);
            deploymentRuntimeState?.MarkStartupFailed("bootstrap", "deployment_bootstrap_failed");
            logger.LogCritical(ex, "System Halt.");
            if (ex is CurrentSchemaMismatchException || !environment.IsDevelopment())
            {
                throw;
            }
        }
    }

    public Task StopAsync(CancellationToken cancellationToken)
    {
        return Task.CompletedTask;
    }

    private IEnumerable<StartupTaskStep> CreateStartupTaskPlan(IServiceProvider scopedServices)
    {
        yield return new StartupTaskStep(
            SchemaMigrationTask,
            async cancellationToken =>
            {
                var migrationRunner = scopedServices.GetRequiredService<ISchemaMigrationRunner>();
                await migrationRunner.RunAsync(cancellationToken);
                return StartupTaskOutcome.Ok("current_schema_verified");
            });

        yield return new StartupTaskStep(
            AccountSubjectHashInvariantTask,
            async cancellationToken =>
            {
                var gate = scopedServices.GetRequiredService<IAccountSubjectHashInvariantGate>();
                await gate.EnsureAsync(cancellationToken);
                return StartupTaskOutcome.Ok("physical_projection_complete");
            });

        yield return new StartupTaskStep(
            PasskeyProjectionInvariantTask,
            async cancellationToken =>
            {
                var gate = scopedServices.GetRequiredService<IPasskeyProjectionConsistencyService>();
                await gate.EnsureAsync(cancellationToken);
                return StartupTaskOutcome.Ok("credential_fact_projection_consistent");
            });

        yield return new StartupTaskStep(
            PublicOriginTask,
            async cancellationToken =>
            {
                var systemService = scopedServices.GetRequiredService<ISystemService>();
                var seo = await systemService.GetSeoConfigAsync();
                string origin = PublicOriginPolicy.Resolve(configuration?["Seo:BaseUrl"], seo.BaseUrl);
                cancellationToken.ThrowIfCancellationRequested();
                return StartupTaskOutcome.Ok(origin);
            });

        yield return new StartupTaskStep(
            AotDiskCacheTask,
            _ => Task.FromResult(RunAotDiskCacheTask()));

        yield return new StartupTaskStep(
            SearchIndexTask,
            cancellationToken => RunSearchIndexTaskAsync(scopedServices, cancellationToken));

        yield return new StartupTaskStep(
            CacheInitializerTask,
            async _ =>
            {
                var initializer = scopedServices.GetRequiredService<ICacheInitializer>();
                CacheInitializationResult result = await initializer.InitializeAsync();
                return StartupTaskOutcome.Ok(
                    result.RollbackEntries.Count == 0 ? "no_entries" : $"entries:{result.RollbackEntries.Count}",
                    new StartupCompensation(
                        CacheInitializerTask,
                        () => initializer.RollbackAsync(result, CancellationToken.None),
                        () => Task.CompletedTask));
            });
    }

    private async Task<StartupTaskOutcome> RunStartupTaskAsync(StartupTaskStep task, CancellationToken cancellationToken)
    {
        try
        {
            return await task.ExecuteAsync(cancellationToken);
        }
        catch (Exception ex)
        {
            runtimeState.ReportStartupTask(task.TaskName, "failed", ex.GetType().Name);
            throw;
        }
    }

    private StartupTaskOutcome RunAotDiskCacheTask()
    {
        if (!options.Value.ClearAotDiskCacheOnStartup)
        {
            logger.LogInformation(
                "Skipping AOT disk cache clear on startup because {SettingPath} is disabled.",
                $"{LifecycleBootstrapOptions.SectionName}:{nameof(LifecycleBootstrapOptions.ClearAotDiskCacheOnStartup)}");
            return StartupTaskOutcome.Skipped("disabled");
        }

        string? aotCacheDir = ResolveAotDiskCacheRoot();
        if (string.IsNullOrWhiteSpace(aotCacheDir))
        {
            logger.LogWarning("Skipping AOT disk cache clear because its storage root is unavailable.");
            return StartupTaskOutcome.Skipped("storage_root_unavailable");
        }

        if (!Directory.Exists(aotCacheDir))
        {
            return StartupTaskOutcome.Skipped("directory_missing");
        }

        string backupRoot = ResolveInstanceBackupRoot("aot-cache");
        string backupDir = Path.Combine(backupRoot, Guid.NewGuid().ToString("N"));

        try
        {
            Directory.CreateDirectory(backupRoot);
            Directory.Move(aotCacheDir, backupDir);
            Directory.CreateDirectory(aotCacheDir);
            logger.LogInformation("AOT disk cache cleared to ensure asset consistency.");
            runtimeState.SystemCachesClearedOnStartup = true;

            return StartupTaskOutcome.Ok(
                "cleared",
                new StartupCompensation(
                    AotDiskCacheTask,
                    () =>
                    {
                        RestoreAotDiskCache(aotCacheDir, backupDir);
                        return Task.CompletedTask;
                    },
                    () => DeleteBackupDirectory(backupDir)));
        }
        catch (Exception ex)
        {
            TryRestoreAotDiskCache(aotCacheDir, backupDir);
            logger.LogWarning(ex, "Failed to clear AOT disk cache on startup.");
            return StartupTaskOutcome.Failed(ex.GetType().Name);
        }
    }

    private async Task<StartupTaskOutcome> RunSearchIndexTaskAsync(IServiceProvider scopedServices, CancellationToken cancellationToken)
    {
        var searchCompiler = scopedServices.GetRequiredService<ISearchIndexService>();
        string searchRoot = ResolveSearchIndexRoot();
        bool searchRootExisted = Directory.Exists(searchRoot);
        string backupRoot = ResolveInstanceBackupRoot("search-index");
        string backupDir = Path.Combine(backupRoot, Guid.NewGuid().ToString("N"));

        try
        {
            if (searchRootExisted)
            {
                Directory.CreateDirectory(backupRoot);
                SnapshotDirectory(searchRoot, backupDir);
            }

            cancellationToken.ThrowIfCancellationRequested();
            await searchCompiler.BuildIndexAsync([]);

            bool searchRootExistsNow = Directory.Exists(searchRoot);
            if (!searchRootExisted && !searchRootExistsNow)
            {
                return StartupTaskOutcome.Ok();
            }

            return StartupTaskOutcome.Ok(
                searchRootExisted ? "rebuilt" : "created",
                new StartupCompensation(
                    SearchIndexTask,
                    () =>
                    {
                        RestoreSearchIndexArtifacts(searchRoot, searchRootExisted, backupDir);
                        return Task.CompletedTask;
                    },
                    () => DeleteBackupDirectory(backupDir)));
        }
        catch
        {
            TryRestoreSearchIndexArtifacts(searchRoot, searchRootExisted, backupDir);
            throw;
        }
    }

    private async Task RollbackCompensationsAsync(Stack<StartupCompensation> compensations, CancellationToken cancellationToken)
    {
        if (compensations.Count == 0)
        {
            runtimeState.ReportStartupTask(BootstrapRollbackTask, "skipped", "none_registered");
            return;
        }

        int restoredCount = 0;
        List<string> failures = [];

        while (compensations.Count > 0)
        {
            StartupCompensation compensation = compensations.Pop();
            try
            {
                cancellationToken.ThrowIfCancellationRequested();
                await compensation.RollbackAsync();
                restoredCount++;
            }
            catch (Exception ex)
            {
                failures.Add($"{compensation.TaskName}:{ex.GetType().Name}");
                logger.LogWarning(ex, "Failed to rollback startup task {TaskName}.", compensation.TaskName);
            }
        }

        runtimeState.ReportStartupTask(
            BootstrapRollbackTask,
            failures.Count == 0 ? "ok" : "failed",
            failures.Count == 0 ? $"restored:{restoredCount}" : string.Join(',', failures));
    }

    private static async Task CleanupCompensationsAsync(Stack<StartupCompensation> compensations, CancellationToken cancellationToken)
    {
        while (compensations.Count > 0)
        {
            cancellationToken.ThrowIfCancellationRequested();
            StartupCompensation compensation = compensations.Pop();
            await compensation.CleanupAsync();
        }
    }

    private void RestoreAotDiskCache(string aotCacheDir, string backupDir)
    {
        if (!Directory.Exists(backupDir))
        {
            return;
        }

        if (Directory.Exists(aotCacheDir))
        {
            Directory.Delete(aotCacheDir, true);
        }

        Directory.Move(backupDir, aotCacheDir);
        runtimeState.SystemCachesClearedOnStartup = false;
        runtimeState.ReportStartupTask(AotDiskCacheTask, "rolled_back", "restored_after_failure");
        logger.LogInformation("Restored AOT disk cache because a later startup task failed.");
    }

    private static Task DeleteBackupDirectory(string backupDir)
    {
        if (Directory.Exists(backupDir))
        {
            Directory.Delete(backupDir, true);
        }

        return Task.CompletedTask;
    }

    private static void TryRestoreAotDiskCache(string aotCacheDir, string backupDir)
    {
        if (!Directory.Exists(backupDir))
        {
            return;
        }

        try
        {
            if (Directory.Exists(aotCacheDir))
            {
                Directory.Delete(aotCacheDir, true);
            }

            Directory.Move(backupDir, aotCacheDir);
        }
        catch
        {
            // Preserve the original clear failure; cleanup best-effort only.
        }
    }

    private string ResolveSearchIndexRoot()
    {
        string? derivedRoot = configuration?["ReleaseStorage:DerivedRoot"]
            ?? configuration?["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        string? releaseId = configuration?["FSUSBLOG_RELEASE_ID"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID");
        if (!string.IsNullOrWhiteSpace(derivedRoot) || !string.IsNullOrWhiteSpace(releaseId))
        {
            if (string.IsNullOrWhiteSpace(derivedRoot) || string.IsNullOrWhiteSpace(releaseId))
            {
                throw new InvalidOperationException(
                    "Release-scoped search startup requires both derived root and release identity.");
            }

            return ReleaseStorageLayout.BuildReleaseDerivedPath(derivedRoot, releaseId, "search");
        }

        string root = environment.WebRootPath;
        if (string.IsNullOrWhiteSpace(root))
        {
            root = Path.Combine(AppContext.BaseDirectory, "wwwroot");
        }

        return Path.Combine(root, "search");
    }

    private string? ResolveAotDiskCacheRoot()
    {
        string? derivedRoot = configuration?["ReleaseStorage:DerivedRoot"]
            ?? configuration?["FSUSBLOG_RELEASE_DERIVED_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_DERIVED_ROOT");
        string? releaseId = configuration?["FSUSBLOG_RELEASE_ID"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID");
        if (!string.IsNullOrWhiteSpace(derivedRoot) || !string.IsNullOrWhiteSpace(releaseId))
        {
            if (string.IsNullOrWhiteSpace(derivedRoot) || string.IsNullOrWhiteSpace(releaseId))
            {
                throw new InvalidOperationException(
                    "Release-scoped PublicAOT startup requires both derived root and release identity.");
            }

            return ReleaseStorageLayout.BuildReleaseDerivedPath(derivedRoot, releaseId, "public-aot");
        }

        return string.IsNullOrWhiteSpace(environment.WebRootPath)
            ? null
            : Path.Combine(environment.WebRootPath, "aot-cache");
    }

    private string ResolveInstanceBackupRoot(string kind)
    {
        string slot = NormalizeBackupIdentity(
            configuration?["FSUSBLOG_RELEASE_SLOT"] ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_SLOT"),
            "local");
        string releaseId = NormalizeBackupIdentity(
            configuration?["FSUSBLOG_RELEASE_ID"] ?? Environment.GetEnvironmentVariable("FSUSBLOG_RELEASE_ID"),
            "development");
        return Path.Combine(
            Path.GetTempPath(),
            "fsus-startup-backups",
            slot,
            releaseId,
            Environment.ProcessId.ToString(System.Globalization.CultureInfo.InvariantCulture),
            kind);
    }

    private static string NormalizeBackupIdentity(string? value, string fallback)
    {
        string candidate = string.IsNullOrWhiteSpace(value) ? fallback : value.Trim();
        return candidate.Length is >= 1 and <= 128
            && candidate.All(static character => char.IsAsciiLetterOrDigit(character)
                || character is '.' or '_' or '-')
            ? candidate
            : fallback;
    }

    private void RestoreSearchIndexArtifacts(string searchRoot, bool searchRootExisted, string backupDir)
    {
        if (Directory.Exists(searchRoot))
        {
            Directory.Delete(searchRoot, true);
        }

        if (searchRootExisted)
        {
            if (Directory.Exists(backupDir))
            {
                Directory.Move(backupDir, searchRoot);
            }

            runtimeState.ReportStartupTask(SearchIndexTask, "rolled_back", "restored_after_failure");
            logger.LogInformation("Restored search index artifacts because a later startup task failed.");
            return;
        }

        runtimeState.ReportStartupTask(SearchIndexTask, "rolled_back", "removed_after_failure");
        logger.LogInformation("Removed newly built search index artifacts because a later startup task failed.");
    }

    private static void TryRestoreSearchIndexArtifacts(string searchRoot, bool searchRootExisted, string backupDir)
    {
        try
        {
            if (Directory.Exists(searchRoot))
            {
                Directory.Delete(searchRoot, true);
            }

            if (searchRootExisted && Directory.Exists(backupDir))
            {
                Directory.Move(backupDir, searchRoot);
            }
        }
        catch
        {
            // Preserve the original rebuild failure; cleanup best-effort only.
        }
    }

    private static void SnapshotDirectory(string sourceDir, string destinationDir)
    {
        Directory.CreateDirectory(destinationDir);

        foreach (string directory in Directory.GetDirectories(sourceDir, "*", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(sourceDir, directory);
            Directory.CreateDirectory(Path.Combine(destinationDir, relative));
        }

        foreach (string file in Directory.GetFiles(sourceDir, "*", SearchOption.AllDirectories))
        {
            string relative = Path.GetRelativePath(sourceDir, file);
            string target = Path.Combine(destinationDir, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            TryCreateHardLinkSnapshot(file, target);
        }
    }

    private static void TryCreateHardLinkSnapshot(string sourceFile, string targetFile)
    {
        if (TryCreateHardLink(sourceFile, targetFile))
        {
            return;
        }

        File.Copy(sourceFile, targetFile, overwrite: true);
    }

    private static bool TryCreateHardLink(string sourceFile, string targetFile)
    {
        if (!OperatingSystem.IsLinux())
        {
            return false;
        }

        try
        {
            return Link(sourceFile, targetFile) == 0;
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            return false;
        }
    }

    [DllImport("libc", EntryPoint = "link", SetLastError = true)]
    private static extern int Link(string oldpath, string newpath);

    private readonly record struct StartupCompensation(
        string TaskName,
        Func<Task> RollbackAsync,
        Func<Task> CleanupAsync);

    private readonly record struct StartupTaskStep(
        string TaskName,
        Func<CancellationToken, Task<StartupTaskOutcome>> ExecuteAsync);

    private readonly record struct StartupTaskOutcome(
        string Status,
        string? Detail,
        StartupCompensation? Compensation)
    {
        public static StartupTaskOutcome Ok(string? detail = null, StartupCompensation? compensation = null)
            => new("ok", detail, compensation);

        public static StartupTaskOutcome Skipped(string detail)
            => new("skipped", detail, null);

        public static StartupTaskOutcome Failed(string detail)
            => new("failed", detail, null);
    }
}
