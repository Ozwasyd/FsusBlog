namespace FsusBlog.Migration;

// Closed callbacks provide sequencing notifications only. Completion neither
// mints custody nor proves receipt staging. Production admission remains blocked
// until the root and retained-batch owners supply an enforceable witness port.
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

    internal void RequireCallbacksCompleted()
    {
        if (Volatile.Read(ref _state) != 4)
        {
            throw new InvalidOperationException("offline_apply_outbox_hook_incomplete");
        }
    }

    // No production witness port exists in this assembly combination. In
    // particular, successful empty delegates cannot authorize mutation/settlement.
    internal void RequireProductionWitness()
        => throw new InvalidOperationException("offline_apply_root_receipt_witness_unavailable");

    // Tracks the full entered native callback, including its pre/post boundary
    // checks. Closing admission joins actual completion even if its caller drops
    // the returned task. It conveys lifetime only, never transaction authority.
    internal sealed class CallbackLifetime
    {
        private readonly object _sync = new();
        private Task? _entered;
        private bool _closed;

        internal Task RunAsync(Func<Task> callback)
        {
            ArgumentNullException.ThrowIfNull(callback);
            TaskCompletionSource terminal;
            lock (_sync)
            {
                if (_closed || _entered is not null)
                    throw new InvalidOperationException("offline_apply_hook_lifetime_closed");
                terminal = new(TaskCreationOptions.RunContinuationsAsynchronously);
                _entered = terminal.Task;
            }
            // CompleteAsync catches every callback exception and transfers it to
            // the task retained by both the caller and the original scope owner.
            _ = CompleteAsync(callback, terminal);
            return terminal.Task;
        }

        internal Task CloseAsync()
        {
            lock (_sync)
            {
                _closed = true;
                return _entered ?? Task.CompletedTask;
            }
        }

        private static async Task CompleteAsync(Func<Task> callback, TaskCompletionSource terminal)
        {
            try
            {
                await callback().ConfigureAwait(false);
                terminal.SetResult();
            }
            catch (Exception failure)
            {
                terminal.SetException(failure);
            }
        }
    }
}
