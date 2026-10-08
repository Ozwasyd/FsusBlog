using System.Diagnostics;
using System.Runtime.CompilerServices;
using System.Runtime.InteropServices;
using System.Text;

using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.ArticleVault.MacOS;

/// <summary>
/// Observes one admitted APFS root through FSEvents. This boundary never reads Markdown, writes,
/// normalizes editor operations, invokes a planner or promotes its invalid rescan watermark.
/// </summary>
public sealed class MacVaultWatcherSession : IDisposable
{
    private static readonly UTF8Encoding s_utf8 = new(false, true);
    private readonly object _gate = new();
    private readonly MacVaultRootPathScope _scope;
    private readonly MacVaultRawFactBuffer _buffer;
    private long _sequence;
    private ulong? _lastEventId;
    private bool _disposed;

    private MacVaultWatcherSession(MacVaultRootPathScope scope, MacVaultWatcherOptions options)
    {
        _scope = scope;
        _buffer = new MacVaultRawFactBuffer(options.MaxPendingFacts);
        AppendFailure(MacVaultFactClass.WatcherRestarted, "mac_vault_watch_restarted", null, 0);
    }

    /// <summary>Returns the immutable watch/root/manifest binding, excluding absolute paths.</summary>
    public MacVaultWatchIdentity Identity => _scope.Identity;

    /// <summary>Reports raw progress, never a completed normalization or clean/sync admission.</summary>
    public MacVaultWatermark Watermark
    {
        get
        {
            lock (_gate)
            {
                return new(Identity.WatchInstanceIdentity, _sequence, _lastEventId, false, "mac_vault_rescan_pending");
            }
        }
    }

    /// <summary>Creates the sole stream with fresh identity; rejects unsupported platforms without fallback.</summary>
    public static unsafe MacVaultWatcherSession Open(MacVaultWatchRequest request)
    {
        MacVaultRootPathScope scope = MacVaultRootPathScope.Open(request);
        var session = new MacVaultWatcherSession(scope, request.Options);
        try
        {
            nint context = scope.Handle.SetCallbackTarget(session);
            nint callback = (nint)(delegate* unmanaged[Cdecl]<nint, nint, uint, ulong, int, void>)&ObserveCallback;
            int error = FSEventsNative.Start(scope.Handle, callback, context,
                request.Options.MaxNativeBatch);
            if (error != 0)
            {
                throw new MacVaultWatcherException(FSEventsNative.Reason(error));
            }

            scope.VerifyControlManifest();
            return session;
        }
        catch
        {
            session.Dispose();
            throw;
        }
    }

