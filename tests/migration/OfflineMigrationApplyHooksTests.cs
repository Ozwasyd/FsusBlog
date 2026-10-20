using System.Data;

using Npgsql;
using Xunit;

using FsusBlog.Contracts.Migration;

namespace FsusBlog.Migration.Tests;

// Pure sequencing tests are not native receipt or production composition evidence.
public sealed class OfflineMigrationApplyHooksTests
{
    [Fact]
    public async Task Native_acquire_awaits_before_callback_before_touching_family_lock()
    {
        using var connection = new NpgsqlConnection();
        var failure = new InvalidOperationException("before_lock_failure");
        var hooks = new OfflineMigrationApplyHooks(_ => Task.FromException(failure),
            _ => throw new InvalidOperationException("must_not_run"));
        var native = new OfflineMigrationApplyNativeSession(connection,
            CurrentSchemaProviderKind.PostgreSql,
            postgreSqlWriteLock: new OfflineMigrationPostgreSqlWriteLock(1, 2), hooks: hooks);
        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(
            () => native.AcquireAsync(default)));
        Assert.Equal(ConnectionState.Closed, connection.State);
    }

    [Fact]
    public async Task Before_boundary_must_finish_before_after_boundary_can_enter()
    {
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        int afterCalls = 0;
        var hooks = new OfflineMigrationApplyHooks(_ => release.Task, _ =>
        {
            afterCalls++;
            return Task.CompletedTask;
        });
        Task before = hooks.BeforeLocksAsync(default);
        Assert.False(before.IsCompleted);
        Assert.Throws<InvalidOperationException>(hooks.RequireCompleted);
        await Assert.ThrowsAsync<InvalidOperationException>(() => hooks.AfterOutboxStagedAsync(default));
        release.SetResult();
        await before;
        await hooks.AfterOutboxStagedAsync(default);
        hooks.RequireCompleted();
        Assert.Equal(1, afterCalls);
        await Assert.ThrowsAsync<InvalidOperationException>(() => hooks.BeforeLocksAsync(default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => hooks.AfterOutboxStagedAsync(default));
    }

    [Fact]
    public async Task After_boundary_awaits_actual_terminal_even_after_cancellation()
    {
        using var cancellation = new CancellationTokenSource();
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var hooks = new OfflineMigrationApplyHooks(_ => Task.CompletedTask, token =>
        {
            Assert.Equal(cancellation.Token, token);
            return release.Task;
        });
        await hooks.BeforeLocksAsync(cancellation.Token);
        Task after = hooks.AfterOutboxStagedAsync(cancellation.Token);
        cancellation.Cancel();
        Assert.False(after.IsCompleted);
        Assert.Throws<InvalidOperationException>(hooks.RequireCompleted);
        release.SetResult();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => after);
        Assert.Throws<InvalidOperationException>(hooks.RequireCompleted);
    }

    [Fact]
    public async Task Before_failure_is_preserved_and_cannot_be_retried()
    {
        var failure = new InvalidOperationException("original_failure");
        var hooks = new OfflineMigrationApplyHooks(_ => Task.FromException(failure),
            _ => throw new InvalidOperationException("must_not_run"));
        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(
            () => hooks.BeforeLocksAsync(default)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => hooks.BeforeLocksAsync(default));
        await Assert.ThrowsAsync<InvalidOperationException>(() => hooks.AfterOutboxStagedAsync(default));
    }

    [Fact]
    public async Task After_failure_is_preserved_and_cannot_be_retried()
    {
        var failure = new InvalidOperationException("original_failure");
        var hooks = new OfflineMigrationApplyHooks(_ => Task.CompletedTask, _ => Task.FromException(failure));
        await hooks.BeforeLocksAsync(default);
        Assert.Same(failure, await Assert.ThrowsAsync<InvalidOperationException>(
            () => hooks.AfterOutboxStagedAsync(default)));
        await Assert.ThrowsAsync<InvalidOperationException>(() => hooks.AfterOutboxStagedAsync(default));
    }

    [Fact]
    public async Task Cancelled_entry_does_not_invoke_callback()
    {
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        int calls = 0;
        var hooks = new OfflineMigrationApplyHooks(_ =>
        {
            calls++;
            return Task.CompletedTask;
        }, _ => Task.CompletedTask);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => hooks.BeforeLocksAsync(cancellation.Token));
        Assert.Equal(0, calls);
    }
}
