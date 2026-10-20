namespace FsusBlog.Migration;

// Process-owned, closed callbacks capture their owner's authority. Neither this
// sequencing gate nor callback completion mints custody or proves receipt staging.
// The retained-batch owner must invoke the second boundary after all real receipts.
internal sealed class OfflineMigrationApplyHooks(
    Func<CancellationToken, Task> beforeLocks,
    Func<CancellationToken, Task> afterOutboxStaged)
{
    private readonly Func<CancellationToken, Task> _beforeLocks =
        beforeLocks ?? throw new ArgumentNullException(nameof(beforeLocks));
    private readonly Func<CancellationToken, Task> _afterOutboxStaged =
        afterOutboxStaged ?? throw new ArgumentNullException(nameof(afterOutboxStaged));
    private int _state;

    internal async Task BeforeLocksAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref _state, 1, 0) != 0)
        {
            throw new InvalidOperationException("offline_apply_hook_order_required");
        }
        await _beforeLocks(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        Volatile.Write(ref _state, 2);
    }

    internal async Task AfterOutboxStagedAsync(CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (Interlocked.CompareExchange(ref _state, 3, 2) != 2)
        {
            throw new InvalidOperationException("offline_apply_hook_order_required");
        }
        // Await actual terminal completion, including when cancellation arrives.
        await _afterOutboxStaged(token).ConfigureAwait(false);
        token.ThrowIfCancellationRequested();
        Volatile.Write(ref _state, 4);
    }

    internal void RequireCompleted()
    {
        if (Volatile.Read(ref _state) != 4)
        {
            throw new InvalidOperationException("offline_apply_outbox_hook_incomplete");
        }
    }
}
