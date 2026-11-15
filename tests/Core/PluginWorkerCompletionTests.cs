using FsusBlog.V2.Core.Extensions;

namespace FsusBlog.V2.Core.Tests;

public sealed class PluginWorkerCompletionTests
{
    [Fact]
    public async Task First_failure_survives_a_release_failure()
    {
        var work = new ExtensionRejectedException("plugin-execution-rejected");
        var cleanup = new IOException();
        var failure = await Assert.ThrowsAsync<ExtensionRejectedException>(() => PluginWorkerCompletion.RunAsync(
            () => Task.FromException<byte[]>(work), () => Task.FromException(cleanup)));

        Assert.Same(work, failure);
        Assert.Same(cleanup, PluginWorkerCompletion.CleanupFailure(failure));
    }

    [Fact]
    public async Task Caller_cancellation_survives_a_release_failure()
    {
        using var caller = new CancellationTokenSource();
        caller.Cancel();
        var cleanup = new TimeoutException();
        var failure = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => PluginWorkerCompletion.RunAsync(
            () => Task.FromCanceled<byte[]>(caller.Token), () => Task.FromException(cleanup)));

        Assert.Equal(caller.Token, failure.CancellationToken);
        Assert.Same(cleanup, PluginWorkerCompletion.CleanupFailure(failure));
    }

    [Fact]
    public async Task Late_cancellation_cannot_replace_deadline_or_either_release_failure()
    {
        using var caller = new CancellationTokenSource();
        using var deadline = new CancellationTokenSource();
        deadline.Cancel();
        var inspectionCleanup = new IOException();
        var workerCleanup = new TimeoutException();
        var failure = await Assert.ThrowsAsync<ExtensionRejectedException>(() => PluginWorkerCompletion.RunAsync(
            () => PluginWorkerCompletion.RunAsync(async () =>
            {
                try { return await Task.FromCanceled<byte[]>(deadline.Token); }
                catch (OperationCanceledException error) when (!caller.IsCancellationRequested)
                {
                    throw PluginWorkerCompletion.Translate(error, "plugin-worker-deadline");
                }
            }, () =>
            {
                caller.Cancel();
                return Task.FromException(inspectionCleanup);
            }), () => Task.FromException(workerCleanup)));

        Assert.True(caller.IsCancellationRequested);
        Assert.Equal("plugin-worker-deadline", failure.Code);
        var cleanup = Assert.IsType<AggregateException>(PluginWorkerCompletion.CleanupFailure(failure));
        Assert.Collection(cleanup.InnerExceptions,
            first => Assert.Same(inspectionCleanup, first), second => Assert.Same(workerCleanup, second));
    }

    [Fact]
    public async Task Release_failure_on_its_own_withholds_output()
    {
        var failure = await Assert.ThrowsAsync<ExtensionRejectedException>(() => PluginWorkerCompletion.RunAsync(
            () => Task.FromResult(new byte[] { 3 }), () => Task.FromException(new IOException())));

        Assert.Equal("plugin-worker-drain", failure.Code);
        Assert.Null(PluginWorkerCompletion.CleanupFailure(failure));
    }

    [Fact]
    public async Task Release_attempts_every_owned_step_in_order_after_failure()
    {
        var first = new IOException();
        var second = new TimeoutException();
        var visits = new List<int>();
        var failure = await Assert.ThrowsAsync<AggregateException>(() => PluginWorkerCompletion.ReleaseAsync(
            () => { visits.Add(1); return Task.FromException(first); },
            () => { visits.Add(2); return Task.FromException(second); },
            () => { visits.Add(3); return Task.CompletedTask; }));

        Assert.Equal(new[] { 1, 2, 3 }, visits);
        Assert.Collection(failure.InnerExceptions, error => Assert.Same(first, error), error => Assert.Same(second, error));
    }

    [Fact]
    public async Task Returns_output_after_release_completes()
    {
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        byte[] output = [5];
        var completion = PluginWorkerCompletion.RunAsync(() => Task.FromResult(output), () => released.Task);

        Assert.False(completion.IsCompleted);
        released.SetResult();
        Assert.Same(output, await completion);
    }
}
