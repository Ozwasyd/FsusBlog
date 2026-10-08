using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

public enum GpuNativeBackend
{
    Cuda12,
    Hip6
}

public enum GpuDiscoveryOutcome
{
    Disabled,
    MissingLibrary,
    NoDevice,
    PermissionDenied,
    ApiMismatch,
    UnsupportedPlatform,
    DeviceLimitExceeded,
    DriverFault,
    Discovered
}

/// <summary>Explicit loader inputs; these are not release or runtime qualification.</summary>
public sealed class GpuNativeLoadPolicy
{
    public GpuNativeLoadPolicy(GpuNativeBackend backend, IEnumerable<string> approvedLibraryPaths,
        IEnumerable<int> approvedApiVersions, int maximumDevices)
    {
        if (!Enum.IsDefined(backend))
        {
            throw new ArgumentOutOfRangeException(nameof(backend));
        }
        ArgumentNullException.ThrowIfNull(approvedLibraryPaths);
        ArgumentNullException.ThrowIfNull(approvedApiVersions);
        if (maximumDevices <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumDevices));
        }
        Backend = backend;
        MaximumDevices = maximumDevices;
        string[] paths = approvedLibraryPaths.Distinct(StringComparer.Ordinal).ToArray();
        if (paths.Length == 0 || paths.Any(path => !Path.IsPathFullyQualified(path)
            || !string.Equals(path, Path.GetFullPath(path), StringComparison.Ordinal)))
        {
            throw new ArgumentException("An explicit finite list of canonical absolute library paths is required.");
        }
        int[] versions = approvedApiVersions.Distinct().ToArray();
        if (versions.Length == 0 || versions.Any(version => backend == GpuNativeBackend.Cuda12
                ? version < 12000 || version >= 13000
                : version < 60000000 || version >= 70000000))
        {
            throw new ArgumentException("Exact API versions within the selected ABI profile are required.");
        }
        ApprovedLibraryPaths = Array.AsReadOnly(paths);
        ApprovedApiVersions = Array.AsReadOnly(versions);
    }

    public GpuNativeBackend Backend
    {
        get;
    }
    public int MaximumDevices
    {
        get;
    }
    public IReadOnlyList<string> ApprovedLibraryPaths
    {
        get;
    }
    public IReadOnlyList<int> ApprovedApiVersions
    {
        get;
    }
}

/// <summary>The caller owns discovered sessions. Discovery alone never admits allocation.</summary>
public sealed record GpuNativeDiscoveryResult(GpuDiscoveryOutcome Outcome,
    IReadOnlyList<IGpuDriverSession> Sessions, int? NativeCode = null)
{
    public MemoryQualification Qualification => MemoryQualification.NotVerified;
}

/// <summary>Auto discovery of all devices exposed by the caller-approved CUDA 12 or HIP 6 ABI and loader policy.</summary>
public static class GpuNativeDiscovery
{
    public static GpuNativeDiscoveryResult Discover(MemoryCapabilityMode mode, GpuNativeLoadPolicy policy)
        => Discover(mode, policy, new GpuSystemLibraryLoader());

    internal static GpuNativeDiscoveryResult Discover(MemoryCapabilityMode mode,
        GpuNativeLoadPolicy policy, IGpuNativeLibraryLoader loader)
    {
        MemoryCapabilityPolicy.Validate(mode);
        if (mode == MemoryCapabilityMode.Disabled)
        {
            return new(GpuDiscoveryOutcome.Disabled, Array.Empty<IGpuDriverSession>());
        }
        ArgumentNullException.ThrowIfNull(policy);
        ArgumentNullException.ThrowIfNull(loader);
        // INTEROP: This increment binds the Linux 64-bit ABI only, not an inferred OS matrix.
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture != Architecture.X64)
        {
            return new(GpuDiscoveryOutcome.UnsupportedPlatform, Array.Empty<IGpuDriverSession>());
        }
        foreach (string path in policy.ApprovedLibraryPaths)
        {
            IGpuNativeLibrary? library;
            try
            {
                library = loader.TryLoad(path);
            }
            catch (UnauthorizedAccessException)
            {
                return new(GpuDiscoveryOutcome.PermissionDenied, Array.Empty<IGpuDriverSession>());
            }
            catch (BadImageFormatException)
            {
                return new(GpuDiscoveryOutcome.ApiMismatch, Array.Empty<IGpuDriverSession>());
            }
            if (library is null)
            {
                continue;
            }
            var sessions = new List<IGpuDriverSession>();
            GpuNativeApi? api = null;
            try
            {
                api = policy.Backend == GpuNativeBackend.Cuda12
                    ? new GpuCudaNativeApi(library, policy)
                    : new GpuHipNativeApi(library, policy);
                int count = api.GetDeviceCount();
                if (count > policy.MaximumDevices)
                {
                    api.Release();
                    return new(GpuDiscoveryOutcome.DeviceLimitExceeded, Array.Empty<IGpuDriverSession>());
                }
                for (int ordinal = 0; ordinal < count; ordinal++)
                {
                    sessions.Add(new GpuNativeSession(api, ordinal));
                }
                api.Release();
                return new(count == 0 ? GpuDiscoveryOutcome.NoDevice : GpuDiscoveryOutcome.Discovered,
                    sessions.AsReadOnly());
            }
            catch (GpuDriverException exception)
            {
                foreach (IGpuDriverSession session in sessions)
                {
                    session.Dispose();
                }
                if (api is null)
                {
                    library.Dispose();
                }
                else
                {
                    api.Release();
                }
                return new(exception.NativeCode == 100 ? GpuDiscoveryOutcome.NoDevice
                    : policy.Backend == GpuNativeBackend.Cuda12 && exception.NativeCode == 800
                        ? GpuDiscoveryOutcome.PermissionDenied : GpuDiscoveryOutcome.DriverFault,
                    Array.Empty<IGpuDriverSession>(), exception.NativeCode);
            }
            catch (EntryPointNotFoundException)
            {
                foreach (IGpuDriverSession session in sessions)
                {
                    session.Dispose();
                }
                if (api is null)
                {
                    library.Dispose();
                }
                else
                {
                    api.Release();
                }
                return new(GpuDiscoveryOutcome.ApiMismatch, Array.Empty<IGpuDriverSession>());
            }
        }
        return new(GpuDiscoveryOutcome.MissingLibrary, Array.Empty<IGpuDriverSession>());
    }
}

internal interface IGpuNativeLibraryLoader
{
    IGpuNativeLibrary? TryLoad(string absolutePath);
}

internal interface IGpuNativeLibrary : IDisposable
{
    string AbsolutePath
    {
        get;
    }
    T Bind<T>(string symbol) where T : Delegate;
}

internal sealed class GpuSystemLibraryLoader : IGpuNativeLibraryLoader
{
    public IGpuNativeLibrary? TryLoad(string absolutePath)
    {
        try
        {
            return new Library(absolutePath, NativeLibrary.Load(absolutePath));
        }
        catch (DllNotFoundException)
        {
            return null;
        }
    }

    private sealed class Library(string absolutePath, nint handle) : IGpuNativeLibrary
    {
        private nint _handle = handle;
        public string AbsolutePath => absolutePath;

        public T Bind<T>(string symbol) where T : Delegate
            => Marshal.GetDelegateForFunctionPointer<T>(NativeLibrary.GetExport(_handle, symbol));

        public void Dispose()
        {
            nint owned = Interlocked.Exchange(ref _handle, 0);
            if (owned != 0)
            {
                NativeLibrary.Free(owned);
            }
        }
    }
}
