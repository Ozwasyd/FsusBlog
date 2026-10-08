using System.Runtime.Versioning;
using System.Text;

using FsusBlog.Algorithms.IO;
using FsusBlog.Shared.Contracts.ArticleVault;

using Microsoft.Win32.SafeHandles;

namespace FsusBlog.ArticleVault.Linux;

/// <summary>
/// Appends only lifecycle/checkpoint references to a provisioned resident control file. Original
/// operation receipts remain in the canonical store. No control/user file is created or removed.
/// </summary>
[SupportedOSPlatform("linux")]
internal sealed class LinuxVaultAgentLifecycleJournal : IDisposable
{
    private const int MaximumJournalBytes = 1024 * 1024;
    private readonly object _gate = new();
    private readonly LinuxVaultWriterLeaseScope _lease;
    private readonly SafeFileHandle _handle;
    private readonly FileStream _stream;
    private readonly string _path;
    private readonly NativeRegularFileGuard.OriginalHeldRegularFileIdentity _identity;
    private bool _disposed;
    private bool _faulted;

    internal LinuxVaultAgentLifecycleJournal(LinuxVaultWriterLeaseScope lease, CancellationToken cancellationToken)
    {
        _lease = lease;
        _path = lease.LifecycleJournalPath;
        _handle = lease.OpenLifecycleJournal(cancellationToken);
        try
        {
            _stream = new FileStream(_handle, FileAccess.ReadWrite);
            _identity = NativeRegularFileGuard.CaptureOriginalHeldRegularFileIdentity(_path, _handle, cancellationToken);
            Tip = Read(cancellationToken);
        }
        catch
        {
            _stream?.Dispose();
            _handle.Dispose();
            throw;
        }
    }

    internal ArticleVaultAgentLifecycleInventoryReceipt? Tip
    {
        get; private set;
    }

    internal ArticleVaultAgentLifecycleInventoryReceipt Append(
        ArticleVaultAgentLifecycleReceipt lifecycle,
        IReadOnlyList<ArticleVaultAgentOperationReference> operations,
        CancellationToken cancellationToken)
    {
        lock (_gate)
        {
            Validate(cancellationToken);
            if (_faulted)
            {
                throw new InvalidDataException("agent_lifecycle_journal_recovery_required");
            }
            ArticleVaultAgentLifecycleInventoryReceipt next = ArticleVaultAgentLifecycleInventory.Create(
                Tip, _lease.RootManifestSha256, _lease.Receipt.Generation, lifecycle, operations);
            byte[] bytes = ArticleVaultAgentProtocol.Encode(next);
            if (_stream.Length + bytes.Length + 1 > MaximumJournalBytes)
            {
                throw new InvalidDataException("agent_lifecycle_journal_budget_exceeded");
            }

            try
            {
                _stream.Position = _stream.Length;
                _stream.Write(bytes);
                _stream.WriteByte((byte)'\n');
                _stream.Flush(flushToDisk: true);
                Validate(cancellationToken);
            }
            catch
            {
                _faulted = true;
                throw;
            }
            Tip = next;
            return next;
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            if (!_disposed)
            {
                _disposed = true;
                _stream.Dispose();
                _handle.Dispose();
            }
        }
    }

    private ArticleVaultAgentLifecycleInventoryReceipt? Read(CancellationToken cancellationToken)
    {
        Validate(cancellationToken);
        if (_stream.Length > MaximumJournalBytes)
        {
            throw new InvalidDataException("agent_lifecycle_journal_budget_exceeded");
        }

        byte[] bytes = new byte[checked((int)_stream.Length)];
        _stream.ReadExactly(bytes);
        if (bytes.Length > 0 && bytes[^1] != '\n')
        {
            throw new InvalidDataException("agent_lifecycle_journal_incomplete_recovery_required");
        }

        ArticleVaultAgentLifecycleInventoryReceipt? previous = null;
        foreach (string line in Encoding.UTF8.GetString(bytes).Split('\n', StringSplitOptions.RemoveEmptyEntries))
        {
            ArticleVaultAgentLifecycleInventoryReceipt next = ArticleVaultAgentLifecycleInventory.Decode(Encoding.UTF8.GetBytes(line));
            if (!ArticleVaultAgentLifecycleInventory.VerifyAppend(previous, next))
            {
                throw new InvalidDataException("agent_lifecycle_journal_chain_invalid");
            }

            previous = next;
        }

        Validate(cancellationToken);
        return previous;
    }

    private void Validate(CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        // This resident journal retains its own exclusive control-file handle until the terminal
        // record has been flushed, including after the active writer lease has been closed.
        // Its historical contents never admit commands, operations or recovery.
        cancellationToken.ThrowIfCancellationRequested();
        using SafeFileHandle directory = LinuxVaultWriterLeaseScope.OpenControlDirectory();
        LinuxVaultLeaseNative.RequirePrivate(_handle, directory: false);
        NativeRegularFileGuard.ValidateOriginalHeldRegularFileUnchanged(_path, _handle, _identity, cancellationToken);
    }
}
