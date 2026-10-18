using System.Buffers.Binary;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>Observes one verified Vault root through Linux inotify without reading source content.</summary>
public sealed class LinuxVaultWatcherSession : IDisposable
{
    private const int EventHeaderSize = 16;
    private const int ReadBufferSize = 64 * 1024;
    private static readonly Encoding s_strictUtf8 = new UTF8Encoding(false, true);

    private readonly SafeFileHandle _inotifyHandle;
    private readonly LinuxVaultRootVerifier.VerifiedLinuxVaultRoot _root;
    private readonly LinuxVaultWatcherOptions _options;
    private readonly Dictionary<int, WatchEntry> _watches = [];
    private readonly HashSet<string> _watchedPaths = new(StringComparer.Ordinal);
    private readonly Queue<LinuxVaultRawFact> _pendingFacts = [];
    private long _nextSequence;
    private bool _pendingOverflowReported;
    private bool _disposed;

    private LinuxVaultWatcherSession(
        SafeFileHandle inotifyHandle,
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root,
        LinuxVaultWatchRequest request)
    {
        _inotifyHandle = inotifyHandle;
        _root = root;
        _options = request.Options;
        Identity = new LinuxVaultWatchIdentity(
            root.Manifest.SiteIdentity,
            root.Manifest.VaultIdentity,
            root.Manifest.DeviceIdentity,
            request.AgentIdentity,
            root.RootIdentity,
            root.Manifest.ContentSha256,
            Guid.NewGuid().ToString("N"),
            root.CanonicalPath,
            root.Filesystem);
        Watermark = new(Identity.WatchInstanceIdentity, 0, false, "linux_vault_watcher_restart", null);
    }

    public LinuxVaultWatchIdentity Identity
    {
        get;
    }

    public LinuxVaultWatermark Watermark
    {
        get; private set;
    }

    public static LinuxVaultWatcherSession Open(LinuxVaultWatchRequest request)
    {
        if (!OperatingSystem.IsLinux())
        {
            throw new PlatformNotSupportedException("The Article Vault Linux watcher requires Linux.");
        }

        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root = LinuxVaultRootVerifier.Verify(request);
        int descriptor = InotifyNative.Initialize(InotifyNative.NonBlocking | InotifyNative.CloseOnExec);
        if (descriptor < 0)
        {
            throw NativeFailure("linux_vault_inotify_init_failed");
        }

        var handle = new SafeFileHandle(new nint(descriptor), ownsHandle: true);
        var session = new LinuxVaultWatcherSession(handle, root, request);
        try
        {
            session.AddDirectoryTree(root.CanonicalPath, string.Empty, initial: true);
            session.EnqueueBounded(session.CreateFact(
                0,
                LinuxVaultFactClass.WatcherRestarted,
                null,
                null,
                null,
                LinuxVaultPathDisposition.None,
                "linux_vault_watcher_restart",
                rescanRequired: true));
            return session;
        }
        catch
        {
            session.Dispose();
            throw;
        }
    }

    /// <summary>Reads only currently available kernel records and returns at most the configured bound.</summary>
    public unsafe IReadOnlyList<LinuxVaultRawFact> ReadAvailable()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var facts = new List<LinuxVaultRawFact>(_options.MaxFactsPerRead);
        DrainPending(facts);
        if (facts.Count >= _options.MaxFactsPerRead)
        {
            return facts;
        }

        Span<byte> buffer = stackalloc byte[ReadBufferSize];
        nint read;
        fixed (byte* pointer = buffer)
        {
            do
            {
                read = InotifyNative.Read(InotifyNative.FileDescriptor(_inotifyHandle), pointer, (nuint)buffer.Length);
            }
            while (read < 0 && Marshal.GetLastPInvokeError() == InotifyNative.Interrupted);
        }

        if (read < 0)
        {
            int error = Marshal.GetLastPInvokeError();
            if (error == InotifyNative.Again)
            {
                return facts;
            }

            Invalidate("linux_vault_inotify_read_failed");
            facts.Add(CreateFact(
                0,
                LinuxVaultFactClass.RootLost,
                null,
                null,
                null,
                LinuxVaultPathDisposition.None,
                $"linux_vault_inotify_read_failed_{error}",
                rescanRequired: true));
            return facts;
        }

