using System.Diagnostics;
using System.Diagnostics.CodeAnalysis;
using System.Runtime.CompilerServices;
using System.Runtime.Versioning;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public interface IAuthoringMeasuredRuntimeInstance
{
    string RuntimeIdentity { get; }

    int ProcessId { get; }
}

/// <summary>
/// A process-local capability issued only for the original native runtime owner after readiness
/// and isolation observation. Reference identity, original descriptor and retained process custody
/// are authoritative; RuntimeIdentity and profile digests remain descriptive wire identities.
/// This capability does not attest lifecycle generation or coordinator Running approval.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class AuthoringRuntimeIncarnationLease
{
    private static readonly ConditionalWeakTable<object, AuthoringRuntimeIncarnationLease> s_owners = new();
    private readonly Lock _lock = new();
    private readonly object _descriptor;
    private readonly object _authority;
    private readonly ulong _startTicks;
    private readonly object _owner;
    private Process? _custody;
    private Process? _sandbox;
    private bool _active = true;
    private bool _custodyRetained = true;

    private AuthoringRuntimeIncarnationLease(
        object owner,
        object descriptor,
        object authority,
        Process custody,
        Process sandbox,
        ulong startTicks,
        string runtimeIdentity,
        string profileIdentity)
    {
        _owner = owner;
        _descriptor = descriptor;
        _authority = authority;
        _custody = custody;
        _sandbox = sandbox;
        _startTicks = startTicks;
        RuntimeIdentity = runtimeIdentity;
        RuntimeProfileSha256 = profileIdentity;
        ProcessId = sandbox.Id;
    }

    public string RuntimeIdentity { get; }

    public string RuntimeProfileSha256 { get; }

    public int ProcessId { get; }

    /// <summary>Remains true after revocation until termination, transport settlement and disposal succeed.</summary>
    public bool CustodyRetained
    {
        get
        {
            lock (_lock)
            {
                return _custodyRetained;
            }
        }
    }

    /// <summary>Reads the capability from the exact native owner tracked by the resource authority.</summary>
    public static bool TryObserveWorker(
        IAuthoringWorkerSandboxInstance owner,
        [NotNullWhen(true)] out AuthoringRuntimeIncarnationLease? incarnation) =>
        TryObserveOwned(owner, out incarnation) && incarnation._descriptor is AuthoringWorkerLaunchDescriptor;

    /// <summary>Reads the capability from the exact native owner tracked by the resource authority.</summary>
    public static bool TryObserveService(
        IAuthoringServiceProcess owner,
        [NotNullWhen(true)] out AuthoringRuntimeIncarnationLease? incarnation) =>
        TryObserveOwned(owner, out incarnation) && incarnation._descriptor is AuthoringServiceLaunchDescriptor;

    /// <summary>Returns the original launch descriptor only while the exact worker owner remains live.</summary>
    public AuthoringWorkerLaunchDescriptor GetWorkerDescriptor(IAuthoringWorkerSandboxInstance owner) =>
        WithCurrentOwner(owner, _ => _descriptor as AuthoringWorkerLaunchDescriptor ??
            throw new AuthoringExtensionContractException("Incarnation is not a worker owner."));

    /// <summary>Returns the original launch descriptor only while the exact service owner remains live.</summary>
    public AuthoringServiceLaunchDescriptor GetServiceDescriptor(IAuthoringServiceProcess owner) =>
        WithCurrentOwner(owner, _ => _descriptor as AuthoringServiceLaunchDescriptor ??
            throw new AuthoringExtensionContractException("Incarnation is not a service owner."));

    private static bool TryObserveOwned(
        object owner,
        [NotNullWhen(true)] out AuthoringRuntimeIncarnationLease? incarnation)
    {
        incarnation = null;
        if (owner is null || !s_owners.TryGetValue(owner, out AuthoringRuntimeIncarnationLease? issued) ||
            !issued.IsCurrentOwner(owner))
        {
            return false;
        }

        incarnation = issued;
        return true;
    }

    /// <summary>Accepts only the exact runtime-returned owner and its original descriptor reference.</summary>
    public static bool TryObserveWorker(
        IAuthoringWorkerSandboxInstance owner,
        AuthoringWorkerLaunchDescriptor descriptor,
        [NotNullWhen(true)] out AuthoringRuntimeIncarnationLease? incarnation) =>
        TryObserve(owner, descriptor, out incarnation);

    /// <summary>Accepts only the exact runtime-returned owner and its original descriptor reference.</summary>
    public static bool TryObserveService(
        IAuthoringServiceProcess owner,
        AuthoringServiceLaunchDescriptor descriptor,
        [NotNullWhen(true)] out AuthoringRuntimeIncarnationLease? incarnation) =>
        TryObserve(owner, descriptor, out incarnation);

    private static bool TryObserve(
        object owner,
        object descriptor,
        out AuthoringRuntimeIncarnationLease? incarnation)
    {
        incarnation = null;
        if (owner is null || !s_owners.TryGetValue(owner, out AuthoringRuntimeIncarnationLease? issued))
        {
            return false;
        }

        lock (issued._lock)
        {
            if (!ReferenceEquals(issued._descriptor, descriptor) || !issued.IsCurrentOwner(owner))
            {
                return false;
            }

            incarnation = issued;
            return true;
        }
    }

    /// <summary>Rejects copied leases, forwarding wrappers, PID reuse and every revoked incarnation.</summary>
    public bool IsCurrentOwner(object owner)
    {
        lock (_lock)
        {
            if (!_active || !ReferenceEquals(_owner, owner) ||
                !s_owners.TryGetValue(owner, out AuthoringRuntimeIncarnationLease? issued) ||
                !ReferenceEquals(this, issued))
            {
                return false;
            }

            try
            {
                if (_custody!.HasExited || _sandbox!.HasExited || ReadStartTicks(ProcessId) != _startTicks)
                {
                    _active = false;
                }
            }
            catch (Exception exception) when (exception is
                ArgumentException or InvalidOperationException or IOException or UnauthorizedAccessException or
                AuthoringExtensionContractException)
            {
                _active = false;
            }

            return _active;
        }
    }

    internal static AuthoringRuntimeIncarnationLease Issue(
        object owner,
        object descriptor,
        object authority,
        Process custody,
        Process sandbox,
        ulong observedStartTicks,
        string profileIdentity)
    {
        int processId = sandbox.Id;
        if (!LinuxBubblewrapAuthoringWorkerRuntime.OwnsNativeCustody(
                owner, descriptor, authority, custody, sandbox, observedStartTicks, profileIdentity) &&
            !LinuxBubblewrapAuthoringServiceRuntime.OwnsNativeCustody(
                owner, descriptor, authority, custody, sandbox, observedStartTicks, profileIdentity))
        {
            throw new AuthoringExtensionContractException("Only a native runtime owner can issue an incarnation.");
        }

        string runtimeIdentity = descriptor switch
        {
            AuthoringWorkerLaunchDescriptor worker => worker.RuntimeIdentity,
            AuthoringServiceLaunchDescriptor service => service.RuntimeIdentity,
            _ => throw new AuthoringExtensionContractException("Native runtime descriptor is unavailable.")
        };
        var incarnation = new AuthoringRuntimeIncarnationLease(
            owner, descriptor, authority, custody, sandbox, observedStartTicks, runtimeIdentity, profileIdentity);
        if (custody.HasExited || sandbox.HasExited || ReadStartTicks(processId) != observedStartTicks)
        {
            throw new AuthoringExtensionContractException("Native runtime exited before incarnation issuance.");
        }

        s_owners.Add(owner, incarnation);
        return incarnation;
    }

    internal T WithCurrentOwner<T>(object owner, Func<Process, T> observe)
    {
        lock (_lock)
        {
            if (!IsCurrentOwner(owner))
            {
                throw new AuthoringExtensionContractException("Runtime incarnation is foreign, ended or revoked.");
            }

            T result = observe(_sandbox!);
            if (!IsCurrentOwner(owner))
            {
                throw new AuthoringExtensionContractException("Runtime incarnation ended during observation.");
            }

            return result;
        }
    }

    internal void Revoke(object owner, object authority)
    {
        lock (_lock)
        {
            RequireAuthority(owner, authority);
            _active = false;
        }
    }

    internal void ConfirmProcessExited(object owner, object authority)
    {
        lock (_lock)
        {
            RequireAuthority(owner, authority);
            if (_sandbox is not null && !_sandbox.HasExited)
            {
                throw new AuthoringExtensionContractException("Native sandbox has not settled after termination.");
            }
        }
    }

    internal void ReleaseCustody(object owner, object authority)
    {
        lock (_lock)
        {
            RequireAuthority(owner, authority);
            _active = false;
            _sandbox?.Dispose();
            _sandbox = null;
            _custody = null;
            _custodyRetained = false;
        }
    }

    private void RequireAuthority(object owner, object authority)
    {
        if (!ReferenceEquals(_authority, authority) || !ReferenceEquals(_owner, owner) ||
            !s_owners.TryGetValue(_owner, out AuthoringRuntimeIncarnationLease? issued) ||
            !ReferenceEquals(this, issued))
        {
            throw new AuthoringExtensionContractException("Only the native custody owner can settle an incarnation.");
        }
    }

    internal static ulong ReadStartTicks(int processId)
    {
        string stat = File.ReadAllText($"/proc/{processId}/stat");
        int commandEnd = stat.LastIndexOf(')');
        if (commandEnd < 0)
        {
            throw new AuthoringExtensionContractException("Native process birth observation is unavailable.");
        }

        string[] fields = stat[(commandEnd + 2)..].Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (fields.Length <= 19 || fields[0] is "Z" or "X")
        {
            throw new AuthoringExtensionContractException("Native process birth observation is unavailable.");
        }

        return ulong.Parse(fields[19], System.Globalization.CultureInfo.InvariantCulture);
    }
}