    /// <summary>Drains at most the configured capacity plus one reserved overflow failure.</summary>
    public IReadOnlyList<MacVaultRawFact> Drain()
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            return _buffer.Drain();
        }
    }

    [UnmanagedCallersOnly(CallConvs = [typeof(CallConvCdecl)])]
    private static void ObserveCallback(nint context, nint path, uint flags, ulong eventId, int error)
    {
        var target = (WeakReference<MacVaultWatcherSession>)GCHandle.FromIntPtr(context).Target!;
        if (target.TryGetTarget(out MacVaultWatcherSession? session))
        {
            session.Observe(path, flags, eventId, error);
        }
    }

    private unsafe void Observe(nint path, uint flags, ulong eventId, int error)
    {
        lock (_gate)
        {
            if (_disposed || _buffer.IsOverflowed)
            {
                return;
            }

            string? relative = null;
            try
            {
                if (error != 0 || path == 0)
                {
                    AppendFailure(error == 9 ? MacVaultFactClass.DeliveryOverflow : MacVaultFactClass.StreamError,
                        FSEventsNative.Reason(error), eventId, flags);
                    return;
                }

                byte* bytes = (byte*)path;
                int length = 0;
                while (length < 4096 && bytes[length] != 0)
                {
                    length++;
                }

                if (length == 4096)
                {
                    throw new MacVaultWatcherException("mac_vault_path_bound_exceeded");
                }

                string absolute = s_utf8.GetString(new ReadOnlySpan<byte>(bytes, length));
                relative = absolute == _scope.RootPath ? string.Empty
                    : absolute.StartsWith(_scope.RootPath + "/", StringComparison.Ordinal)
                        ? absolute[(_scope.RootPath.Length + 1)..]
                        : throw new MacVaultWatcherException("mac_vault_event_root_escape");
                if (relative.Length != 0 && !ArticleVaultPathStructureValidator.ValidateRelativePath(relative).IsValid)
                {
                    relative = null;
                    throw new MacVaultWatcherException("mac_vault_path_blocked");
                }

                // RootChanged has ID zero; native drop flags, never numerical consecutiveness,
                // indicate loss. Per-host IDs legitimately include events outside this root.
                string reason = RawReason(flags, eventId, _lastEventId);
                (MacVaultPathDisposition disposition, ulong? fileId) = _scope.Inspect(relative);
                _lastEventId = eventId;
                bool rename = (flags & 0x800u) != 0;
                bool removedOnly = (flags & 0x300u) == 0x200u && !rename;
                Append(Create(MacVaultFactClass.NativeEvent, eventId, flags, relative,
                    removedOnly ? relative : null, !rename && !removedOnly ? relative : null,
                    fileId, disposition, reason));
            }
            catch (MacVaultWatcherException exception)
            {
                AppendFailure(MacVaultFactClass.BlockedPath, exception.ReasonCode, eventId, flags, relative);
            }
            catch (Exception)
            {
                // Exceptions must not cross the C callback ABI or leak native paths in logs.
                AppendFailure(MacVaultFactClass.StreamError, "mac_vault_callback_failed", eventId, flags);
            }
        }
    }

    internal static string RawReason(uint flags, ulong eventId, ulong? previous) => flags switch
    {
        _ when (flags & 0x0fu) != 0 => "mac_vault_native_gap",
        _ when (flags & 0x20u) != 0 => "mac_vault_root_changed",
        _ when (flags & 0x80u) != 0 => "mac_vault_unmounted",
        _ when (flags & 0x40u) != 0 => "mac_vault_mount_changed",
        _ when (flags & ~0x7fffffu) != 0 => "mac_vault_native_flags_unknown",
        _ when previous.HasValue && eventId <= previous.Value => "mac_vault_event_id_nonmonotonic",
        _ => "mac_vault_rescan_pending"
    };

    private MacVaultRawFact Create(MacVaultFactClass factClass, ulong? eventId, uint flags,
        string? observed, string? oldPath, string? newPath, ulong? fileId,
        MacVaultPathDisposition disposition, string reason)
        => MacVaultRawFactCodec.Seal(new(MacVaultWatcherSchemas.RawFact, MacVaultWatcherSchemas.Version,
            "macos", Identity, ++_sequence, eventId, flags, factClass, observed, oldPath, newPath,
            fileId, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Stopwatch.GetTimestamp(), disposition,
            reason, true, false, string.Empty));

    private void AppendFailure(MacVaultFactClass factClass, string reason, ulong? eventId, uint flags, string? relative = null)
        => Append(Create(factClass, eventId, flags, relative, null, null, null,
            factClass == MacVaultFactClass.BlockedPath ? MacVaultPathDisposition.Blocked : MacVaultPathDisposition.None, reason));

    private void Append(MacVaultRawFact fact)
    {
        if (!_buffer.TryAppend(fact))
        {
            _buffer.RecordOverflow(Create(MacVaultFactClass.DeliveryOverflow, null, 0, null, null, null, null,
                MacVaultPathDisposition.None, "mac_vault_delivery_overflow"));
        }
    }

    /// <summary>Stops, invalidates, drains and releases the stream, queue and descriptors without file writes.</summary>
    public void Dispose()
    {
        lock (_gate)
        {
            if (_disposed)
            {
                return;
            }

            _disposed = true;
        }

        // Closing outside the gate lets in-flight callbacks finish while native close drains them.
        _scope.Dispose();
    }
}
