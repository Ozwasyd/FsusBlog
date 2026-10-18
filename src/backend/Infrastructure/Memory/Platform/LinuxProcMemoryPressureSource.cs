using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

// PROVENANCE: Host availability and process swap occupancy never establish cgroup
// admission headroom, swap activity or thrashing. Scoped controller sampling is separate.
public sealed class LinuxProcMemoryPressureSource : IDisposable
{
    private readonly object _gate = new();
    private readonly ResourceDomainId _processDomain;
    private readonly ResourceDomainId _hostDomain;
    private readonly TimeProvider _clock;
    private readonly TimeSpan _maximumCaptureDuration;
    private readonly string _sourceIdentity = $"Linux.procfs;pid={Environment.ProcessId};instance={Guid.NewGuid():D}";
    private IMemoryAllocationCharge? _charge;
    private byte[]? _buffer;
    private bool _disabled;
    private long _readAttempts;

    private LinuxProcMemoryPressureSource(ResourceDomainId processDomain, ResourceDomainId hostDomain,
        TimeProvider clock, TimeSpan maximumCaptureDuration, bool disabled)
    {
        _processDomain = processDomain;
        _hostDomain = hostDomain;
        _clock = clock;
        _maximumCaptureDuration = maximumCaptureDuration;
        _disabled = disabled;
    }

    public long ReadAttempts
    {
        get
        {
            lock (_gate)
            {
                return _readAttempts;
            }
        }
    }

    public static MemoryOperationResult<LinuxProcMemoryPressureSource> TryCreate(
        MemoryReservationCoordinator ledger, ResourceDomainId samplingDomain,
        ResourceDomainId processDomain, ResourceDomainId hostDomain, TimeProvider clock,
        int maximumReadBytes, TimeSpan maximumCaptureDuration, MemoryCapabilityMode mode = MemoryCapabilityMode.Auto)
    {
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(clock);
        if (processDomain.Value == Guid.Empty || hostDomain.Value == Guid.Empty
            || maximumReadBytes <= 0 || maximumReadBytes >= Array.MaxLength
            || maximumCaptureDuration <= TimeSpan.Zero || !Enum.IsDefined(mode))
        {
            return MemoryOperationResult<LinuxProcMemoryPressureSource>.Reject(MemoryFailure.BoundsViolation);
        }
        var source = new LinuxProcMemoryPressureSource(processDomain, hostDomain, clock,
            maximumCaptureDuration, mode == MemoryCapabilityMode.Disabled);
        if (source._disabled)
        {
            return MemoryOperationResult<LinuxProcMemoryPressureSource>.Success(source);
        }
        if (!OperatingSystem.IsLinux())
        {
            return MemoryOperationResult<LinuxProcMemoryPressureSource>.Reject(MemoryFailure.UnsupportedCapability);
        }
        int capacity = checked(maximumReadBytes + 1);
        MemoryResourceCharge[] vector = [new(samplingDomain, MemoryResourceUnit.Bytes, capacity)];
        MemoryOperationResult<MemoryReservation> admitted = ledger.TryReserve(vector);
        if (!admitted.Succeeded)
        {
            return MemoryOperationResult<LinuxProcMemoryPressureSource>.Reject(admitted.Failure!.Value);
        }
        using MemoryReservation reservation = admitted.Value!;
        source._buffer = new byte[capacity];
        var descriptor = new MemoryAllocationDescriptor(new(Guid.NewGuid()), samplingDomain,
            MemoryAllocationLayout.TryCreate(0, capacity, 1).Value!);
        MemoryOperationResult<IMemoryAllocationCharge> physical = reservation.CommitPhysical(descriptor, vector);
        if (!physical.Succeeded)
        {
            Array.Clear(source._buffer);
            source._buffer = null;
            return MemoryOperationResult<LinuxProcMemoryPressureSource>.Reject(physical.Failure!.Value);
        }
        source._charge = physical.Value!;
        return MemoryOperationResult<LinuxProcMemoryPressureSource>.Success(source);
    }