/// <summary>Registration requires a native incarnation; legacy scalar operations cannot confer authority.</summary>
public interface IAuthoringRuntimeResourceLedger
{
    void Register(object owner, AuthoringRuntimeIncarnationLease incarnation) =>
        throw new AuthoringExtensionContractException("Ledger cannot join native runtime incarnations.");

    void Register(string runtimeIdentity, int processId);

    void Unregister(string runtimeIdentity, int processId);

    void RecordRestart(string runtimeIdentity);

    void RecordBrokeredUsage(string runtimeIdentity, long networkBytes, long fileBytes, long stateBytes);
}

[SupportedOSPlatform("linux")]
public sealed class LinuxProcAuthoringResourceMeasurementSource :
    IAuthoringResourceMeasurementSource,
    IAuthoringRuntimeResourceLedger
{
    private readonly ConditionalWeakTable<AuthoringRuntimeIncarnationLease, Entry> _entries = new();

    public void Register(object owner, AuthoringRuntimeIncarnationLease incarnation) =>
        incarnation.WithCurrentOwner(owner, _ => _entries.GetValue(incarnation, static _ => new Entry()));

    public void Register(string runtimeIdentity, int processId) => throw MissingIncarnation();

    public void Unregister(string runtimeIdentity, int processId) => throw MissingIncarnation();

    public void RecordRestart(string runtimeIdentity) => throw MissingIncarnation();

    public void RecordBrokeredUsage(string runtimeIdentity, long networkBytes, long fileBytes, long stateBytes) =>
        throw MissingIncarnation();

    /// <summary>A string-only budget consumer remains closed until its owner joins the incarnation and generation.</summary>
    public ValueTask<AuthoringResourceMeasurement> MeasureAsync(
        AuthoringBudgetIdentity identity,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        throw MissingIncarnation();
    }

    /// <summary>Samples one native incarnation; lifecycle generation admission belongs to the resource/coordinator owners.</summary>
    public ValueTask<AuthoringResourceMeasurement> MeasureAsync(
        AuthoringBudgetIdentity identity,
        object owner,
        AuthoringRuntimeIncarnationLease incarnation,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!string.Equals(identity.RuntimeIdentity, incarnation.RuntimeIdentity, StringComparison.Ordinal))
        {
            throw MissingIncarnation();
        }

        return ValueTask.FromResult(incarnation.WithCurrentOwner(owner, process =>
            GetEntry(incarnation).Measure(process)));
    }

    public void RecordBrokeredUsage(
        object owner,
        AuthoringRuntimeIncarnationLease incarnation,
        long networkBytes,
        long fileBytes,
        long stateBytes)
    {
        if (networkBytes < 0 || fileBytes < 0 || stateBytes < 0)
        {
            throw new AuthoringExtensionContractException("Runtime resource usage cannot be negative.");
        }

        incarnation.WithCurrentOwner(owner, _ =>
        {
            GetEntry(incarnation).RecordBrokeredUsage(networkBytes, fileBytes, stateBytes);
            return true;
        });
    }

    private Entry GetEntry(AuthoringRuntimeIncarnationLease incarnation) =>
        _entries.TryGetValue(incarnation, out Entry? entry) ? entry : throw MissingIncarnation();

    private static AuthoringExtensionContractException MissingIncarnation() =>
        new("Runtime measurement requires the original native owner and incarnation capability.");

    private sealed class Entry
    {
        private TimeSpan _cpu;
        private long _inbound;
        private long _outbound;
        private long _networkBytes;
        private long _fileBytes;
        private long _stateBytes;

        public void RecordBrokeredUsage(long networkBytes, long fileBytes, long stateBytes)
        {
            long nextNetwork = checked(_networkBytes + networkBytes);
            long nextFile = checked(_fileBytes + fileBytes);
            _networkBytes = nextNetwork;
            _fileBytes = nextFile;
            _stateBytes = Math.Max(_stateBytes, stateBytes);
        }

        public AuthoringResourceMeasurement Measure(Process process)
        {
            process.Refresh();
            TimeSpan cpu = process.TotalProcessorTime;
            (long inbound, long outbound) = ReadIo(process.Id);
            if (cpu < _cpu || inbound < _inbound || outbound < _outbound)
            {
                throw new AuthoringExtensionContractException("Native incarnation resource counters regressed.");
            }

            _cpu = cpu;
            _inbound = inbound;
            _outbound = outbound;
            return new AuthoringResourceMeasurement(
                cpu, process.WorkingSet64, inbound, outbound, 0, _networkBytes, _fileBytes, _stateBytes);
        }

        private static (long Inbound, long Outbound) ReadIo(int processId)
        {
            long? inbound = null;
            long? outbound = null;
            foreach (string line in File.ReadLines($"/proc/{processId}/io"))
            {
                if (line.StartsWith("rchar: ", StringComparison.Ordinal))
                {
                    inbound = long.Parse(line.AsSpan(7), System.Globalization.CultureInfo.InvariantCulture);
                }
                else if (line.StartsWith("wchar: ", StringComparison.Ordinal))
                {
                    outbound = long.Parse(line.AsSpan(7), System.Globalization.CultureInfo.InvariantCulture);
                }
            }

            return (inbound ?? throw MissingIncarnation(), outbound ?? throw MissingIncarnation());
        }
    }
}

