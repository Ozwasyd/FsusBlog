using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Platform;

namespace FsusBlog.Server.Infrastructure.Memory.Pressure;

public enum MemoryPressureMetric
{
    GcHeapBytes, GcCommittedBytes, RuntimeCapacityBytes, HostLoadBytes, HostLoadThresholdBytes,
    TotalAllocatedBytes, ProcessWorkingSetBytes, LedgerChargedBytes, LedgerOperationSlots, LedgerInodes,
    HostAvailableBytes, HostSwapTotalBytes, HostSwapFreeBytes, ProcessSwapBytes,
    ScopedExternalUsageBytes, ScopedExternalLimitBytes
}

public enum MemoryPressureScope
{
    Process, RuntimeCapacity, HostAtLastCollection, HeapAtLastCollection, Ledger, HostCurrent, ExternalResourceDomain
}

public enum MemoryPressureTransition
{
    Comparable, Unknown, Stale, DomainChanged, SourceChanged, ClockDiscontinuity, CounterReset, SnapshotOnly
}

// PROVENANCE: These are observations, not qualified physical free-memory or admission
// headroom. Last-collection GC data retains its scope instead of claiming live host usage.
public sealed class MemoryPressureObservation
{
    public MemoryPressureObservation(MemoryPressureMetric metric, MemoryResourceUnit unit, MemoryPressureScope scope,
        ResourceDomainId domain, ulong domainRevision, MemoryObservationState state, long? value, string source,
        DateTimeOffset sampledAt, long timestamp, long timestampFrequency)
    {
        if (!Enum.IsDefined(metric) || !Enum.IsDefined(unit) || !Enum.IsDefined(scope) || !Enum.IsDefined(state)
            || scope != ExpectedScope(metric)
            || domain.Value == Guid.Empty || domainRevision == 0 || timestampFrequency <= 0
            || unit != ExpectedUnit(metric)
            || (state == MemoryObservationState.Available ? value is null or < 0 : value is not null)
            || string.IsNullOrWhiteSpace(source))
        {
            throw new ArgumentException("Invalid pressure observation or missing source/domain/clock provenance.");
        }
        Metric = metric;
        Unit = unit;
        Scope = scope;
        Domain = domain;
        DomainRevision = domainRevision;
        State = state;
        Value = value;
        Source = source;
        SampledAt = sampledAt;
        Timestamp = timestamp;
        TimestampFrequency = timestampFrequency;
    }
    public MemoryPressureMetric Metric
    {
        get;
    }
    public MemoryResourceUnit Unit
    {
        get;
    }
    public MemoryPressureScope Scope
    {
        get;
    }
    public ResourceDomainId Domain
    {
        get;
    }
    public ulong DomainRevision
    {
        get;
    }
    public MemoryObservationState State
    {
        get;
    }
    public long? Value
    {
        get;
    }
    public string Source
    {
        get;
    }
    public DateTimeOffset SampledAt
    {
        get;
    }
    public long Timestamp
    {
        get;
    }
    public long TimestampFrequency
    {
        get;
    }

    private static MemoryResourceUnit ExpectedUnit(MemoryPressureMetric metric) => metric switch
    {
        MemoryPressureMetric.LedgerOperationSlots => MemoryResourceUnit.OperationSlots,
        MemoryPressureMetric.LedgerInodes => MemoryResourceUnit.Inodes,
        _ => MemoryResourceUnit.Bytes
    };

    private static MemoryPressureScope ExpectedScope(MemoryPressureMetric metric) => metric switch
    {
        MemoryPressureMetric.GcHeapBytes or MemoryPressureMetric.GcCommittedBytes => MemoryPressureScope.HeapAtLastCollection,
        MemoryPressureMetric.RuntimeCapacityBytes => MemoryPressureScope.RuntimeCapacity,
        MemoryPressureMetric.HostLoadBytes or MemoryPressureMetric.HostLoadThresholdBytes => MemoryPressureScope.HostAtLastCollection,
        MemoryPressureMetric.LedgerChargedBytes or MemoryPressureMetric.LedgerOperationSlots or MemoryPressureMetric.LedgerInodes => MemoryPressureScope.Ledger,
        MemoryPressureMetric.HostAvailableBytes or MemoryPressureMetric.HostSwapTotalBytes or MemoryPressureMetric.HostSwapFreeBytes => MemoryPressureScope.HostCurrent,
        MemoryPressureMetric.ScopedExternalUsageBytes or MemoryPressureMetric.ScopedExternalLimitBytes => MemoryPressureScope.ExternalResourceDomain,
        _ => MemoryPressureScope.Process
    };
}

