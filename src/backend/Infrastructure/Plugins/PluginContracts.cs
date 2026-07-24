using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.Plugins;

/// <summary>
/// Declares the runtime that owns a plugin entry point.
/// </summary>
public enum PluginRuntimeType
{
    Lua = 0,
    JavaScript = 1
}

/// <summary>
/// Describes the executable portion of a verified plugin package.
/// </summary>
public sealed record PluginRuntimeDescriptor
{
    public required PluginRuntimeType Type
    {
        get;
        init;
    }

    public required string Entry
    {
        get;
        init;
    }
}

/// <summary>
/// Optional administrative UI assets packaged with a plugin.
/// </summary>
public sealed record PluginUiDescriptor
{
    public string? AdminEntry
    {
        get;
        init;
    }

    public string? Style
    {
        get;
        init;
    }
}

/// <summary>
/// Declares one hook without activating or executing it.
/// </summary>
public sealed record PluginHookDescriptor
{
    public required string Name
    {
        get;
        init;
    }

    public int Priority
    {
        get;
        init;
    }

    public int TimeoutMs
    {
        get;
        init;
    }

    public required string FailPolicy
    {
        get;
        init;
    }

    public string ExecutionMode
    {
        get;
        init;
    } = "sync";

    public string Scope
    {
        get;
        init;
    } = "local";

    public bool Idempotent
    {
        get;
        init;
    }
}

/// <summary>
/// Declares the privileged surfaces requested by a plugin package.
/// </summary>
public sealed record PluginPermissionDescriptor
{
    public bool Network
    {
        get;
        init;
    }

    public bool Filesystem
    {
        get;
        init;
    }

    public required string Database
    {
        get;
        init;
    }
}

/// <summary>
/// Stable package manifest contract. Runtime execution and permission grants are
/// intentionally outside this foundation boundary.
/// </summary>
public sealed record PluginManifest
{
    public required string Id
    {
        get;
        init;
    }

    public required string Name
    {
        get;
        init;
    }

    public required string Version
    {
        get;
        init;
    }

    public required string Fsusblog
    {
        get;
        init;
    }

    public required string Author
    {
        get;
        init;
    }

    public required string Description
    {
        get;
        init;
    }

    public required PluginRuntimeDescriptor Runtime
    {
        get;
        init;
    }

    public PluginUiDescriptor? Ui
    {
        get;
        init;
    }

    public IReadOnlyList<PluginHookDescriptor> Hooks
    {
        get;
        init;
    } = [];

    public IReadOnlyList<string> Capabilities
    {
        get;
        init;
    } = [];

    public required PluginPermissionDescriptor Permissions
    {
        get;
        init;
    }

    public required string ConfigSchema
    {
        get;
        init;
    }
}

/// <summary>
/// Immutable verified package snapshot suitable for an atomic Registry install.
/// </summary>
public sealed record PluginConfigSchema(string Path, JsonElement Document);

public sealed record PluginPackage(
    PluginManifest Manifest,
    PluginConfigSchema ConfigSchema,
    byte[] PackageBytes,
    byte[] PackageSha256);

public interface IPluginPackageSignatureVerifier
{
    ValueTask<bool> VerifyAsync(
        PluginManifest manifest,
        ReadOnlyMemory<byte> checksumMetadata,
        ReadOnlyMemory<byte> signature,
        CancellationToken cancellationToken = default);
}

public enum PluginInstallState
{
    Discovered = 0,
    Installed = 1,
    Enabled = 2,
    Disabled = 3,
    Failed = 4,
    Quarantined = 5,
    Uninstalled = 6
}

public enum PluginLifecycleStage
{
    Discover = 0,
    Verify = 1,
    Install = 2,
    ResolveDependencies = 3,
    ValidateManifest = 4,
    PrepareRuntime = 5,
    RegisterHooks = 6,
    Activate = 7,
    Execute = 8,
    Deactivate = 9,
    Uninstall = 10
}

/// <summary>
/// Cluster-visible Registry snapshot. Version is a compare-and-swap coordinate,
/// not the plugin package version.
/// </summary>
public sealed record PluginRegistryEntry(
    PluginManifest Manifest,
    PluginInstallState InstallState,
    bool Enabled,
    byte[] PackageBytes,
    byte[] PackageSha256,
    DateTimeOffset InstalledAtUtc,
    DateTimeOffset UpdatedAtUtc,
    long Version);

public sealed class PluginPackageValidationException(string message, Exception? innerException = null)
    : IOException(message, innerException);

public sealed class PluginLifecycleException(string message) : InvalidOperationException(message);