[SupportedOSPlatform("linux")]
public sealed class MeasuredAuthoringWorkerRuntime(
    LinuxBubblewrapAuthoringWorkerRuntime inner,
    IAuthoringRuntimeResourceLedger ledger) : IAuthoringWorkerSandboxRuntime
{
    public async ValueTask<IAuthoringWorkerSandboxInstance> StartAsync(
        AuthoringWorkerLaunchDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        IAuthoringWorkerSandboxInstance instance = await inner.StartAsync(descriptor, cancellationToken);
        if (!AuthoringRuntimeIncarnationLease.TryObserveWorker(instance, descriptor, out AuthoringRuntimeIncarnationLease? incarnation))
        {
            await instance.TerminateAsync("measurement-authority-missing", CancellationToken.None);
            await instance.DisposeAsync();
            throw new AuthoringExtensionContractException(
                "Worker runtime has no process measurement authority.");
        }

        try
        {
            ledger.Register(instance, incarnation!);
        }
        catch
        {
            await instance.TerminateAsync("measurement-registration-failed", CancellationToken.None);
            await instance.DisposeAsync();
            throw;
        }
        return instance;
    }

}

[SupportedOSPlatform("linux")]
public sealed class MeasuredAuthoringServiceRuntime(
    LinuxBubblewrapAuthoringServiceRuntime inner,
    IAuthoringRuntimeResourceLedger ledger) : IAuthoringServiceProcessRuntime
{
    public async ValueTask<IAuthoringServiceProcess> StartAsync(
        AuthoringServiceLaunchDescriptor descriptor,
        CancellationToken cancellationToken)
    {
        IAuthoringServiceProcess process = await inner.StartAsync(descriptor, cancellationToken);
        if (!AuthoringRuntimeIncarnationLease.TryObserveService(process, descriptor, out AuthoringRuntimeIncarnationLease? incarnation))
        {
            await process.TerminateTreeAsync("measurement-authority-missing", CancellationToken.None);
            await process.DisposeAsync();
            throw new AuthoringExtensionContractException(
                "Service runtime has no process measurement authority.");
        }

        try
        {
            ledger.Register(process, incarnation!);
        }
        catch
        {
            await process.TerminateTreeAsync("measurement-registration-failed", CancellationToken.None);
            await process.DisposeAsync();
            throw;
        }
        return process;
    }

}