    // SAMPLING: Only an explicit background owner calls this synchronous bounded
    // capture. This adapter registers no scheduler, request hook or diagnostics route.
    public IReadOnlyList<MemoryPressureObservation> Capture(ulong domainRevision)
    {
        if (domainRevision == 0)
        {
            throw new ArgumentOutOfRangeException(nameof(domainRevision));
        }
        lock (_gate)
        {
            if (_disabled)
            {
                throw new InvalidOperationException("The pressure source is disabled.");
            }
            byte[] buffer = _buffer!;
            try
            {
                long frequency = _clock.TimestampFrequency;
                if (frequency <= 0)
                {
                    throw new InvalidOperationException("The pressure source clock frequency is invalid.");
                }
                DateTimeOffset sampledAt = _clock.GetUtcNow();
                long timestamp = _clock.GetTimestamp();
                var observations = new MemoryPressureObservation[5];
                Read("/proc/meminfo", 0, [
                    (MemoryPressureMetric.HostAvailableBytes, "MemAvailable"),
                    (MemoryPressureMetric.HostSwapTotalBytes, "SwapTotal"),
                    (MemoryPressureMetric.HostSwapFreeBytes, "SwapFree")
                ], _hostDomain, MemoryPressureScope.HostCurrent);
                Read("/proc/self/status", 3, [
                    (MemoryPressureMetric.ProcessWorkingSetBytes, "VmRSS"),
                    (MemoryPressureMetric.ProcessSwapBytes, "VmSwap")
                ], _processDomain, MemoryPressureScope.Process);
                long completed = _clock.GetTimestamp();
                DateTimeOffset completedAt = _clock.GetUtcNow();
                long completedFrequency = _clock.TimestampFrequency;
                bool stale;
                try
                {
                    long elapsed = checked(completed - timestamp);
                    // Compare using the frozen scale without rounding an over-bound interval down.
                    stale = completedFrequency != frequency || completedAt < sampledAt
                        || completedAt - sampledAt > _maximumCaptureDuration || elapsed < 0
                        || (UInt128)(ulong)elapsed * (ulong)TimeSpan.TicksPerSecond
                            > (UInt128)(ulong)_maximumCaptureDuration.Ticks * (ulong)frequency;
                }
                catch (OverflowException)
                {
                    stale = true;
                }
                if (stale)
                {
                    for (int index = 0; index < observations.Length; index++)
                    {
                        MemoryPressureObservation item = observations[index];
                        observations[index] = new(item.Metric, item.Unit, item.Scope, item.Domain, item.DomainRevision,
                            MemoryObservationState.Stale, null, item.Source, item.SampledAt, item.Timestamp, item.TimestampFrequency);
                    }
                }
                return Array.AsReadOnly(observations);

                void Read(string path, int offset, (MemoryPressureMetric Metric, string Field)[] fields,
                    ResourceDomainId domain, MemoryPressureScope scope)
                {
                    int length = 0;
                    MemoryObservationState state = MemoryObservationState.Available;
                    _readAttempts = _readAttempts == long.MaxValue ? long.MaxValue : _readAttempts + 1;
                    try
                    {
                        using var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite, 1);
                        while (length < buffer.Length)
                        {
                            int read = stream.Read(buffer.AsSpan(length));
                            if (read == 0)
                            {
                                break;
                            }
                            length += read;
                        }
                        if (length == buffer.Length)
                        {
                            state = MemoryObservationState.Malformed;
                        }
                    }
                    catch (UnauthorizedAccessException)
                    {
                        state = MemoryObservationState.Denied;
                    }
                    catch (IOException)
                    {
                        state = MemoryObservationState.Unknown;
                    }
                    for (int index = 0; index < fields.Length; index++)
                    {
                        (MemoryObservationState parsedState, long? value) = state == MemoryObservationState.Available
                            ? ParseKilobytes(buffer.AsSpan(0, length), fields[index].Field)
                            : (state, null);
                        observations[offset + index] = new(fields[index].Metric, MemoryResourceUnit.Bytes, scope,
                            domain, domainRevision, parsedState, value, $"{_sourceIdentity};{path}:{fields[index].Field}",
                            sampledAt, timestamp, frequency);
                    }
                    Array.Clear(buffer);
                }
            }
            finally
            {
                Array.Clear(buffer);
            }
        }
    }

    internal static (MemoryObservationState State, long? Bytes) ParseKilobytes(ReadOnlySpan<byte> content, string field)
    {
        MemoryObservationState state = MemoryObservationState.Unknown;
        long? value = null;
        foreach (Range lineRange in content.Split((byte)'\n'))
        {
            ReadOnlySpan<byte> line = content[lineRange];
            int colon = line.IndexOf((byte)':');
            if (colon != field.Length || !MatchesField(line[..colon], field))
            {
                continue;
            }
            if (state != MemoryObservationState.Unknown)
            {
                return (MemoryObservationState.Malformed, null);
            }
            ReadOnlySpan<byte> number = line[(colon + 1)..].Trim(" \t"u8);
            if (number.Length < 4 || !number[^3..].SequenceEqual(" kB"u8))
            {
                return (MemoryObservationState.Malformed, null);
            }
            number = number[..^3].Trim(" \t"u8);
            if (number.IsEmpty)
            {
                return (MemoryObservationState.Malformed, null);
            }
            try
            {
                long kilobytes = 0;
                foreach (byte digit in number)
                {
                    if (digit is < (byte)'0' or > (byte)'9')
                    {
                        return (MemoryObservationState.Malformed, null);
                    }
                    kilobytes = checked(kilobytes * 10 + digit - (byte)'0');
                }
                value = checked(kilobytes * 1024);
                state = MemoryObservationState.Available;
            }
            catch (OverflowException)
            {
                return (MemoryObservationState.Malformed, null);
            }
        }
        return (state, value);
    }

    private static bool MatchesField(ReadOnlySpan<byte> bytes, string field)
    {
        for (int index = 0; index < bytes.Length; index++)
        {
            if (bytes[index] != field[index])
            {
                return false;
            }
        }
        return true;
    }

    public void Disable()
    {
        lock (_gate)
        {
            _disabled = true;
            if (_buffer is null)
            {
                return;
            }
            Array.Clear(_buffer);
            _buffer = null;
            _charge?.Dispose();
            _charge = null;
        }
    }

    public void Dispose() => Disable();
}
