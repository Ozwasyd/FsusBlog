using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>Exact caller-owned macOS 14 loader/ABI inputs, never a hardware qualification receipt.</summary>
public sealed class GpuMetalLoadPolicy
{
    public GpuMetalLoadPolicy(IEnumerable<string> approvedMetalPaths, IEnumerable<string> approvedObjectiveCPaths,
        IEnumerable<Version> approvedOsVersions, Architecture architecture, int maximumDevices)
    {
        if (architecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new ArgumentOutOfRangeException(nameof(architecture));
        }
        if (maximumDevices <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumDevices));
        }
        ArgumentNullException.ThrowIfNull(approvedOsVersions);
        Version[] versions = approvedOsVersions.Distinct().ToArray();
        if (versions.Length == 0 || versions.Any(version => version is null || version.Major != 14
                || version.Minor < 0 || version.Build < 0 || version.Revision != -1 || version.Build == int.MaxValue))
        {
            throw new ArgumentException("Exact three-component macOS 14 versions are required.", nameof(approvedOsVersions));
        }
        ApprovedMetalPaths = Paths(approvedMetalPaths);
        ApprovedObjectiveCPaths = Paths(approvedObjectiveCPaths);
        ApprovedOsVersions = Array.AsReadOnly(versions);
        Architecture = architecture;
        MaximumDevices = maximumDevices;
    }

    public IReadOnlyList<string> ApprovedMetalPaths
    {
        get;
    }
    public IReadOnlyList<string> ApprovedObjectiveCPaths
    {
        get;
    }
    public IReadOnlyList<Version> ApprovedOsVersions
    {
        get;
    }
    public Architecture Architecture
    {
        get;
    }
    public int MaximumDevices
    {
        get;
    }

    private static IReadOnlyList<string> Paths(IEnumerable<string> source)
    {
        ArgumentNullException.ThrowIfNull(source);
        string[] paths = source.Distinct(StringComparer.Ordinal).ToArray();
        if (paths.Length == 0 || paths.Any(path => string.IsNullOrWhiteSpace(path)
                || !Path.IsPathFullyQualified(path) || path != Path.GetFullPath(path)))
        {
            throw new ArgumentException("A finite list of canonical absolute library paths is required.");
        }
        return Array.AsReadOnly(paths);
    }
}

/// <summary>Enumerates an installed, approved Metal ABI; common qualification/admission owns activation.</summary>
public static class GpuMetalDiscovery
{
    public static GpuNativeDiscoveryResult Discover(MemoryCapabilityMode mode, GpuMetalLoadPolicy policy)
        => Discover(mode, policy, new GpuSystemLibraryLoader());

    internal static GpuNativeDiscoveryResult Discover(MemoryCapabilityMode mode, GpuMetalLoadPolicy policy,
        IGpuNativeLibraryLoader loader)
    {
        MemoryCapabilityPolicy.Validate(mode);
        if (mode == MemoryCapabilityMode.Disabled)
        {
            return new(GpuDiscoveryOutcome.Disabled, Array.Empty<IGpuDriverSession>());
        }
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(loader);
        if (!OperatingSystem.IsMacOS() || RuntimeInformation.ProcessArchitecture != policy.Architecture)
        {
            return new(GpuDiscoveryOutcome.UnsupportedPlatform, Array.Empty<IGpuDriverSession>());
        }
        Version? version = policy.ApprovedOsVersions.SingleOrDefault(value =>
            OperatingSystem.IsMacOSVersionAtLeast(value.Major, value.Minor, value.Build)
            && !OperatingSystem.IsMacOSVersionAtLeast(value.Major, value.Minor, value.Build + 1));
        if (version is null)
        {
            return new(GpuDiscoveryOutcome.ApiMismatch, Array.Empty<IGpuDriverSession>());
        }
        IGpuNativeLibrary? metal = null;
        IGpuNativeLibrary? objectiveC = null;
        GpuMetalNativeApi? api = null;
        var sessions = new List<IGpuDriverSession>();
        bool discovered = false;
        try
        {
            metal = Load(policy.ApprovedMetalPaths, loader);
            if (metal is null)
            {
                return new(GpuDiscoveryOutcome.MissingLibrary, Array.Empty<IGpuDriverSession>());
            }
            objectiveC = Load(policy.ApprovedObjectiveCPaths, loader);
            if (objectiveC is null)
            {
                return new(GpuDiscoveryOutcome.MissingLibrary, Array.Empty<IGpuDriverSession>());
            }
            api = new(metal, objectiveC);
            int count = api.Discover(policy.MaximumDevices);
            for (int index = 0; index < count; index++)
            {
                sessions.Add(new GpuMetalSession(api, api.GetDevice(index), version, policy.Architecture));
            }
            discovered = true;
            return new(count == 0 ? GpuDiscoveryOutcome.NoDevice : GpuDiscoveryOutcome.Discovered,
                sessions.AsReadOnly());
        }
        catch (UnauthorizedAccessException)
        {
            return new(GpuDiscoveryOutcome.PermissionDenied, Array.Empty<IGpuDriverSession>());
        }
        catch (GpuMetalDeviceLimitException)
        {
            return new(GpuDiscoveryOutcome.DeviceLimitExceeded, Array.Empty<IGpuDriverSession>());
        }
        catch (Exception exception) when (exception is EntryPointNotFoundException or BadImageFormatException)
        {
            return new(GpuDiscoveryOutcome.ApiMismatch, Array.Empty<IGpuDriverSession>());
        }
        catch (GpuDriverException exception)
        {
            return new(GpuDiscoveryOutcome.DriverFault, Array.Empty<IGpuDriverSession>(), exception.NativeCode);
        }
        finally
        {
            // Discovery creates managed sessions and native queues before publishing them to a caller.
            // It never requests payload buffers or submits DMA, so failed discovery can release these owners.
            if (api is not null)
            {
                if (!discovered)
                {
                    foreach (IGpuDriverSession session in sessions)
                    {
                        session.Dispose();
                    }
                }
                api.ReleaseReference();
            }
            else
            {
                objectiveC?.Dispose();
                metal?.Dispose();
            }
        }
    }

    private static IGpuNativeLibrary? Load(IReadOnlyList<string> paths, IGpuNativeLibraryLoader loader)
    {
        foreach (string path in paths)
        {
            if (loader.TryLoad(path) is { } library)
            {
                return library;
            }
        }
        return null;
    }
}

internal sealed class GpuMetalDeviceLimitException : Exception;
