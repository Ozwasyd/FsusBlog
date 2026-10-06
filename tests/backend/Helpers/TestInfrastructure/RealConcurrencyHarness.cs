using System;
using System.Collections.Generic;
using System.Linq;
using System.Threading.Tasks;

namespace FsusBlog.Server.Tests.TestInfrastructure;

/// <summary>
/// Test-owned C# counterpart of tools/contracts/behavior-test.mjs.
/// Validates worker functions before starting any work, schedules all workers,
/// and observes every worker before returning or propagating failure/cancellation.
/// Domain barriers and release signals remain owned by each test.
/// </summary>
internal static class RealConcurrencyHarness
{
    internal const string Id = "fsusblog.real-concurrency.v1";

    internal static Task<T[]> RunAsync<T>(params Func<Task<T>>[] workers)
    {
        Validate(workers);
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<T>[] tasks = workers.Select(worker => Task.Run(async () =>
        {
            await start.Task;
            return await worker();
        })).ToArray();
        start.SetResult();
        return Task.WhenAll(tasks);
    }

    internal static Task RunAsync(params Func<Task>[] workers)
    {
        Validate(workers);
        var start = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        Task[] tasks = workers.Select(worker => Task.Run(async () =>
        {
            await start.Task;
            await worker();
        })).ToArray();
        start.SetResult();
        return Task.WhenAll(tasks);
    }

    internal static Task<TResult[]> RunAsync<TInput, TResult>(IEnumerable<TInput> inputs, Func<TInput, Task<TResult>> worker)
    {
        ArgumentNullException.ThrowIfNull(inputs);
        ArgumentNullException.ThrowIfNull(worker);
        return RunAsync(inputs.Select(input => (Func<Task<TResult>>)(() => worker(input))).ToArray());
    }

    internal static void Run(params Action[] workers)
    {
        Validate(workers);
        RunAsync(workers.Select(worker => (Func<Task>)(() =>
        {
            worker();
            return Task.CompletedTask;
        })).ToArray()).GetAwaiter().GetResult();
    }

    internal static void Run(int fromInclusive, int toExclusive, Action<int> worker)
    {
        ArgumentNullException.ThrowIfNull(worker);
        Run(Enumerable.Range(fromInclusive, checked(toExclusive - fromInclusive))
            .Select(index => (Action)(() => worker(index))).ToArray());
    }

    /// <summary>
    /// Runs the operation and the domain interleaving controller as two workers.
    /// The controller receives the actual operation task, so existing assertions
    /// can inspect its incomplete state and its result without polling substitutes.
    /// Its cleanup always releases domain gates, including when an assertion fails.
    /// Expected failure/cancellation belongs inside an assertion in the operation.
    /// </summary>
    internal static Task RunInterleavedAsync<T>(
        Func<Task<T>> operation,
        Func<Task<T>, Task> concurrentWorker,
        Action cleanup,
        TimeSpan? startupTimeout = null)
        => RunInterleavedAsync(operation, concurrentWorker, () =>
        {
            cleanup();
            return Task.CompletedTask;
        }, startupTimeout);

    internal static Task RunInterleavedAsync<T>(
        Func<Task<T>> operation,
        Func<Task<T>, Task> concurrentWorker,
        Func<Task> cleanup,
        TimeSpan? startupTimeout = null)
    {
        ArgumentNullException.ThrowIfNull(operation);
        ArgumentNullException.ThrowIfNull(concurrentWorker);
        ArgumentNullException.ThrowIfNull(cleanup);
        var started = new TaskCompletionSource<Task<T>>(TaskCreationOptions.RunContinuationsAsynchronously);
        return RunAsync(
            async () =>
            {
                try
                {
                    Task<T> pending = operation();
                    started.SetResult(pending);
                    await pending;
                }
                catch (Exception error)
                {
                    started.TrySetException(error);
                    throw;
                }
            },
            async () =>
            {
                try
                {
                    await concurrentWorker(await started.Task.WaitAsync(startupTimeout ?? TimeSpan.FromSeconds(5)));
                }
                finally
                {
                    await cleanup();
                }
            });
    }

    internal static Task RunInterleavedAsync(
        Func<Task> operation,
        Func<Task, Task> concurrentWorker,
        Action cleanup,
        TimeSpan? startupTimeout = null)
        => RunInterleavedAsync(async () =>
        {
            await operation();
            return true;
        }, pending => concurrentWorker(pending), cleanup, startupTimeout);

    private static void Validate<T>(T[] workers) where T : Delegate
    {
        ArgumentNullException.ThrowIfNull(workers);
        if (workers.Length < 2)
        {
            throw new ArgumentException("Real concurrency requires at least two worker functions.", nameof(workers));
        }
        if (workers.Any(worker => worker is null))
        {
            throw new ArgumentException("Every concurrency worker must be a function.", nameof(workers));
        }
    }
}
