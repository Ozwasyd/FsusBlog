using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.Versioning;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public interface IAuthoringMeasuredRuntimeInstance
{
    string RuntimeIdentity
    {
        get;
    }

    int ProcessId
    {
        get;
    }
}

public interface IAuthoringRuntimeResourceLedger
{
    void Register(string runtimeIdentity, int processId);

    void Unregister(string runtimeIdentity, int processId);

    void RecordRestart(string runtimeIdentity);

    void RecordBrokeredUsage(
        string runtimeIdentity,
        long networkBytes,
        long fileBytes,
        long stateBytes);
}

[SupportedOSPlatform("linux")]
public sealed class LinuxProcAuthoringResourceMeasurementSource :
    IAuthoringResourceMeasurementSource,
    IAuthoringRuntimeResourceLedger
{
    private readonly ConcurrentDictionary<string, Entry> _entries = new(StringComparer.Ordinal);

    public void Register(string runtimeIdentity, int processId)
    {
        Validate(runtimeIdentity, processId);
        _entries.AddOrUpdate(
            runtimeIdentity,
            _ => new Entry(processId),
            (_, existing) => existing.ReplaceProcess(processId));
    }

    public void Unregister(string runtimeIdentity, int processId)
    {
        Validate(runtimeIdentity, processId);
        if (_entries.TryGetValue(runtimeIdentity, out Entry? entry))
        {
            entry.Freeze(processId);
        }
    }

    public void RecordRestart(string runtimeIdentity)
    {
        Validate(runtimeIdentity, 1);
        _entries.GetOrAdd(runtimeIdentity, static _ => new Entry(null)).RecordRestart();
    }

    public void RecordBrokeredUsage(
        string runtimeIdentity,
        long networkBytes,
        long fileBytes,
        long stateBytes)
    {
        Validate(runtimeIdentity, 1);
        if (networkBytes < 0 || fileBytes < 0 || stateBytes < 0)
        {
            throw new AuthoringExtensionContractException("Runtime resource usage cannot be negative.");
        }

        _entries.GetOrAdd(runtimeIdentity, static _ => new Entry(null))
            .RecordBrokeredUsage(networkBytes, fileBytes, stateBytes);
    }

    public ValueTask<AuthoringResourceMeasurement> MeasureAsync(
        AuthoringBudgetIdentity identity,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!_entries.TryGetValue(identity.RuntimeIdentity, out Entry? entry))
        {
            throw new AuthoringExtensionContractException(
                "Runtime has no registered process measurement authority.");
        }

        return ValueTask.FromResult(entry.Measure());
    }

    private static void Validate(string? runtimeIdentity, int processId)
    {
        if (runtimeIdentity is not { Length: 64 } || runtimeIdentity.Any(static character =>
                character is not (>= '0' and <= '9' or >= 'a' and <= 'f')) ||
            processId < 1)
        {
            throw new AuthoringExtensionContractException(
                "Runtime measurement identity is missing or invalid.");
        }
    }

    private sealed class Entry(int? processId)
    {
        private readonly Lock _lock = new();
        private AuthoringResourceMeasurement _last = new(default, 0, 0, 0, 0, 0, 0, 0);
        private int? _processId = processId;
        private int _restarts;
        private long _networkBytes;
        private long _fileBytes;
        private long _stateBytes;

        public Entry ReplaceProcess(int nextProcessId)
        {
            lock (_lock)
            {
                ObserveCurrent();
                _processId = nextProcessId;
                return this;
            }
        }

        public void Freeze(int expectedProcessId)
        {
            lock (_lock)
            {
                if (_processId != expectedProcessId)
                {
                    return;
                }

                ObserveCurrent();
                _processId = null;
            }
        }

        public void RecordRestart()
        {
            lock (_lock)
            {
                _restarts++;
            }
        }

        public void RecordBrokeredUsage(long networkBytes, long fileBytes, long stateBytes)
        {
            lock (_lock)
            {
                _networkBytes = checked(_networkBytes + networkBytes);
                _fileBytes = checked(_fileBytes + fileBytes);
                _stateBytes = Math.Max(_stateBytes, stateBytes);
            }
        }

        public AuthoringResourceMeasurement Measure()
        {
            lock (_lock)
            {
                ObserveCurrent();
                return _last with
                {
                    Restarts = _restarts,
                    NetworkBytes = _networkBytes,
                    FileBytes = _fileBytes,
                    StateBytes = _stateBytes
                };
            }
        }

        private void ObserveCurrent()
        {
            if (_processId is not int currentProcessId)
            {
                return;
            }

            try
            {
                using Process process = Process.GetProcessById(currentProcessId);
                process.Refresh();
                (long inbound, long outbound) = ReadIo(currentProcessId);
                _last = new AuthoringResourceMeasurement(
                    process.TotalProcessorTime,
                    process.WorkingSet64,
                    inbound,
                    outbound,
                    _restarts,
                    _networkBytes,
                    _fileBytes,
                    _stateBytes);
            }
            catch (Exception exception) when (
                exception is ArgumentException or InvalidOperationException or IOException)
            {
                if (!Directory.Exists($"/proc/{currentProcessId}"))
                {
                    _processId = null;
                    return;
                }

                throw new AuthoringExtensionContractException(
                    "Runtime resource measurement authority failed while the process remained active.");
            }
        }

        private static (long Inbound, long Outbound) ReadIo(int processId)
        {
            long inbound = 0;
            long outbound = 0;
            foreach (string line in File.ReadLines($"/proc/{processId}/io"))
            {
                if (line.StartsWith("rchar: ", StringComparison.Ordinal))
                {
                    inbound = long.Parse(
                        line.AsSpan(7),
                        System.Globalization.CultureInfo.InvariantCulture);
                }
                else if (line.StartsWith("wchar: ", StringComparison.Ordinal))
                {
                    outbound = long.Parse(
                        line.AsSpan(7),
                        System.Globalization.CultureInfo.InvariantCulture);
                }
            }

            return (inbound, outbound);
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
        if (instance is not IAuthoringMeasuredRuntimeInstance measured)
        {
            await instance.TerminateAsync("measurement-authority-missing", CancellationToken.None);
            await instance.DisposeAsync();
            throw new AuthoringExtensionContractException(
                "Worker runtime has no process measurement authority.");
        }

        try
        {
            ledger.Register(measured.RuntimeIdentity, measured.ProcessId);
        }
        catch
        {
            await instance.TerminateAsync("measurement-registration-failed", CancellationToken.None);
            await instance.DisposeAsync();
            throw;
        }
        return new MeasuredWorkerInstance(instance, measured, ledger);
    }

    private sealed class MeasuredWorkerInstance(
        IAuthoringWorkerSandboxInstance inner,
        IAuthoringMeasuredRuntimeInstance measured,
        IAuthoringRuntimeResourceLedger ledger) :
        IAuthoringWorkerSandboxInstance,
        IAuthoringMeasuredRuntimeInstance
    {
        public AuthoringWorkerCapabilityReport CapabilityReport => inner.CapabilityReport;
        public string RuntimeIdentity => measured.RuntimeIdentity;
        public int ProcessId => measured.ProcessId;

        public ValueTask<AuthoringWorkerResponse> ExecuteAsync(
            AuthoringWorkerRequest request,
            CancellationToken cancellationToken) => inner.ExecuteAsync(request, cancellationToken);

        public ValueTask TerminateAsync(string reason, CancellationToken cancellationToken) =>
            inner.TerminateAsync(reason, cancellationToken);

        public async ValueTask DisposeAsync()
        {
            try
            {
                ledger.Unregister(RuntimeIdentity, ProcessId);
            }
            finally
            {
                await inner.DisposeAsync();
            }
        }
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
        if (process is not IAuthoringMeasuredRuntimeInstance measured)
        {
            await process.TerminateTreeAsync("measurement-authority-missing", CancellationToken.None);
            await process.DisposeAsync();
            throw new AuthoringExtensionContractException(
                "Service runtime has no process measurement authority.");
        }

        try
        {
            ledger.Register(measured.RuntimeIdentity, measured.ProcessId);
        }
        catch
        {
            await process.TerminateTreeAsync("measurement-registration-failed", CancellationToken.None);
            await process.DisposeAsync();
            throw;
        }
        return new MeasuredServiceProcess(process, measured, ledger);
    }

    private sealed class MeasuredServiceProcess(
        IAuthoringServiceProcess inner,
        IAuthoringMeasuredRuntimeInstance measured,
        IAuthoringRuntimeResourceLedger ledger) :
        IAuthoringServiceProcess,
        IAuthoringMeasuredRuntimeInstance
    {
        public AuthoringProcessOwnershipReport Ownership => inner.Ownership;
        public string RuntimeIdentity => measured.RuntimeIdentity;
        public int ProcessId => measured.ProcessId;

        public ValueTask<AuthoringServiceHealthReport> GetHealthAsync(CancellationToken cancellationToken) =>
            inner.GetHealthAsync(cancellationToken);

        public ValueTask<AuthoringServiceResponse> ExecuteAsync(
            AuthoringServiceRequest request,
            CancellationToken cancellationToken) => inner.ExecuteAsync(request, cancellationToken);

        public ValueTask TerminateTreeAsync(string reason, CancellationToken cancellationToken) =>
            inner.TerminateTreeAsync(reason, cancellationToken);

        public async ValueTask DisposeAsync()
        {
            try
            {
                ledger.Unregister(RuntimeIdentity, ProcessId);
            }
            finally
            {
                await inner.DisposeAsync();
            }
        }
    }
}
