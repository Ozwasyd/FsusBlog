using System.Runtime.InteropServices;

using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

/// <summary>Metal object custody only; the common GPU owner supplies accounting and admission.</summary>
internal sealed class GpuMetalSession : IGpuDriverSession, IGpuMetalAllocationObservation
{
    private readonly object _gate = new();
    private readonly IGpuMetalApi _api;
    private readonly nint _device;
    private readonly nint _queue;
    private readonly ulong _maximumBufferLength;
    private readonly Dictionary<GpuDeviceAddress, long> _devices = new();
    private readonly Dictionary<GpuHostAddress, HostBuffer> _hosts = new();
    private readonly Dictionary<GpuSubmission, SubmissionState> _submissions = new();
    private bool _disposed;
    private bool _faulted;
    private bool _queueReleased;
    private bool _deviceReleased;

    public GpuMetalSession(IGpuMetalApi api, nint device, Version osVersion, Architecture architecture)
    {
        _api = api;
        _device = device;
        api.RetainReference();
        bool deviceRetained = false;
        try
        {
            Identity = api.Identity(device, osVersion, architecture);
            _maximumBufferLength = api.MaximumBufferLength(device);
            if (_maximumBufferLength == 0)
            {
                throw new GpuDriverException("metal-max-buffer-length-missing", -1);
            }
            api.RetainObject(device);
            deviceRetained = true;
            _queue = api.CreateQueue(device);
            if (_queue == 0)
            {
                throw new GpuDriverException("new-metal-queue", -1);
            }
        }
        catch
        {
            if (deviceRetained)
            {
                api.ReleaseObject(device);
            }
            api.ReleaseReference();
            throw;
        }
    }

    public GpuDeviceIdentity Identity
    {
        get;
    }

    public ulong? ObservedDeviceCapacity(GpuDeviceAddress address)
    {
        lock (_gate)
        {
            EnsureAlive();
            ValidateDevice(address, 0);
            ulong observed = _api.AllocatedSize(unchecked((nint)address.Value));
            return observed == 0 ? null : observed;
        }
    }

    public ulong? ObservedHostCapacity(GpuHostAddress address)
    {
        lock (_gate)
        {
            EnsureAlive();
            HostBuffer buffer = ValidateHost(address, 0);
            ulong observed = _api.AllocatedSize(buffer.Handle);
            return observed == 0 ? null : observed;
        }
    }

    public GpuDeviceAddress AllocateDevice(long bytes)
    {
        ValidateSize(bytes);
        lock (_gate)
        {
            EnsureAvailable();
            nint buffer = _api.CreateBuffer(_device, (ulong)bytes, shared: false, cpuReadback: false);
            var address = new GpuDeviceAddress(unchecked((ulong)buffer));
            try
            {
                if (buffer == 0)
                {
                    throw new GpuAllocationRejectedException();
                }
                _devices.Add(address, bytes);
                return address;
            }
            catch
            {
                if (buffer != 0)
                {
                    _api.ReleaseObject(buffer);
                }
                throw;
            }
        }
    }

    public void FreeDevice(GpuDeviceAddress address)
    {
        lock (_gate)
        {
            EnsureAlive();
            ValidateDevice(address, 0);
            if (_submissions.Values.Any(value => value.Device == address))
            {
                throw new InvalidOperationException("Metal private buffer is held by a submission.");
            }
            _api.ReleaseObject(unchecked((nint)address.Value));
            _devices.Remove(address);
        }
    }

    public GpuHostAddress AllocateHost(long bytes, bool cpuReadback)
    {
        ValidateSize(bytes);
        lock (_gate)
        {
            EnsureAvailable();
            nint buffer = _api.CreateBuffer(_device, (ulong)bytes, shared: true, cpuReadback);
            try
            {
                if (buffer == 0)
                {
                    throw new GpuAllocationRejectedException();
                }
                // Only shared MTLBuffer.contents supplies a real CPU address; private handles remain opaque.
                var address = new GpuHostAddress(_api.Contents(buffer));
                if (address.Value == 0)
                {
                    throw new GpuDriverException("metal-shared-contents", -1);
                }
                _hosts.Add(address, new(buffer, bytes));
                return address;
            }
            catch
            {
                if (buffer != 0)
                {
                    _api.ReleaseObject(buffer);
                }
                throw;
            }
        }
    }

    public void FreeHost(GpuHostAddress address)
    {
        lock (_gate)
        {
            EnsureAlive();
            HostBuffer buffer = ValidateHost(address, 0);
            EnsureHostIdle(address);
            _api.ReleaseObject(buffer.Handle);
            _hosts.Remove(address);
        }
    }