public sealed record MemoryPressureDelta(MemoryPressureTransition Transition, long? Change, double? PerSecond);

public static class MemoryPressureNormalizer
{
    public static MemoryPressureDelta Compare(MemoryPressureObservation previous, MemoryPressureObservation current,
        ResourceDomainId activeDomain, ulong activeRevision, DateTimeOffset now, TimeSpan maximumAge)
    {
        ArgumentNullException.ThrowIfNull(previous);
        ArgumentNullException.ThrowIfNull(current);
        if (maximumAge <= TimeSpan.Zero || activeDomain.Value == Guid.Empty || activeRevision == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maximumAge));
        }
        if (previous.Domain != activeDomain || current.Domain != activeDomain
            || previous.DomainRevision != activeRevision || current.DomainRevision != activeRevision)
        {
            return Refuse(MemoryPressureTransition.DomainChanged);
        }
        if (previous.Metric != current.Metric || previous.Unit != current.Unit || previous.Scope != current.Scope
            || previous.Source != current.Source || previous.TimestampFrequency != current.TimestampFrequency)
        {
            return Refuse(MemoryPressureTransition.SourceChanged);
        }
        if (current.SampledAt > now || current.SampledAt < previous.SampledAt || current.Timestamp <= previous.Timestamp)
        {
            return Refuse(MemoryPressureTransition.ClockDiscontinuity);
        }
        if (current.State == MemoryObservationState.Stale || previous.State == MemoryObservationState.Stale
            || now - current.SampledAt > maximumAge || now - previous.SampledAt > maximumAge)
        {
            return Refuse(MemoryPressureTransition.Stale);
        }
        if (previous.State != MemoryObservationState.Available || current.State != MemoryObservationState.Available)
        {
            return Refuse(MemoryPressureTransition.Unknown);
        }
        if (current.Scope is MemoryPressureScope.HeapAtLastCollection or MemoryPressureScope.HostAtLastCollection or MemoryPressureScope.RuntimeCapacity)
        {
            return Refuse(MemoryPressureTransition.SnapshotOnly);
        }
        long elapsed;
        try
        {
            elapsed = checked(current.Timestamp - previous.Timestamp);
        }
        catch (OverflowException)
        {
            return Refuse(MemoryPressureTransition.ClockDiscontinuity);
        }
        long delta = current.Value!.Value - previous.Value!.Value;
        if (current.Metric == MemoryPressureMetric.TotalAllocatedBytes && delta < 0)
        {
            return Refuse(MemoryPressureTransition.CounterReset);
        }
        double rate = delta / ((double)elapsed / current.TimestampFrequency);
        return double.IsFinite(rate) ? new(MemoryPressureTransition.Comparable, delta, rate)
            : Refuse(MemoryPressureTransition.ClockDiscontinuity);
    }

    private static MemoryPressureDelta Refuse(MemoryPressureTransition transition) => new(transition, null, null);
}

public sealed record MemoryPressureLedgerBinding(ResourceDomainId Domain, string CapacityIdentity, MemoryResourceUnit Unit);
public sealed record MemoryPressureSample(ulong DomainRevision, long LastCompletedGcIndex,
    MemoryAccountingSnapshot Accounting, IReadOnlyList<MemoryPressureObservation> Observations);

// SAMPLING: An explicit background owner invokes Capture; no timer, request hook, public
// health route or parallel scheduler is registered here. OS domain qualification is separate.
public sealed class PortableMemoryPressureSource
{
    private readonly object _gate = new();
    private readonly MemoryReservationCoordinator _ledger;
    private readonly ResourceDomainId _processDomain;
    private readonly ResourceDomainId _hostDomain;
    private readonly MemoryPressureLedgerBinding[] _bindings;
    private readonly TimeProvider _clock;
    private readonly MemoryPressureSample?[] _trace;
    private readonly string _runtimeSource = RuntimeInformation.FrameworkDescription;
    private readonly Guid _sourceInstance = Guid.NewGuid();
    private int _next;
    private int _count;
    private ulong _revision = 1;

