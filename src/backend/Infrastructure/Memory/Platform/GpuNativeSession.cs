using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Devices;

namespace FsusBlog.Server.Infrastructure.Memory.Platform;

internal abstract class GpuNativeApi(IGpuNativeLibrary library)
{
    private int _references = 1;
    public string LibraryPath => library.AbsolutePath;
    public abstract string Backend
    {
        get;
    }
    public int Version
    {
        get; protected set;
    }

    public void Retain() => Interlocked.Increment(ref _references);
    public void Release()
    {
        if (Interlocked.Decrement(ref _references) == 0)
        {
            library.Dispose();
        }
    }
    protected T Bind<T>(string symbol) where T : Delegate => library.Bind<T>(symbol);
    protected void VerifyVersion(GpuNativeLoadPolicy policy, int version)
    {
        if (!policy.ApprovedApiVersions.Contains(version))
        {
            throw new EntryPointNotFoundException($"Unapproved {Backend} API version {version}.");
        }
        Version = version;
    }
    internal static void Check(int status, string operation)
    {
        if (status != 0)
        {
            throw new GpuDriverException(operation, status);
        }
    }

    protected static void RejectOutOfMemory(int status)
    {
        // Only payload-allocation entry points classify CUDA_ERROR_OUT_OF_MEMORY / hipErrorOutOfMemory here.
        // A rejected request releases its reservation; context-restore failure still requires quarantine.
        if (status == 2)
        {
            throw new GpuAllocationRejectedException();
        }
    }

    public abstract int GetDeviceCount();
    public abstract GpuDeviceIdentity GetIdentity(int device);
    public abstract int CreateContext(int device, out nint context);
    public abstract void DestroyContext(int device, nint context);
    public abstract nint Enter(int device, nint context);
    public abstract void Exit(nint token);
    public abstract GpuDeviceAddress AllocateDevice(long bytes);
    public abstract void FreeDevice(GpuDeviceAddress address);
    public abstract GpuHostAddress AllocateHost(long bytes, bool readback);
    public abstract void FreeHost(GpuHostAddress address);
    public abstract nint CreateStream();
    public abstract nint CreateEvent();
    public abstract void DestroyStream(nint stream);
    public abstract void DestroyEvent(nint @event);
    public abstract void CopyUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes, nint stream);
    public abstract void CopyReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes, nint stream);
    public abstract void Record(nint @event, nint stream);
    public abstract int Query(nint @event);
    public virtual MemoryDetection CanPeer(int source, int destination) => MemoryDetection.Unsupported;
    public virtual bool EnablePeer(int destination, nint destinationContext) => throw new NotSupportedException();
    public virtual void DisablePeer(int destination, nint destinationContext) => throw new NotSupportedException();
    public virtual void CopyPeer(GpuDeviceAddress source, int sourceDevice, nint sourceContext,
        GpuDeviceAddress destination, int destinationDevice, nint destinationContext, long bytes, nint stream)
        => throw new NotSupportedException();
}

/// <summary>Native custody, bounds and DMA tracking; accounting remains with the existing allocation owner.</summary>
internal sealed class GpuNativeSession : IGpuPeerDriverSession
{
    private static long s_nextId;
    private readonly long _id = Interlocked.Increment(ref s_nextId);
    private readonly object _gate = new();
    private readonly GpuNativeApi _api;
    private readonly int _device;
    private readonly nint _context;
    private readonly Dictionary<GpuDeviceAddress, long> _devices = new();
    private readonly Dictionary<GpuHostAddress, long> _hosts = new();
    private readonly Dictionary<GpuSubmission, SubmissionState> _submissions = new();
    private readonly HashSet<SubmissionState> _incoming = new();
    private readonly Dictionary<GpuNativeSession, PeerLink> _peerLinks = new();
    private bool _disposed;
    private bool _faulted;

    public GpuNativeSession(GpuNativeApi api, int device)
    {
        _api = api;
        _device = device;
        api.Retain();
        try
        {
            Identity = api.GetIdentity(device);
            GpuNativeApi.Check(api.CreateContext(device, out _context), "create-session-context");
        }
        catch
        {
            if (_context != 0)
            {
                // Failure to release native custody intentionally keeps the library loaded.
                api.DestroyContext(device, _context);
            }
            api.Release();
            throw;
        }
    }

    public GpuDeviceIdentity Identity
    {
        get;
    }

    public GpuDeviceAddress AllocateDevice(long bytes)
    {
        ValidateSize(bytes);
        lock (_gate)
        {
            return Invoke(() =>
            {
                GpuDeviceAddress address = _api.AllocateDevice(bytes);
                _devices.Add(address, bytes);
                return address;
            });
        }
    }