        ParseRecords(buffer[..checked((int)read)], facts);
        DrainPending(facts);
        return facts;
    }

    /// <summary>Returns the unchanged watermark because a digest alone cannot prove complete native rescan coverage.</summary>
    /// <remarks>
    /// This session has no native rescan receipt verifier. Acknowledgement cannot clear a loss reason,
    /// advance the event cut, or attach an unverified receipt; the watermark remains invalid.
    /// </remarks>
    public LinuxVaultWatermark AcknowledgeRescan(string rescanReceiptSha256)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        if (!IsSha256(rescanReceiptSha256))
        {
            throw new ArgumentException("Rescan receipt must be a SHA-256 digest.", nameof(rescanReceiptSha256));
        }

        return Watermark;
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        _disposed = true;
        int descriptor = InotifyNative.FileDescriptor(_inotifyHandle);
        foreach (int watchDescriptor in _watches.Keys.ToArray())
        {
            _ = InotifyNative.RemoveWatch(descriptor, watchDescriptor);
        }

        _watches.Clear();
        _watchedPaths.Clear();
        _pendingFacts.Clear();
        _inotifyHandle.Dispose();
    }

    private void ParseRecords(ReadOnlySpan<byte> buffer, List<LinuxVaultRawFact> facts)
    {
        int offset = 0;
        while (offset < buffer.Length)
        {
            if (buffer.Length - offset < EventHeaderSize)
            {
                AddBoundedOverflow(facts, "linux_vault_inotify_record_truncated");
                return;
            }

            int watchDescriptor = BinaryPrimitives.ReadInt32LittleEndian(buffer[offset..]);
            uint mask = BinaryPrimitives.ReadUInt32LittleEndian(buffer[(offset + 4)..]);
            uint cookie = BinaryPrimitives.ReadUInt32LittleEndian(buffer[(offset + 8)..]);
            uint nameLength = BinaryPrimitives.ReadUInt32LittleEndian(buffer[(offset + 12)..]);
            int recordLength;
            try
            {
                recordLength = checked(EventHeaderSize + (int)nameLength);
            }
            catch (OverflowException)
            {
                AddBoundedOverflow(facts, "linux_vault_inotify_record_length_invalid");
                return;
            }

            if (recordLength > buffer.Length - offset)
            {
                AddBoundedOverflow(facts, "linux_vault_inotify_record_truncated");
                return;
            }

            string? name = DecodeName(buffer.Slice(offset + EventHeaderSize, (int)nameLength));
            if (nameLength != 0 && name is null)
            {
                Invalidate("linux_vault_inotify_name_invalid");
                if (facts.Count >= _options.MaxFactsPerRead - 1)
                {
                    AddBoundedOverflow(facts, "linux_vault_user_queue_bound_exceeded");
                    return;
                }

                facts.Add(CreateFact(
                    mask,
                    LinuxVaultFactClass.Unknown,
                    cookie == 0 ? null : cookie,
                    null,
                    null,
                    LinuxVaultPathDisposition.Blocked,
                    "linux_vault_inotify_name_invalid",
                    rescanRequired: true));
                offset += recordLength;
                continue;
            }

            LinuxVaultRawFact fact = ConvertRecord(watchDescriptor, mask, cookie, name);
            if (facts.Count >= _options.MaxFactsPerRead - 1)
            {
                AddBoundedOverflow(facts, "linux_vault_user_queue_bound_exceeded");
                return;
            }

            facts.Add(fact);
            offset += recordLength;
        }
    }

    private LinuxVaultRawFact ConvertRecord(int watchDescriptor, uint mask, uint cookie, string? name)
    {
        LinuxVaultFactClass factClass = Classify(mask);
        if (factClass == LinuxVaultFactClass.QueueOverflow)
        {
            Invalidate("linux_vault_inotify_queue_overflow");
            return CreateFact(
                mask,
                LinuxVaultFactClass.QueueOverflow,
                null,
                null,
                null,
                LinuxVaultPathDisposition.None,
                "linux_vault_inotify_queue_overflow",
                rescanRequired: true);
        }

        WatchEntry? watch = _watches.GetValueOrDefault(watchDescriptor);
        if (watch is null)
        {
            Invalidate("linux_vault_watch_descriptor_unknown");
            return CreateFact(
                mask,
                LinuxVaultFactClass.Unknown,
                null,
                null,
                null,
                LinuxVaultPathDisposition.Blocked,
                "linux_vault_watch_descriptor_unknown",
                rescanRequired: true);
        }

        if (factClass == LinuxVaultFactClass.Unknown)
        {
            Invalidate("linux_vault_inotify_mask_unknown");
            return CreateFact(
                mask,
                LinuxVaultFactClass.Unknown,
                null,
                null,
                null,
                LinuxVaultPathDisposition.Blocked,
                "linux_vault_inotify_mask_unknown",
                rescanRequired: true);
        }

        bool watchedRoot = watch.RelativePath.Length == 0 && name is null;
        string? relativePath = watchedRoot ? string.Empty : BuildRelativePath(watch.RelativePath, name);
        LinuxVaultRootVerifier.PathVerification path = watchedRoot
            ? LinuxVaultRootVerifier.VerifyWatchedRoot(_root)
            : relativePath is null
                ? new(LinuxVaultPathDisposition.None, null)
                : LinuxVaultRootVerifier.VerifyRelativePath(_root, relativePath);
        string? error = path.ErrorCode;
        bool rescanRequired = path.Disposition is LinuxVaultPathDisposition.Blocked or LinuxVaultPathDisposition.ControlTree;
        if (path.Disposition == LinuxVaultPathDisposition.ControlTree && error is null)
        {
            error = "linux_vault_control_tree_observed";
        }

        if ((mask & InotifyNative.Ignored) != 0)
        {
            error = "linux_vault_watch_invalidated";
            rescanRequired = true;
            RemoveWatch(watchDescriptor);
        }
        else if ((mask & InotifyNative.Unmount) != 0)
        {
            error = "linux_vault_root_unmounted";
            rescanRequired = true;
        }
        else if ((mask & (InotifyNative.DeleteSelf | InotifyNative.MoveSelf)) != 0 && watch?.RelativePath.Length == 0)
        {
            error = "linux_vault_root_lost";
            rescanRequired = true;
            factClass = LinuxVaultFactClass.RootLost;
        }

        if (rescanRequired)
        {
            Invalidate(error ?? "linux_vault_rescan_required");
        }

        LinuxVaultRawFact fact = CreateFact(
            mask,
            factClass,
            cookie == 0 ? null : cookie,
            factClass == LinuxVaultFactClass.MovedFrom ? relativePath : null,
            factClass == LinuxVaultFactClass.MovedFrom ? null : relativePath,
            path.Disposition,
            error,
            rescanRequired);

        if ((mask & InotifyNative.IsDirectory) != 0
            && (mask & (InotifyNative.Create | InotifyNative.MovedTo)) != 0
            && relativePath is not null
            && path.Disposition == LinuxVaultPathDisposition.Source)
        {
            string absolutePath = Path.Combine(_root.CanonicalPath, relativePath.Replace('/', Path.DirectorySeparatorChar));
            AddDirectoryTree(absolutePath, relativePath, initial: false);
        }

        return fact;
    }

    private void AddDirectoryTree(string absolutePath, string relativePath, bool initial)
    {
        AddDirectory(absolutePath, relativePath, initial);
        IEnumerable<string> children;
        try
        {
            children = Directory.EnumerateDirectories(absolutePath).Order(StringComparer.Ordinal).ToArray();
        }
        catch (Exception exception) when (exception is IOException or UnauthorizedAccessException)
        {
            HandleWatchFailure(relativePath, "linux_vault_directory_enumeration_failed", initial, exception);
            return;
        }

        foreach (string child in children)
        {
            string childRelative = relativePath.Length == 0
                ? Path.GetFileName(child)
                : $"{relativePath}/{Path.GetFileName(child)}";
            LinuxVaultRootVerifier.PathVerification verification = LinuxVaultRootVerifier.VerifyRelativePath(_root, childRelative);
            if (verification.Disposition == LinuxVaultPathDisposition.Blocked)
            {
                HandleWatchFailure(childRelative, verification.ErrorCode ?? "linux_vault_directory_blocked", initial, null);
                continue;
            }

            AddDirectoryTree(child, childRelative, initial);
        }
    }

    private void AddDirectory(string absolutePath, string relativePath, bool initial)
    {
        if (_watchedPaths.Contains(absolutePath))
        {
            return;
        }

        if (_watches.Count >= _options.MaxWatches)
        {
            HandleWatchFailure(relativePath, "linux_vault_watch_set_bound_exceeded", initial, null);
            return;
        }

        int watchDescriptor = InotifyNative.AddWatch(
            InotifyNative.FileDescriptor(_inotifyHandle),
            absolutePath,
            InotifyNative.WatchMask);
        if (watchDescriptor < 0)
        {
            int error = Marshal.GetLastPInvokeError();
            HandleWatchFailure(relativePath, $"linux_vault_inotify_add_watch_failed_{error}", initial, new Win32Exception(error));
            return;
        }

        _watches[watchDescriptor] = new(absolutePath, relativePath);
        _watchedPaths.Add(absolutePath);
    }

    private void HandleWatchFailure(string relativePath, string error, bool initial, Exception? exception)
    {
        Invalidate(error);
        if (initial && relativePath.Length == 0)
        {
            throw new LinuxVaultWatcherException(error, exception);
        }

        EnqueueBounded(CreateFact(
            0,
            error.Contains("permission", StringComparison.Ordinal)
                ? LinuxVaultFactClass.PermissionBlocked
                : LinuxVaultFactClass.DynamicWatchFailed,
            null,
            null,
            relativePath.Length == 0 ? null : relativePath,
            LinuxVaultPathDisposition.Blocked,
            error,
            rescanRequired: true));
    }

    private void EnqueueBounded(LinuxVaultRawFact fact)
    {
        if (_pendingFacts.Count < _options.MaxFactsPerRead - 1)
        {
            _pendingFacts.Enqueue(fact);
            return;
        }

        if (_pendingOverflowReported)
        {
            return;
        }

        _pendingOverflowReported = true;
        Invalidate("linux_vault_user_queue_bound_exceeded");
        if (_pendingFacts.Count >= _options.MaxFactsPerRead - 1)
        {
            _pendingFacts.Dequeue();
        }

        _pendingFacts.Enqueue(CreateFact(
            0,
            LinuxVaultFactClass.QueueOverflow,
            null,
            null,
            null,
            LinuxVaultPathDisposition.None,
            "linux_vault_user_queue_bound_exceeded",
            rescanRequired: true));
    }

    private void DrainPending(List<LinuxVaultRawFact> facts)
    {
        while (_pendingFacts.Count > 0 && facts.Count < _options.MaxFactsPerRead)
        {
            facts.Add(_pendingFacts.Dequeue());
        }

        if (_pendingFacts.Count == 0)
        {
            _pendingOverflowReported = false;
        }
    }

    private void AddBoundedOverflow(List<LinuxVaultRawFact> facts, string error)
    {
        Invalidate(error);
        if (facts.Count >= _options.MaxFactsPerRead)
        {
            facts.RemoveAt(facts.Count - 1);
        }

        facts.Add(CreateFact(
            InotifyNative.QueueOverflow,
            LinuxVaultFactClass.QueueOverflow,
            null,
            null,
            null,
            LinuxVaultPathDisposition.None,
            error,
            rescanRequired: true));
    }

    private LinuxVaultRawFact CreateFact(
        uint mask,
        LinuxVaultFactClass factClass,
        uint? cookie,
        string? oldRelativePath,
        string? newRelativePath,
        LinuxVaultPathDisposition disposition,
        string? error,
        bool rescanRequired)
    {
        long sequence = checked(++_nextSequence);
        Watermark = Watermark with
        {
            LastSequence = sequence
        };
        long unixNanoseconds = checked(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds() * 1_000_000L);
        long monotonicNanoseconds = checked((long)(
            (Int128)System.Diagnostics.Stopwatch.GetTimestamp()
            * 1_000_000_000L
            / System.Diagnostics.Stopwatch.Frequency));
        return LinuxVaultRawFactCodec.Seal(new LinuxVaultRawFact(
            LinuxVaultWatcherSchemas.RawFact,
            LinuxVaultWatcherSchemas.Version,
            LinuxVaultWatcherSchemas.Platform,
            Identity.Filesystem.FileSystemType,
            Identity.SiteIdentity,
            Identity.VaultIdentity,
            Identity.DeviceIdentity,
            Identity.AgentIdentity,
            Identity.RootIdentity,
            Identity.RootManifestSha256,
            Identity.WatchInstanceIdentity,
            sequence,
            mask,
            factClass,
            cookie,
            oldRelativePath,
            newRelativePath,
            unixNanoseconds,
            monotonicNanoseconds,
            disposition,
            error,
            rescanRequired,
            Watermark.IsValid,
            string.Empty));
    }

    private void Invalidate(string reasonCode)
    {
        Watermark = Watermark with
        {
            LastSequence = _nextSequence,
            IsValid = false,
            InvalidatedReasonCode = reasonCode,
            RescanReceiptSha256 = null
        };
    }

    private void RemoveWatch(int watchDescriptor)
    {
        if (_watches.Remove(watchDescriptor, out WatchEntry? watch))
        {
            _watchedPaths.Remove(watch.AbsolutePath);
        }
    }

    private static string? DecodeName(ReadOnlySpan<byte> bytes)
    {
        int terminator = bytes.IndexOf((byte)0);
        ReadOnlySpan<byte> nameBytes = terminator >= 0 ? bytes[..terminator] : bytes;
        if (nameBytes.Length == 0)
        {
            return null;
        }

        try
        {
            string name = s_strictUtf8.GetString(nameBytes);
            return name.IndexOfAny(['\0', '/', '\\']) >= 0 ? null : name;
        }
        catch (DecoderFallbackException)
        {
            return null;
        }
    }

    private static string? BuildRelativePath(string? directory, string? name)
    {
        if (name is null)
        {
            return string.IsNullOrEmpty(directory) ? null : directory;
        }

        return string.IsNullOrEmpty(directory) ? name : $"{directory}/{name}";
    }

    private static LinuxVaultFactClass Classify(uint mask)
    {
        if ((mask & InotifyNative.QueueOverflow) != 0)
            return LinuxVaultFactClass.QueueOverflow;
        if ((mask & InotifyNative.Ignored) != 0)
            return LinuxVaultFactClass.WatchInvalidated;
        if ((mask & InotifyNative.Unmount) != 0)
            return LinuxVaultFactClass.Unmounted;
        if ((mask & InotifyNative.DeleteSelf) != 0)
            return LinuxVaultFactClass.DeleteSelf;
        if ((mask & InotifyNative.MoveSelf) != 0)
            return LinuxVaultFactClass.MoveSelf;
        if ((mask & InotifyNative.MovedFrom) != 0)
            return LinuxVaultFactClass.MovedFrom;
        if ((mask & InotifyNative.MovedTo) != 0)
            return LinuxVaultFactClass.MovedTo;
        if ((mask & InotifyNative.Create) != 0)
            return LinuxVaultFactClass.Created;
        if ((mask & InotifyNative.Delete) != 0)
            return LinuxVaultFactClass.Deleted;
        if ((mask & InotifyNative.CloseWrite) != 0)
            return LinuxVaultFactClass.ClosedAfterWrite;
        if ((mask & InotifyNative.Modify) != 0)
            return LinuxVaultFactClass.Modified;
        if ((mask & InotifyNative.Attributes) != 0)
            return LinuxVaultFactClass.AttributesChanged;
        return LinuxVaultFactClass.Unknown;
    }

    private static LinuxVaultWatcherException NativeFailure(string reasonCode)
    {
        int error = Marshal.GetLastPInvokeError();
        return new LinuxVaultWatcherException($"{reasonCode}_{error}", new Win32Exception(error));
    }

    private static bool IsSha256(string value)
        => value.Length == 64 && value.All(static character => char.IsAsciiHexDigit(character));

    private sealed record WatchEntry(string AbsolutePath, string RelativePath);
}