    public PortableMemoryPressureSource(MemoryReservationCoordinator ledger,
        ResourceDomainId processDomain, ResourceDomainId hostDomain, IEnumerable<MemoryPressureLedgerBinding> bindings,
        TimeProvider clock, int traceCapacity)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(bindings);
        ArgumentNullException.ThrowIfNull(clock);
        if (processDomain.Value == Guid.Empty || hostDomain.Value == Guid.Empty || traceCapacity <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(traceCapacity));
        }
        _ledger = ledger;
        _processDomain = processDomain;
        _hostDomain = hostDomain;
        _clock = clock;
        MemoryResourceTopology topology = ledger.Topology;
        _bindings = bindings.Take(topology.DomainCount + 1).ToArray();
        if (_bindings.Length > topology.DomainCount || _bindings.Select(binding => binding.Domain).Distinct().Count() != _bindings.Length
            || _bindings.Any(binding => topology.CapacityIdentity(binding.Domain) != binding.CapacityIdentity
                || topology.Unit(binding.Domain) != binding.Unit))
        {
            throw new ArgumentException("Pressure bindings must match a finite resource topology.", nameof(bindings));
        }
        _trace = new MemoryPressureSample[traceCapacity];
    }

    public void InvalidateDomain(ulong revision)
    {
        lock (_gate)
        {
            if (revision <= _revision)
            {
                throw new ArgumentOutOfRangeException(nameof(revision));
            }
            _revision = revision;
            Array.Clear(_trace);
            _count = 0;
            _next = 0;
        }
    }

    /// <summary>
    /// Captures raw platform rows in caller-admitted storage using this observation owner's clock.
    /// The caller owns output lifetime and the finite macOS and Job query durations. These rows retain
    /// their native scopes, failures and qualification; they are not domain-bound history,
    /// admission headroom or comparable Job samples. No scheduler or probe budget is supplied.
    /// </summary>
    public (MacOsSysctlMemoryCapture MacOs, WindowsJobMemoryCapture WindowsJob) CapturePlatformObservations(
        Span<MacOsSysctlMemoryObservation> admittedMacOsOutput,
        Span<WindowsJobMemoryObservation> admittedWindowsJobOutput,
        TimeSpan maximumMacOsCaptureDuration,
        TimeSpan maximumJobCaptureDuration,
        MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        Span<MacOsSysctlMemoryObservation> macOsOutput = admittedMacOsOutput[..Math.Min(admittedMacOsOutput.Length, MacOsSysctlMemoryReader.ObservationCount)];
        Span<WindowsJobMemoryObservation> windowsJobOutput = admittedWindowsJobOutput[..Math.Min(admittedWindowsJobOutput.Length, WindowsCurrentJobMemoryReader.ObservationCount)];
        try
        {
            MemoryCapabilityPolicy.Validate(mode);
            if (macOsOutput.Length != MacOsSysctlMemoryReader.ObservationCount
                || windowsJobOutput.Length != WindowsCurrentJobMemoryReader.ObservationCount
                || maximumMacOsCaptureDuration <= TimeSpan.Zero || maximumJobCaptureDuration <= TimeSpan.Zero)
            {
                throw new ArgumentException("Platform capture requires complete admitted output and finite positive macOS and Job durations.");
            }

            MacOsSysctlMemoryCapture macOs = MacOsSysctlMemoryReader.Capture(_clock, maximumMacOsCaptureDuration, macOsOutput, mode);
            WindowsJobMemoryCapture windowsJob = WindowsCurrentJobMemoryReader.Capture(_clock, maximumJobCaptureDuration, windowsJobOutput, mode);
            return (macOs, windowsJob);
        }
        catch
        {
            // A failed combined operation cannot leave one platform's old or partial facts usable.
            macOsOutput.Clear();
            windowsJobOutput.Clear();
            throw;
        }
    }

    public MemoryPressureSample Capture()
    {
        ulong revision;
        lock (_gate)
        {
            revision = _revision;
        }
        var observations = new List<MemoryPressureObservation>(7 + _bindings.Length);
        GCMemoryInfo gc = GC.GetGCMemoryInfo();
        Add(MemoryPressureMetric.GcHeapBytes, MemoryPressureScope.HeapAtLastCollection, _processDomain,
            gc.Index == 0 ? null : gc.HeapSizeBytes, "GC.GetGCMemoryInfo.last-completed-collection");
        Add(MemoryPressureMetric.GcCommittedBytes, MemoryPressureScope.HeapAtLastCollection, _processDomain,
            gc.Index == 0 ? null : gc.TotalCommittedBytes, "GC.GetGCMemoryInfo.last-completed-collection");
        Add(MemoryPressureMetric.RuntimeCapacityBytes, MemoryPressureScope.RuntimeCapacity, _processDomain,
            gc.Index == 0 ? null : gc.TotalAvailableMemoryBytes, "GC.GetGCMemoryInfo.runtime-capacity");
        Add(MemoryPressureMetric.HostLoadBytes, MemoryPressureScope.HostAtLastCollection, _hostDomain,
            gc.Index == 0 ? null : gc.MemoryLoadBytes, "GC.GetGCMemoryInfo.last-completed-collection");
        Add(MemoryPressureMetric.HostLoadThresholdBytes, MemoryPressureScope.HostAtLastCollection, _hostDomain,
            gc.Index == 0 ? null : gc.HighMemoryLoadThresholdBytes, "GC.GetGCMemoryInfo.last-completed-collection");
        Add(MemoryPressureMetric.TotalAllocatedBytes, MemoryPressureScope.Process, _processDomain,
            GC.GetTotalAllocatedBytes(precise: false), "GC.GetTotalAllocatedBytes.sampled-cumulative-counter");
        try
        {
            using Process process = Process.GetCurrentProcess();
            process.Refresh();
            Add(MemoryPressureMetric.ProcessWorkingSetBytes, MemoryPressureScope.Process, _processDomain,
                process.WorkingSet64, $"Process.WorkingSet64.pid={Environment.ProcessId}");
        }
        catch (Exception exception) when (exception is Win32Exception or UnauthorizedAccessException or InvalidOperationException)
        {
            Add(MemoryPressureMetric.ProcessWorkingSetBytes, MemoryPressureScope.Process, _processDomain,
                null, $"Process.WorkingSet64.pid={Environment.ProcessId}",
                exception is UnauthorizedAccessException or Win32Exception ? MemoryObservationState.Denied : MemoryObservationState.Unknown);
        }
        MemoryAccountingSnapshot accounting = _ledger.Snapshot();
        foreach (MemoryPressureLedgerBinding binding in _bindings)
        {
            Add(binding.Unit switch
            {
                MemoryResourceUnit.Bytes => MemoryPressureMetric.LedgerChargedBytes,
                MemoryResourceUnit.Inodes => MemoryPressureMetric.LedgerInodes,
                _ => MemoryPressureMetric.LedgerOperationSlots
            },
                MemoryPressureScope.Ledger, binding.Domain,
                accounting.Used.TryGetValue(binding.CapacityIdentity, out long value) ? value : null,
                "MemoryReservationCoordinator.exact-retained-charge", unit: binding.Unit);
        }
        var sample = new MemoryPressureSample(revision, gc.Index, accounting, observations.AsReadOnly());
        lock (_gate)
        {
            // DOMAIN: A capture overlapping migration is not allowed into current history.
            if (revision != _revision)
            {
                throw new InvalidOperationException("Pressure capture belongs to an invalidated resource-domain revision.");
            }
            _trace[_next] = sample;
            _next = (_next + 1) % _trace.Length;
            _count = Math.Min(_count + 1, _trace.Length);
        }
        return sample;

        void Add(MemoryPressureMetric metric, MemoryPressureScope scope, ResourceDomainId domain, long? value,
            string source, MemoryObservationState unknown = MemoryObservationState.Unknown, MemoryResourceUnit unit = MemoryResourceUnit.Bytes)
        {
            observations.Add(new(metric, unit, scope, domain, revision,
                value is >= 0 ? MemoryObservationState.Available : unknown, value is >= 0 ? value : null,
                $"{source};{_runtimeSource};instance={_sourceInstance:D};pid={Environment.ProcessId}",
                _clock.GetUtcNow(), _clock.GetTimestamp(), _clock.TimestampFrequency));
        }
    }

    public IReadOnlyList<MemoryPressureSample> Trace()
    {
        lock (_gate)
        {
            var samples = new MemoryPressureSample[_count];
            int first = (_next - _count + _trace.Length) % _trace.Length;
            for (int index = 0; index < samples.Length; index++)
            {
                samples[index] = _trace[(first + index) % _trace.Length]!;
            }
            return Array.AsReadOnly(samples);
        }
    }
}