    public unsafe void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source)
    {
        lock (_gate)
        {
            EnsureAvailable();
            ValidateHost(address, source.Length);
            EnsureHostIdle(address);
            source.CopyTo(new Span<byte>((void*)address.Value, source.Length));
        }
    }

    public unsafe void ReadHost(GpuHostAddress address, Span<byte> destination)
    {
        lock (_gate)
        {
            EnsureAvailable();
            ValidateHost(address, destination.Length);
            EnsureHostIdle(address);
            new ReadOnlySpan<byte>((void*)address.Value, destination.Length).CopyTo(destination);
        }
    }

    public GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes)
        => Submit(source, destination, bytes, upload: true);

    public GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes)
        => Submit(destination, source, bytes, upload: false);

    private GpuSubmission Submit(GpuHostAddress host, GpuDeviceAddress device, long bytes, bool upload)
    {
        ValidateSize(bytes);
        lock (_gate)
        {
            EnsureAvailable();
            HostBuffer buffer = ValidateHost(host, bytes);
            ValidateDevice(device, bytes);
            EnsureHostIdle(host);
            nint command = _api.CreateCommand(_queue);
            if (command == 0)
            {
                throw new GpuDriverException("metal-command-buffer", -1);
            }
            var submission = new GpuSubmission(_queue, command);
            var state = new SubmissionState(host, device);
            _submissions.Add(submission, state);
            try
            {
                nint privateBuffer = unchecked((nint)device.Value);
                _api.EncodeCopy(command, upload ? buffer.Handle : privateBuffer,
                    upload ? privateBuffer : buffer.Handle, (ulong)bytes);
                // Register every hold before commit: a throw cannot prove asynchronous work did not start.
                _api.Commit(command);
                state.Committed = true;
                return submission;
            }
            catch
            {
                state.Uncertain = true;
                _faulted = true;
                throw;
            }
        }
    }

    public GpuCompletion Query(GpuSubmission submission)
    {
        lock (_gate)
        {
            EnsureAlive();
            SubmissionState state = GetSubmission(submission);
            if (state.Uncertain || !state.Committed)
            {
                return GpuCompletion.Uncertain;
            }
            if (state.Completed)
            {
                return GpuCompletion.Complete;
            }
            try
            {
                // MTLCommandBufferStatus: NotEnqueued 0, Enqueued 1, Committed 2, Scheduled 3, Completed 4, Error 5.
                ulong status = _api.Status(submission.Event);
                if (status == 4)
                {
                    state.Completed = true;
                    return GpuCompletion.Complete;
                }
                if (status <= 3)
                {
                    return GpuCompletion.Pending;
                }
            }
            catch (GpuDriverException)
            {
                // Failure to observe completion never authorizes releasing either buffer.
            }
            state.Uncertain = true;
            _faulted = true;
            return GpuCompletion.Uncertain;
        }
    }

    public void ReleaseSubmission(GpuSubmission submission)
    {
        lock (_gate)
        {
            if (Query(submission) != GpuCompletion.Complete)
            {
                throw new InvalidOperationException("Metal command completion is not certain.");
            }
            _api.ReleaseObject(submission.Event);
            _submissions.Remove(submission);
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }
            if (_devices.Count != 0 || _hosts.Count != 0 || _submissions.Count != 0)
            {
                throw new InvalidOperationException("Metal buffers or commands still own this session.");
            }
            if (!_queueReleased)
            {
                _api.ReleaseObject(_queue);
                _queueReleased = true;
            }
            if (!_deviceReleased)
            {
                _api.ReleaseObject(_device);
                _deviceReleased = true;
            }
            _disposed = true;
            _api.ReleaseReference();
        }
    }

    private HostBuffer ValidateHost(GpuHostAddress address, long bytes)
        => _hosts.TryGetValue(address, out HostBuffer buffer) && bytes <= buffer.Length ? buffer
            : throw new ArgumentOutOfRangeException(nameof(address));

    private void ValidateDevice(GpuDeviceAddress address, long bytes)
    {
        if (!_devices.TryGetValue(address, out long length) || bytes > length)
        {
            throw new ArgumentOutOfRangeException(nameof(address));
        }
    }

    private void ValidateSize(long bytes)
    {
        if (bytes <= 0 || (ulong)bytes > _maximumBufferLength || (ulong)bytes > nuint.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(bytes));
        }
    }

    private void EnsureHostIdle(GpuHostAddress address)
    {
        if (_submissions.Values.Any(value => value.Host == address))
        {
            throw new InvalidOperationException("Metal shared buffer is held by a submission.");
        }
    }

    private SubmissionState GetSubmission(GpuSubmission submission)
        => _submissions.TryGetValue(submission, out SubmissionState? state) ? state
            : throw new InvalidOperationException("Command belongs to another session or was released.");

    private void EnsureAlive() => ObjectDisposedException.ThrowIf(_disposed, this);

    private void EnsureAvailable()
    {
        EnsureAlive();
        if (_faulted)
        {
            throw new InvalidOperationException("Metal session is quarantined after an uncertain operation.");
        }
    }

    private readonly record struct HostBuffer(nint Handle, long Length);

    private sealed class SubmissionState(GpuHostAddress host, GpuDeviceAddress device)
    {
        public GpuHostAddress Host { get; } = host;
        public GpuDeviceAddress Device { get; } = device;
        public bool Committed
        {
            get; set;
        }
        public bool Completed
        {
            get; set;
        }
        public bool Uncertain
        {
            get; set;
        }
    }
}