    public void FreeDevice(GpuDeviceAddress address)
    {
        lock (_gate)
        {
            EnsureAvailable();
            if (!_devices.ContainsKey(address) || _submissions.Values.Any(value => value.Device == address)
                || _incoming.Any(value => value.PeerDevice == address))
            {
                throw new InvalidOperationException("Device allocation is unknown or held by a submission.");
            }
            Invoke(() =>
            {
                _api.FreeDevice(address);
                _devices.Remove(address);
                return 0;
            });
        }
    }

    public GpuHostAddress AllocateHost(long bytes, bool cpuReadback)
    {
        ValidateSize(bytes);
        lock (_gate)
        {
            return Invoke(() =>
            {
                GpuHostAddress address = _api.AllocateHost(bytes, cpuReadback);
                _hosts.Add(address, bytes);
                return address;
            });
        }
    }

    public void FreeHost(GpuHostAddress address)
    {
        lock (_gate)
        {
            EnsureAvailable();
            if (!_hosts.ContainsKey(address) || _submissions.Values.Any(value => value.Host == address))
            {
                throw new InvalidOperationException("Host allocation is unknown or held by a submission.");
            }
            Invoke(() =>
            {
                _api.FreeHost(address);
                _hosts.Remove(address);
                return 0;
            });
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
            ValidateHost(host, bytes);
            ValidateDevice(device, bytes);
            EnsureHostIdle(host);
            return Invoke(() => StartSubmission(new(host, device), stream =>
            {
                if (upload)
                {
                    _api.CopyUpload(host, device, bytes, stream);
                }
                else
                {
                    _api.CopyReadback(device, host, bytes, stream);
                }
            }));
        }
    }

    public MemoryDetection DetectPeerAccess(IGpuPeerDriverSession destination)
    {
        if (destination is not GpuNativeSession peer || !Compatible(peer))
        {
            return MemoryDetection.Unsupported;
        }
        return WithPeer(peer, () => Invoke(() => _api.CanPeer(_device, peer._device)));
    }

    public GpuSubmission SubmitPeerTransfer(GpuDeviceAddress source, IGpuPeerDriverSession destination,
        GpuDeviceAddress destinationAddress, long bytes)
    {
        ValidateSize(bytes);
        if (destination is not GpuNativeSession peer || !Compatible(peer))
        {
            throw new NotSupportedException("Peer sessions must share the approved native backend and API identity.");
        }
        return WithPeer(peer, () =>
        {
            EnsureAvailable();
            peer.EnsureAvailable();
            ValidateDevice(source, bytes);
            peer.ValidateDevice(destinationAddress, bytes);
            return Invoke(() =>
            {
                if (_api.CanPeer(_device, peer._device) != MemoryDetection.Present)
                {
                    throw new NotSupportedException("Driver does not support this directional peer pair.");
                }
                var state = new SubmissionState(default, source) { Peer = peer, PeerDevice = destinationAddress };
                peer._incoming.Add(state);
                return StartSubmission(state, stream =>
                {
                    if (!_peerLinks.TryGetValue(peer, out PeerLink? link))
                    {
                        link = new(_api.EnablePeer(peer._device, peer._context));
                        _peerLinks.Add(peer, link);
                    }
                    link.References++;
                    state.PeerLinkAssigned = true;
                    _api.CopyPeer(source, _device, _context, destinationAddress, peer._device,
                        peer._context, bytes, stream);
                });
            });
        });
    }

