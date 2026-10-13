using System.Runtime.InteropServices;
using System.Runtime.Versioning;
using System.Text;

using FsusBlog.Algorithms.IO;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Holds a native exclusive lock for the whole lease lifetime. Requires provisioned current-user
/// control files; never creates permissions, steals a live lock, or exposes user-content writes.
/// </summary>
[SupportedOSPlatform("linux")]
public sealed class LinuxVaultWriterLeaseScope : IDisposable
{
    private const int MaximumJournalBytes = 1024 * 1024;
    private readonly object _gate = new();
    private readonly string _controlPath;
    private readonly SafeFileHandle _handle;
    private readonly FileStream _journal;
    private readonly NativeRegularFileGuard.OriginalHeldRegularFileIdentity _fileIdentity;
    private readonly LinuxVaultRootVerifier.VerifiedLinuxVaultRoot _root;
    private long _bootDeadline;
    private bool _revoked;
    private bool _disposed;

    private LinuxVaultWriterLeaseScope(
        string controlPath,
        SafeFileHandle handle,
        FileStream journal,
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root,
        ArticleVaultAgentBinding binding,
        CancellationToken cancellationToken)
    {
        _controlPath = controlPath;
        _handle = handle;
        _journal = journal;
        _root = root;
        _fileIdentity = NativeRegularFileGuard.CaptureOriginalHeldRegularFileIdentity(controlPath, handle, cancellationToken);
        ArticleVaultWriterLeaseReceipt? previous = ReadJournal();
        long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        if (previous?.State == ArticleVaultWriterLeaseState.Active)
        {
            // Native lock ownership is the authority: if we hold it, the previous process has
            // released/died. A stale receipt alone never authorizes acquisition or takeover.
            previous = Append(ArticleVaultWriterLease.Transition(previous, previous.Binding,
                ArticleVaultWriterLeaseAction.Revoke, previous.ContentSha256, now));
        }

        Receipt = Append(ArticleVaultWriterLease.Transition(previous, binding,
            ArticleVaultWriterLeaseAction.Acquire, previous?.ContentSha256, now));
        _bootDeadline = LinuxVaultLeaseNative.BootMilliseconds() + ArticleVaultWriterLease.MaximumLeaseMilliseconds;
    }

    public ArticleVaultWriterLeaseReceipt Receipt
    {
        get; private set;
    }

    internal string RootManifestSha256 => _root.Manifest.ContentSha256;

    internal string LifecycleJournalPath
        => Path.Combine(ControlDirectory, ArticleVaultAgentProtocol.Digest(new[]
        {
            Receipt.Binding.SiteIdentity, Receipt.Binding.VaultIdentity
        }) + ".agent-lifecycle");

