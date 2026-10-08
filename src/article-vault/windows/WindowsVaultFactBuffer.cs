using System.Diagnostics;

namespace FsusBlog.ArticleVault.Windows;

/// <summary>Retains ordered raw facts within a fixed bound, reserving one slot for observable loss.</summary>
internal sealed class WindowsVaultFactBuffer
{
    private readonly object _gate = new();
    private readonly Queue<WindowsVaultRawFact> _facts = [];
    private readonly WindowsVaultWatchIdentity _identity;
    private readonly int _capacity;
    private long _sequence;
    private bool _overflowReported;
    private string _reasonCode = "windows_vault_watcher_restart";

    internal WindowsVaultFactBuffer(WindowsVaultWatchIdentity identity, int capacity)
    {
        new WindowsVaultWatcherOptions(QueueCapacity: capacity).Validate();
        _identity = identity;
        _capacity = capacity;
        Failure(WindowsVaultFactClass.WatcherRestarted, _reasonCode);
    }

    internal WindowsVaultWatermark Watermark
    {
        get
        {
            lock (_gate)
            {
                return new(_identity.WatchInstanceIdentity, _sequence, false, _reasonCode);
            }
        }
    }

    internal void Receive(WindowsVaultNativeRecord record, WindowsVaultPathAdmission admission)
    {
        lock (_gate)
        {
            WindowsVaultFactClass factClass = record.Action switch
            {
                1 => WindowsVaultFactClass.Added,
                2 => WindowsVaultFactClass.Removed,
                3 => WindowsVaultFactClass.Modified,
                4 => WindowsVaultFactClass.RenameOldName,
                5 => WindowsVaultFactClass.RenameNewName,
                _ => WindowsVaultFactClass.Unknown
            };
            bool blocked = admission.Disposition is not (WindowsVaultPathDisposition.Source
                or WindowsVaultPathDisposition.MissingEntry);
            string? reason = blocked ? admission.ReasonCode ?? "windows_vault_path_blocked"
                : factClass == WindowsVaultFactClass.Unknown ? "windows_vault_native_action_unknown" : null;
            if (reason is not null)
            {
                _reasonCode = reason;
            }

            Enqueue(Create(record.Action, blocked ? WindowsVaultFactClass.SecurityBlocked : factClass,
                record.Action is 2 or 4 ? record.RelativePath : null,
                record.Action is 2 or 4 ? null : record.RelativePath,
                blocked ? WindowsVaultPathDisposition.Blocked : admission.Disposition,
                null, reason, blocked || factClass == WindowsVaultFactClass.Unknown));
        }
    }

    internal void Failure(WindowsVaultFactClass factClass, string reasonCode, int? nativeError = null)
    {
        lock (_gate)
        {
            _reasonCode = reasonCode;
            Enqueue(Create(0, factClass, null, null, WindowsVaultPathDisposition.None,
                nativeError, reasonCode, true));
        }
    }

    internal IReadOnlyList<WindowsVaultRawFact> Drain()
    {
        lock (_gate)
        {
            WindowsVaultRawFact[] facts = _facts.ToArray();
            _facts.Clear();
            _overflowReported = false;
            return facts;
        }
    }

    private void Enqueue(WindowsVaultRawFact fact)
    {
        if (_facts.Count < _capacity - 1)
        {
            _facts.Enqueue(fact);
            return;
        }

        if (!_overflowReported)
        {
            _reasonCode = "windows_vault_managed_queue_overflow";
            _facts.Enqueue(Create(0, WindowsVaultFactClass.BufferOverflow, null, null,
                WindowsVaultPathDisposition.None, null, _reasonCode, true));
            _overflowReported = true;
        }
    }

    private WindowsVaultRawFact Create(uint action, WindowsVaultFactClass factClass,
        string? oldPath, string? newPath, WindowsVaultPathDisposition disposition,
        int? nativeError, string? reasonCode, bool rescanRequired)
    {
        var fact = new WindowsVaultRawFact(WindowsVaultWatcherSchemas.RawFact,
            WindowsVaultWatcherSchemas.Version, WindowsVaultWatcherSchemas.Platform,
            _identity, checked(++_sequence), action, factClass, oldPath, newPath, null, null,
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), Stopwatch.GetTimestamp(), disposition,
            nativeError, reasonCode, rescanRequired, false, null, string.Empty);
        return fact with
        {
            ContentDigest = WindowsVaultRawFactCodec.ComputeContentDigest(fact)
        };
    }
}