    public GpuCompletion Query(GpuSubmission submission)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            SubmissionState state = GetSubmission(submission);
            if (!state.Recorded || state.Uncertain)
            {
                return GpuCompletion.Uncertain;
            }
            try
            {
                int status = Invoke(() => _api.Query(submission.Event), allowFaulted: true);
                if (status == 0)
                {
                    return GpuCompletion.Complete;
                }
                if (status == 600)
                {
                    return GpuCompletion.Pending;
                }
            }
            catch (GpuDriverException)
            {
                // Context failures are equally uncertain; no teardown can imply DMA completion.
            }
            state.Uncertain = true;
            _faulted = true;
            return GpuCompletion.Uncertain;
        }
    }

    public void ReleaseSubmission(GpuSubmission submission)
    {
        SubmissionState state;
        lock (_gate)
        {
            state = GetSubmission(submission);
        }
        void Release()
        {
            if (Query(submission) != GpuCompletion.Complete)
            {
                throw new InvalidOperationException("Submission completion is not certain.");
            }
            Invoke(() =>
            {
                if (state.Peer is { } peer && state.PeerLinkAssigned && !state.PeerLinkReleased)
                {
                    PeerLink link = _peerLinks[peer];
                    if (link.References == 1)
                    {
                        if (link.Owned)
                        {
                            _api.DisablePeer(peer._device, peer._context);
                        }
                        _peerLinks.Remove(peer);
                    }
                    else
                    {
                        link.References--;
                    }
                    state.PeerLinkReleased = true;
                }
                if (!state.EventReleased)
                {
                    _api.DestroyEvent(submission.Event);
                    state.EventReleased = true;
                }
                _api.DestroyStream(submission.Stream);
                _submissions.Remove(submission);
                state.Peer?._incoming.Remove(state);
                return 0;
            }, allowFaulted: true);
        }
        if (state.Peer is { } peer)
        {
            WithPeer(peer, () =>
            {
                Release();
                return 0;
            });
        }
        else
        {
            lock (_gate)
            {
                Release();
            }
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
            if (_devices.Count != 0 || _hosts.Count != 0 || _submissions.Count != 0 || _incoming.Count != 0
                || _peerLinks.Count != 0)
            {
                throw new InvalidOperationException("Native allocations or submissions still own the session.");
            }
            _api.DestroyContext(_device, _context);
            _disposed = true;
            _api.Release();
        }
    }

    private GpuSubmission StartSubmission(SubmissionState state, Action<nint> copy)
    {
        nint stream;
        try
        {
            stream = _api.CreateStream();
        }
        catch
        {
            state.Peer?._incoming.Remove(state);
            throw;
        }
        nint @event;
        try
        {
            @event = _api.CreateEvent();
        }
        catch
        {
            // No copy was called yet; a cleanup failure retains an opaque stream record.
            try
            {
                _api.DestroyStream(stream);
                state.Peer?._incoming.Remove(state);
            }
            catch
            {
                _submissions.Add(new(stream, 0), state);
                _faulted = true;
            }
            throw;
        }
        var submission = new GpuSubmission(stream, @event);
        _submissions.Add(submission, state);
        try
        {
            copy(stream);
            _api.Record(@event, stream);
            state.Recorded = true;
            return submission;
        }
        catch
        {
            // INTEROP: Even failed copy/record calls can report an earlier asynchronous error.
            state.Uncertain = true;
            _faulted = true;
            throw;
        }
    }

    private T Invoke<T>(Func<T> action, bool allowFaulted = false)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!allowFaulted)
        {
            EnsureAvailable();
        }
        nint token = _api.Enter(_device, _context);
        try
        {
            return action();
        }
        finally
        {
            try
            {
                _api.Exit(token);
            }
            catch
            {
                _faulted = true;
                throw;
            }
        }
    }

    private T WithPeer<T>(GpuNativeSession peer, Func<T> action)
    {
        object first = _id < peer._id ? _gate : peer._gate;
        object second = _id < peer._id ? peer._gate : _gate;
        lock (first)
        {
            lock (second)
            {
                return action();
            }
        }
    }

    private bool Compatible(GpuNativeSession peer)
        => peer != this && _api.Backend == peer._api.Backend && _api.Version == peer._api.Version
            && _api.LibraryPath == peer._api.LibraryPath;

    private SubmissionState GetSubmission(GpuSubmission submission)
        => _submissions.TryGetValue(submission, out SubmissionState? state) ? state
            : throw new InvalidOperationException("Submission belongs to another session or was released.");

    private void EnsureAvailable()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (_faulted)
        {
            throw new InvalidOperationException("Session is quarantined after an uncertain native operation.");
        }
    }

    private void ValidateHost(GpuHostAddress address, long bytes)
    {
        if (!_hosts.TryGetValue(address, out long length) || bytes > length)
        {
            throw new ArgumentOutOfRangeException(nameof(address));
        }
    }

    private void ValidateDevice(GpuDeviceAddress address, long bytes)
    {
        if (!_devices.TryGetValue(address, out long length) || bytes > length)
        {
            throw new ArgumentOutOfRangeException(nameof(address));
        }
    }

    private void EnsureHostIdle(GpuHostAddress address)
    {
        if (_submissions.Values.Any(value => value.Host == address))
        {
            throw new InvalidOperationException("Host allocation is held by a submission.");
        }
    }

    private static void ValidateSize(long bytes)
    {
        if (bytes <= 0 || (ulong)bytes > nuint.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(bytes));
        }
    }

    private sealed class SubmissionState(GpuHostAddress host, GpuDeviceAddress device)
    {
        public GpuHostAddress Host { get; } = host;
        public GpuDeviceAddress Device { get; } = device;
        public GpuNativeSession? Peer
        {
            get; init;
        }
        public GpuDeviceAddress PeerDevice
        {
            get; init;
        }
        public bool Recorded
        {
            get; set;
        }
        public bool Uncertain
        {
            get; set;
        }
        public bool EventReleased
        {
            get; set;
        }
        public bool PeerLinkAssigned
        {
            get; set;
        }
        public bool PeerLinkReleased
        {
            get; set;
        }
    }

    private sealed class PeerLink(bool owned)
    {
        public bool Owned { get; } = owned;
        public int References
        {
            get; set;
        }
    }
}