    internal SafeFileHandle OpenLifecycleJournal(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            RequireCurrent(cancellationToken);
            using SafeFileHandle directory = OpenControlDirectory();
            SafeFileHandle handle = LinuxVaultLeaseNative.Own(LinuxVaultLeaseNative.OpenAt(
                LinuxVaultLeaseNative.Descriptor(directory), Path.GetFileName(LifecycleJournalPath), LinuxVaultLeaseNative.LeaseFlags));
            try
            {
                LinuxVaultLeaseNative.RequirePrivate(handle, directory: false);
                if (LinuxVaultLeaseNative.Lock(LinuxVaultLeaseNative.Descriptor(handle), 2 | 4) != 0)
                {
                    throw new InvalidDataException("agent_lifecycle_journal_already_owned");
                }

                return handle;
            }
            catch
            {
                handle.Dispose();
                throw;
            }
        }
    }

    /// <summary>The operator-owned namespace is fixed per current user, not chosen per process.</summary>
    public static string ControlDirectory
        => $"/run/user/{LinuxVaultLeaseNative.CurrentUser()}/fsusblog-vault";

    public static string ControlFileName(ArticleVaultRootManifest root)
        => ArticleVaultAgentProtocol.Digest(new[] { root.SiteIdentity, root.VaultIdentity }) + ".writer-lease";

    public static LinuxVaultWriterLeaseScope Open(
        string rootPath,
        ArticleVaultRootManifest manifest,
        string agentInstanceIdentity,
        string userSessionIdentity,
        string agentVersion,
        string binarySha256,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!OperatingSystem.IsLinux() || RuntimeInformation.ProcessArchitecture is not (Architecture.X64 or Architecture.Arm64))
        {
            throw new PlatformNotSupportedException("writer_lease_native_platform_unavailable");
        }

        ArticleVaultRootManifest snapshot = ArticleVaultManifestCodec.DeserializeRoot(ArticleVaultManifestCodec.Serialize(manifest));
        LinuxVaultRootVerifier.VerifiedLinuxVaultRoot root = LinuxVaultRootVerifier.Verify(
            new(rootPath, snapshot, agentInstanceIdentity, new()));
        string rootSha256 = ArticleVaultAgentProtocol.Digest(new
        {
            snapshot.SiteIdentity,
            snapshot.VaultIdentity,
            snapshot.DeviceIdentity,
            root.CanonicalPath,
            root.Filesystem.MountIdentity,
            root.Filesystem.FileSystemType
        });
        var binding = new ArticleVaultAgentBinding(snapshot.SiteIdentity, snapshot.VaultIdentity,
            snapshot.DeviceIdentity, agentInstanceIdentity, userSessionIdentity, rootSha256,
            binarySha256, agentVersion, ArticleVaultAgentProtocol.Version);
        if (!ArticleVaultAgentProtocol.IsBinding(binding))
        {
            throw new InvalidDataException("writer_lease_binding_invalid");
        }

        using SafeFileHandle directory = OpenControlDirectory();
        string name = ControlFileName(snapshot);
        SafeFileHandle handle = LinuxVaultLeaseNative.Own(LinuxVaultLeaseNative.OpenAt(
            LinuxVaultLeaseNative.Descriptor(directory), name, LinuxVaultLeaseNative.LeaseFlags));
        FileStream? journal = null;
        try
        {
            LinuxVaultLeaseNative.RequirePrivate(handle, directory: false);
            if (LinuxVaultLeaseNative.Lock(LinuxVaultLeaseNative.Descriptor(handle), 2 | 4) != 0)
            {
                throw new InvalidDataException("writer_lease_already_owned_or_lock_unavailable");
            }

            cancellationToken.ThrowIfCancellationRequested();
            journal = new FileStream(handle, FileAccess.ReadWrite);
            return new(Path.Combine(ControlDirectory, name), handle, journal, root, binding, cancellationToken);
        }
        catch
        {
            journal?.Dispose();
            handle.Dispose();
            throw;
        }
    }

    /// <summary>Revalidates native file/root facts, wall-clock and suspend-aware kernel deadline.</summary>
    public void RequireCurrent(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            cancellationToken.ThrowIfCancellationRequested();
            ValidateNative(cancellationToken);
            long now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (_revoked || Receipt.State != ArticleVaultWriterLeaseState.Active || now < Receipt.ObservedUnixMilliseconds
                || now >= Receipt.DeadlineUnixMilliseconds || LinuxVaultLeaseNative.BootMilliseconds() >= _bootDeadline)
            {
                throw new InvalidDataException("writer_lease_expired_or_clock_drift");
            }
        }
    }

    public ArticleVaultWriterLeaseReceipt Renew(string expectedReceiptSha256, CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            RequireCurrent(cancellationToken);
            Receipt = Append(ArticleVaultWriterLease.Transition(Receipt, Receipt.Binding,
                ArticleVaultWriterLeaseAction.Renew, expectedReceiptSha256, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            _bootDeadline = LinuxVaultLeaseNative.BootMilliseconds() + ArticleVaultWriterLease.MaximumLeaseMilliseconds;
            return Receipt;
        }
    }

    /// <summary>Revokes authority immediately; retains the kernel lock until owned work is stopped.</summary>
    public ArticleVaultWriterLeaseReceipt Revoke(CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            ObjectDisposedException.ThrowIf(_disposed, this);
            _revoked = true;
            cancellationToken.ThrowIfCancellationRequested();
            ValidateNative(cancellationToken);
            if (Receipt.State == ArticleVaultWriterLeaseState.Active)
            {
                Receipt = Append(ArticleVaultWriterLease.Transition(Receipt, Receipt.Binding,
                    ArticleVaultWriterLeaseAction.Revoke, Receipt.ContentSha256, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
            }

            return Receipt;
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

            _revoked = true;

            // Caller must stop owned work before disposal. Closing this scope is always terminal,
            // even if journal/native verification fails; no cleanup deletes the resident inode.
            try
            {
                if (Receipt.State == ArticleVaultWriterLeaseState.Active)
                {
                    using var cancellation = new CancellationTokenSource();
                    ValidateNative(cancellation.Token);
                    Receipt = Append(ArticleVaultWriterLease.Transition(Receipt, Receipt.Binding,
                        ArticleVaultWriterLeaseAction.Release, Receipt.ContentSha256, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()));
                }
            }
            finally
            {
                _disposed = true;
                _journal.Dispose();
                _handle.Dispose();
            }
        }
    }

    private void ValidateNative(CancellationToken cancellationToken)
    {
        using SafeFileHandle directory = OpenControlDirectory();
        LinuxVaultLeaseNative.RequirePrivate(_handle, directory: false);
        NativeRegularFileGuard.ValidateOriginalHeldRegularFileUnchanged(_controlPath, _handle, _fileIdentity, cancellationToken);
        LinuxVaultRootVerifier.PathVerification root = LinuxVaultRootVerifier.VerifyWatchedRoot(_root);
        if (root.Disposition == LinuxVaultPathDisposition.Blocked)
        {
            throw new InvalidDataException(root.ErrorCode ?? "writer_lease_root_blocked");
        }
    }

    internal static SafeFileHandle OpenControlDirectory()
    {
        SafeFileHandle current = LinuxVaultLeaseNative.Own(LinuxVaultLeaseNative.OpenAt(-100, "/", LinuxVaultLeaseNative.DirectoryFlags));
        try
        {
            foreach (string component in ControlDirectory.Split('/', StringSplitOptions.RemoveEmptyEntries))
            {
                SafeFileHandle next = LinuxVaultLeaseNative.Own(LinuxVaultLeaseNative.OpenAt(
                    LinuxVaultLeaseNative.Descriptor(current), component, LinuxVaultLeaseNative.DirectoryFlags));
                current.Dispose();
                current = next;
            }

            LinuxVaultLeaseNative.RequirePrivate(current, directory: true);
            return current;
        }
        catch
        {
            current.Dispose();
            throw;
        }
    }

    private ArticleVaultWriterLeaseReceipt? ReadJournal()
    {
        if (_journal.Length > MaximumJournalBytes)
        {
            throw new InvalidDataException("writer_lease_journal_budget_exceeded");
        }

        byte[] bytes = new byte[checked((int)_journal.Length)];
        _journal.ReadExactly(bytes);
        if (bytes.Length > 0 && bytes[^1] != '\n')
        {
            throw new InvalidDataException("writer_lease_journal_incomplete_recovery_required");
        }

        ArticleVaultWriterLeaseReceipt? previous = null;
        foreach (string line in Encoding.UTF8.GetString(bytes).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            ArticleVaultWriterLeaseReceipt next = ArticleVaultWriterLeaseCodec.Decode(Encoding.UTF8.GetBytes(line));
            if (!ArticleVaultWriterLease.VerifyTransition(previous, next))
            {
                throw new InvalidDataException("writer_lease_journal_chain_invalid");
            }

            previous = next;
        }

        return previous;
    }

    private ArticleVaultWriterLeaseReceipt Append(ArticleVaultWriterLeaseReceipt receipt)
    {
        byte[] bytes = ArticleVaultAgentProtocol.Encode(receipt);
        if (_journal.Length + bytes.Length + 1 > MaximumJournalBytes)
        {
            throw new InvalidDataException("writer_lease_journal_budget_exceeded");
        }

        _journal.Position = _journal.Length;
        _journal.Write(bytes);
        _journal.WriteByte((byte)'\n');
        _journal.Flush(flushToDisk: true);
        return receipt;
    }
}
