using System.Collections.Immutable;
using System.Runtime.Versioning;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Microsoft.Extensions.DependencyInjection.Extensions;

namespace FsusBlog.Server.Infrastructure.Bootstrap;

internal static class AuthoringExtensionHostServiceCollectionExtensions
{
    private static readonly AuthoringHostPlatform s_platform = AuthoringHostPlatform.ServerLinux;

    public static IServiceCollection AddAuthoringExtensionHost(
        this IServiceCollection services,
        IConfiguration configuration)
    {
        ArgumentNullException.ThrowIfNull(services);
        ArgumentNullException.ThrowIfNull(configuration);
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The authoring extension host requires Linux isolation authorities.");
        }

        string root = ResolveOwnedRoot(configuration);
        services.TryAddSingleton<TimeProvider>(TimeProvider.System);

        AddPackageAuthority(services, root);
        AddExecutionAuthority(services);
        AddStateAndLifecycleAuthority(services, root);
        AddRuntimeAuthority(services, configuration, root);
        AddCommandAuthority(services);
        AddBrokerAuthority(services, root);
        return services;
    }

    private static void AddPackageAuthority(IServiceCollection services, string root)
    {
        services.TryAddSingleton<LocalAuthoringPackageKeyset>(
            static _ => new LocalAuthoringPackageKeyset([]));
        services.TryAddSingleton<IAuthoringPackageKeyset>(
            static provider => provider.GetRequiredService<LocalAuthoringPackageKeyset>());
        services.TryAddSingleton<LocalApprovedAuthoringPackageSourceFetcher>(
            static _ => new LocalApprovedAuthoringPackageSourceFetcher([]));
        services.TryAddSingleton<IAuthoringPackageSourceFetcher>(
            static provider => provider.GetRequiredService<LocalApprovedAuthoringPackageSourceFetcher>());
        services.TryAddSingleton<EcdsaAuthoringPackageTrustVerifier>();
        services.TryAddSingleton<IAuthoringPackageTrustVerifier>(
            static provider => provider.GetRequiredService<EcdsaAuthoringPackageTrustVerifier>());
        services.TryAddSingleton<ZipAuthoringPackageArchiveReader>();
        services.TryAddSingleton<IAuthoringPackageArchiveReader>(
            static provider => provider.GetRequiredService<ZipAuthoringPackageArchiveReader>());
        services.TryAddSingleton<AuthoringPackageVerifier>();
        services.TryAddSingleton(provider => new LocalAuthoringPackageStore(
            Path.Combine(root, "packages"),
            provider.GetRequiredService<AuthoringPackageVerifier>(),
            s_platform));
        services.TryAddSingleton<IAuthoringPackageStore>(
            static provider => provider.GetRequiredService<LocalAuthoringPackageStore>());
        services.TryAddSingleton<IAuthoringPackageRecoveryStore>(
            static provider => provider.GetRequiredService<LocalAuthoringPackageStore>());
        services.TryAddSingleton(
            _ => new LocalAuthoringPackageReceiptStore(Path.Combine(root, "package-receipts")));
        services.TryAddSingleton<IAuthoringPackageReceiptStore>(
            static provider => provider.GetRequiredService<LocalAuthoringPackageReceiptStore>());
        services.TryAddSingleton(provider => new AuthoringPackageIntegrityHealthProbe(
            provider.GetRequiredService<AuthoringPackageVerifier>(),
            s_platform));
        services.TryAddSingleton<IAuthoringPackageHealthProbe>(
            static provider => provider.GetRequiredService<AuthoringPackageIntegrityHealthProbe>());
        services.TryAddSingleton<AuthoringPackageActivationCoordinator>();
        services.TryAddSingleton(provider => new AuthoringPackageProductionActivation(
            provider.GetRequiredService<AuthoringPackageVerifier>(),
            provider.GetRequiredService<AuthoringPackageActivationCoordinator>(),
            provider.GetRequiredService<LocalAuthoringPackageStore>(),
            provider.GetRequiredService<LocalAuthoringPackageStore>(),
            provider.GetRequiredService<LocalAuthoringPackageReceiptStore>(),
            provider.GetRequiredService<AuthoringPackageIntegrityHealthProbe>(),
            provider.GetRequiredService<TimeProvider>(),
            s_platform,
            provider.GetRequiredService<IAuthoringPackageSourceFetcher>()));
    }

    private static void AddExecutionAuthority(IServiceCollection services)
    {
        services.TryAddSingleton(
            static _ => new ClosedTrustedAuthoringAdapterRegistry([]));
        services.TryAddSingleton<ITrustedAuthoringAdapterRegistry>(
            static provider => provider.GetRequiredService<ClosedTrustedAuthoringAdapterRegistry>());
        services.TryAddSingleton<ITrustedAuthoringAdapterModuleVerifier>(
            static _ => new RejectingTrustedAuthoringAdapterModuleVerifier());
        services.TryAddSingleton<AuthoringExecutionResolver>();
    }

    private static void AddStateAndLifecycleAuthority(IServiceCollection services, string root)
    {
        services.TryAddSingleton(provider => new LocalAuthoringCapabilityGrantStore(
            Path.Combine(root, "capability-grants"),
            provider.GetRequiredService<TimeProvider>()));
        services.TryAddSingleton<IAuthoringCapabilityGrantStore>(
            static provider => provider.GetRequiredService<LocalAuthoringCapabilityGrantStore>());
        services.TryAddSingleton<IAuthoringCapabilityGrantCatalog>(
            static provider => provider.GetRequiredService<LocalAuthoringCapabilityGrantStore>());
        services.TryAddSingleton<AuthoringCapabilityGrantAuthority>();

        services.TryAddSingleton(
            _ => new LocalAuthoringLifecycleReceiptStore(Path.Combine(root, "lifecycle-receipts")));
        services.TryAddSingleton<IAuthoringLifecycleReceiptStore>(
            static provider => provider.GetRequiredService<LocalAuthoringLifecycleReceiptStore>());
        services.TryAddSingleton(
            _ => new LocalAuthoringExtensionStateStore(Path.Combine(root, "state")));
        services.TryAddSingleton<IAuthoringExtensionStateStore>(
            static provider => provider.GetRequiredService<LocalAuthoringExtensionStateStore>());
        services.TryAddSingleton<IAuthoringExtensionStateAuthority>(
            static provider => provider.GetRequiredService<LocalAuthoringExtensionStateStore>());

        services.TryAddSingleton<FsusUiAuthoringDocumentAuthority>();
        services.TryAddSingleton<IAuthoringDocumentSessionAuthority>(
            static provider => provider.GetRequiredService<FsusUiAuthoringDocumentAuthority>());
        services.TryAddSingleton<IAuthoringDocumentRevisionGate>(
            static provider => provider.GetRequiredService<FsusUiAuthoringDocumentAuthority>());
        services.TryAddSingleton<IAuthoringCanonicalDocumentTransaction>(
            static provider => provider.GetRequiredService<FsusUiAuthoringDocumentAuthority>());
        services.TryAddSingleton<IAuthoringCoreContinuityProbe>(
            static provider => provider.GetRequiredService<FsusUiAuthoringDocumentAuthority>());

        services.TryAddSingleton<LocalAuthoringLifecyclePreflight>();
        services.TryAddSingleton<IAuthoringLifecyclePreflight>(
            static provider => provider.GetRequiredService<LocalAuthoringLifecyclePreflight>());
        services.TryAddSingleton<IAuthoringLifecyclePermissionPreflight>(
            static provider => provider.GetRequiredService<LocalAuthoringLifecyclePreflight>());
        services.TryAddSingleton<IAuthoringCommandContributionSource, VerifiedPackageAuthoringCommandSource>();
        services.TryAddSingleton(provider => new AuthoringCommandRegistryAuthority(
            provider.GetRequiredService<IAuthoringCommandContributionSource>(),
            ImmutableHashSet<string>.Empty.WithComparer(StringComparer.Ordinal),
            ImmutableHashSet<string>.Empty.WithComparer(StringComparer.OrdinalIgnoreCase)));
        services.TryAddSingleton<LocalAuthoringLifecycleHostResourceAuthority>();
        services.TryAddSingleton<IAuthoringLifecycleHostResourceAuthority>(
            static provider => provider.GetRequiredService<LocalAuthoringLifecycleHostResourceAuthority>());
        services.TryAddSingleton<IAuthoringActiveRuntimeCatalog>(
            static provider => provider.GetRequiredService<LocalAuthoringLifecycleHostResourceAuthority>());
        services.TryAddSingleton<AuthoringExtensionLifecycleResources>();
        services.TryAddSingleton<IAuthoringLifecycleResourceAuthority>(
            static provider => provider.GetRequiredService<AuthoringExtensionLifecycleResources>());
        services.TryAddSingleton<AuthoringLifecycleBudgetContainment>();
        services.TryAddSingleton<IAuthoringExtensionContainment>(
            static provider => provider.GetRequiredService<AuthoringLifecycleBudgetContainment>());
        services.TryAddSingleton<AuthoringExtensionLifecycleCoordinator>();
    }

    [SupportedOSPlatform("linux")]
    private static void AddRuntimeAuthority(
        IServiceCollection services,
        IConfiguration configuration,
        string root)
    {
        services.TryAddSingleton<LinuxProcAuthoringResourceMeasurementSource>();
        services.TryAddSingleton<IAuthoringResourceMeasurementSource>(
            static provider => provider.GetRequiredService<LinuxProcAuthoringResourceMeasurementSource>());
        services.TryAddSingleton<IAuthoringRuntimeResourceLedger>(
            static provider => provider.GetRequiredService<LinuxProcAuthoringResourceMeasurementSource>());
        services.TryAddSingleton(
            _ => new LocalAuthoringBudgetTelemetrySink(Path.Combine(root, "telemetry")));
        services.TryAddSingleton<IAuthoringBudgetTelemetrySink>(
            static provider => provider.GetRequiredService<LocalAuthoringBudgetTelemetrySink>());
        services.TryAddSingleton<AuthoringExtensionBudgetSupervisor>();

        services.TryAddSingleton(_ => new LinuxBubblewrapWorkerOptions(
            ResolveExecutable(configuration, "AuthoringExtensions:Runtime:BubblewrapPath", "/usr/bin/bwrap"),
            ResolveExecutable(
                configuration,
                "AuthoringExtensions:Runtime:NodePath",
                "/usr/bin/node",
                "/usr/local/bin/node"),
            ResolveDirectory(
                configuration,
                "AuthoringExtensions:Runtime:LibraryRoot",
                "/usr/lib/x86_64-linux-gnu"),
            ResolveExecutable(
                configuration,
                "AuthoringExtensions:Runtime:DynamicLoaderPath",
                "/lib64/ld-linux-x86-64.so.2",
                "/lib/x86_64-linux-gnu/ld-linux-x86-64.so.2"),
            Path.Combine(root, "runtime", "workers"),
            TimeSpan.FromSeconds(10)));
        services.TryAddSingleton<LinuxBubblewrapAuthoringWorkerRuntime>();
        services.TryAddSingleton<MeasuredAuthoringWorkerRuntime>();
        services.TryAddSingleton<IAuthoringWorkerSandboxRuntime>(
            static provider => provider.GetRequiredService<MeasuredAuthoringWorkerRuntime>());
        services.TryAddSingleton<AuthoringExtensionWorkerSandbox>();

        services.TryAddSingleton(_ => new LinuxBubblewrapServiceOptions(
            ResolveExecutable(configuration, "AuthoringExtensions:Runtime:PrlimitPath", "/usr/bin/prlimit"),
            ResolveExecutable(configuration, "AuthoringExtensions:Runtime:BubblewrapPath", "/usr/bin/bwrap"),
            Path.Combine(root, "runtime", "services"),
            TimeSpan.FromSeconds(10)));
        services.TryAddSingleton<LinuxBubblewrapAuthoringServiceRuntime>();
        services.TryAddSingleton<MeasuredAuthoringServiceRuntime>();
        services.TryAddSingleton<IAuthoringServiceProcessRuntime>(
            static provider => provider.GetRequiredService<MeasuredAuthoringServiceRuntime>());
        services.TryAddSingleton<AuthoringExtensionServiceBroker>();
    }

    private static void AddCommandAuthority(IServiceCollection services)
    {
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IAuthoringCommandExecutionPort,
            AuthoringWorkerCommandExecutionPort>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IAuthoringCommandExecutionPort,
            AuthoringServiceCommandExecutionPort>());
        services.TryAddSingleton(provider => new AuthoringCommandExecutionCoordinator(
            [.. provider.GetServices<IAuthoringCommandExecutionPort>()],
            provider.GetRequiredService<IAuthoringDocumentRevisionGate>(),
            provider.GetRequiredService<AuthoringExtensionLifecycleCoordinator>(),
            provider.GetRequiredService<IAuthoringCapabilityGrantCatalog>(),
            provider.GetRequiredService<TimeProvider>()));
        services.TryAddSingleton<AuthoringExtensionRpcAuthority>();
        services.TryAddSingleton<AuthoringCommandTransactionAdapter>();
    }

    [SupportedOSPlatform("linux")]
    private static void AddBrokerAuthority(IServiceCollection services, string root)
    {
        services.TryAddSingleton<IAuthoringNetworkAddressResolver, DnsAuthoringNetworkAddressResolver>();
        services.TryAddSingleton<IAuthoringFilePathVerifier, LinuxAuthoringFilePathVerifier>();
        services.TryAddSingleton<IAuthoringPinnedNetworkTransport, PinnedHttpsAuthoringNetworkTransport>();
        services.TryAddSingleton(provider => new AuthoringServiceGrantValidator(
            provider.GetRequiredService<IAuthoringNetworkAddressResolver>(),
            provider.GetRequiredService<IAuthoringFilePathVerifier>(),
            provider.GetRequiredService<TimeProvider>(),
            ImmutableHashSet<string>.Empty.WithComparer(StringComparer.Ordinal)));
        services.TryAddSingleton(provider => new AuthoringExtensionServiceIoBroker(
            provider.GetRequiredService<AuthoringServiceGrantValidator>(),
            provider.GetRequiredService<IAuthoringPinnedNetworkTransport>(),
            Path.Combine(root, "broker", "proposed-writes"),
            provider.GetRequiredService<IAuthoringRuntimeResourceLedger>()));
    }

    private static string ResolveOwnedRoot(IConfiguration configuration)
    {
        string dataRoot = configuration["FSUSBLOG_DATA_ROOT"]
            ?? Environment.GetEnvironmentVariable("FSUSBLOG_DATA_ROOT")
            ?? Path.Combine(AppContext.BaseDirectory, "data");
        return Path.Combine(Path.GetFullPath(dataRoot), "authoring-extensions");
    }

    private static string ResolveExecutable(
        IConfiguration configuration,
        string key,
        params string[] defaults)
    {
        string? configured = configuration[key];
        if (!string.IsNullOrWhiteSpace(configured))
        {
            return Path.GetFullPath(configured);
        }

        return defaults.FirstOrDefault(File.Exists) ?? defaults[0];
    }

    private static string ResolveDirectory(
        IConfiguration configuration,
        string key,
        string defaultPath)
    {
        string? configured = configuration[key];
        return Path.GetFullPath(string.IsNullOrWhiteSpace(configured) ? defaultPath : configured);
    }

    private sealed class RejectingTrustedAuthoringAdapterModuleVerifier :
        ITrustedAuthoringAdapterModuleVerifier
    {
        public ValueTask<bool> IsLoadedModuleExactAsync(
            TrustedAuthoringAdapterDescriptor descriptor,
            CancellationToken cancellationToken)
        {
            cancellationToken.ThrowIfCancellationRequested();
            return ValueTask.FromResult(false);
        }
    }
}
