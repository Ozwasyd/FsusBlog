using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using System.Text.Json;

using Microsoft.Extensions.Logging.Abstractions;

using NSubstitute;

using StackExchange.Redis;

using FsusBlog.Server.Infrastructure.Cache;
using FsusBlog.Server.Infrastructure.Execution;
using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Tests.Unit;

public sealed class RedisOperationExecutorTests
{
    [Fact]
    public void FailureDiagnosticsHaveAnIndependentOptInObserverBoundary()
    {
        Type? diagnostics = typeof(RedisOperationExecutor).Assembly.GetType(
            "FsusBlog.Server.Infrastructure.Cache.RedisOperationFailureDiagnostics");
        Assert.NotNull(diagnostics);
        Assert.NotNull(diagnostics.GetMethod(
            "Subscribe",
            System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic));
    }

    [Fact]
    public async Task FailureDiagnosticsAreNoOpWithoutSubscribers()
    {
        Assert.False(RedisOperationFailureDiagnostics.HasSubscribers);
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync<int>(RedisOperationPort.PerceptionChallenge,
                (_, _) => throw new RedisServerException("private-key-payload"), CancellationToken.None));
        Assert.Equal(RedisOperationFailureKind.RedisFailure, failure.FailureKind);
        Assert.Equal(0, executor.DiagnosticIdentity);
    }

    [Fact]
    public async Task FailureDiagnosticsDoNotReadExceptionTextWhenUnsubscribed()
    {
        Assert.False(RedisOperationFailureDiagnostics.HasSubscribers);
        var original = new CountingProviderFailure();
        var executor = new RedisOperationExecutor(new FailingConnectionProvider(original),
            new RedisOperationBudgetCatalog(), TimeProvider.System);
        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(RedisOperationPort.PerceptionChallenge, (_, _) => Task.FromResult(1), CancellationToken.None));
        Assert.Same(original, failure.InnerException);
        // The original filter and final failure mapping each read once; diagnostics must add no read.
        Assert.Equal(2, original.MessageReads);
        Assert.Equal(0, executor.DiagnosticIdentity);
    }

    [Theory]
    [InlineData(0, "redis-connection", RedisOperationFailureKind.RedisFailure)]
    [InlineData(1, "redis-server", RedisOperationFailureKind.RedisFailure)]
    [InlineData(2, "timeout", RedisOperationFailureKind.CommandTimeout)]
    [InlineData(3, "redis-timeout", RedisOperationFailureKind.CommandTimeout)]
    [InlineData(4, "redis-readonly", RedisOperationFailureKind.RedisFailure)]
    [InlineData(5, "redis-moved", RedisOperationFailureKind.RedisFailure)]
    public async Task FailureDiagnosticsKeepClosedCategoriesAndOriginalAtomicFailure(
        int kind, string category, RedisOperationFailureKind failureKind)
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        const string PrivateText = "endpoint-key-payload-secret";
        Exception original = kind switch
        {
            0 => new RedisConnectionException(ConnectionFailureType.UnableToConnect, PrivateText),
            1 => new RedisServerException(PrivateText),
            2 => new TimeoutException(PrivateText),
            3 => new RedisTimeoutException(PrivateText, CommandStatus.Unknown),
            4 => new RedisServerException($"READONLY {PrivateText}"),
            _ => new RedisServerException($"MOVED {PrivateText}")
        };
        int attempts = 0;
        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync<int>(RedisOperationPort.PerceptionChallenge, (_, _) =>
            {
                attempts++;
                throw original;
            }, CancellationToken.None));
        Assert.Same(original, failure.InnerException);
        Assert.Equal(failureKind, failure.FailureKind);
        Assert.Equal(1, attempts);
        RedisOperationFailureDiagnostic observation = Assert.Single(OwnEvents(collector, executor));
        Assert.Equal(category, observation.ExceptionCategory);
        Assert.Equal(RedisOperationDiagnosticStage.Command, observation.Stage);
        Assert.Equal(RedisOperationDiagnosticDisposition.Terminal, observation.Disposition);
        Assert.Equal(1, observation.Attempt);
        Assert.Equal(failureKind, observation.FailureKind);
        Assert.Equal(kind == 0 ? ConnectionFailureType.UnableToConnect : (ConnectionFailureType?)null,
            observation.ConnectionFailure);
        Assert.True(observation.ObservedTimestamp > 0);
        Assert.True(observation.ElapsedMilliseconds >= 0);
        Assert.DoesNotContain(PrivateText, JsonSerializer.Serialize(observation));
    }

    [Fact]
    public async Task FailureDiagnosticsDistinguishConnectionAndCommandDeadlines()
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var connection = new RedisOperationExecutor(new PendingConnectionProvider(),
            new RedisOperationBudgetCatalog(), TimeProvider.System);
        await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => connection.ExecuteAsync(
            RedisOperationPort.PerceptionChallenge, (_, _) => Task.FromResult(1), CancellationToken.None));
        RedisOperationFailureDiagnostic connect = Assert.Single(OwnEvents(collector, connection));
        Assert.Equal(RedisOperationDiagnosticStage.Connection, connect.Stage);
        Assert.Equal("timeout", connect.ExceptionCategory);
        var command = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => command.ExecuteAsync(
            RedisOperationPort.PerceptionChallenge,
            (_, _) => new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously).Task,
            CancellationToken.None));
        RedisOperationFailureDiagnostic execution = Assert.Single(OwnEvents(collector, command));
        Assert.Equal(RedisOperationDiagnosticStage.Command, execution.Stage);
        Assert.NotEqual(connect.ExecutorIdentity, execution.ExecutorIdentity);
        Assert.NotEqual(connect.CallIdentity, execution.CallIdentity);
        Assert.True(execution.Sequence > connect.Sequence);
        Assert.True(execution.ObservedTimestamp >= connect.ObservedTimestamp);
    }

    [Fact]
    public async Task FailureDiagnosticsPreserveRetryAttemptsAndSuccessfulResult()
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        int attempts = 0;
        Assert.Equal(42, await executor.ExecuteAsync(RedisOperationPort.UnifiedCacheRead, (_, _) =>
            ++attempts == 1
                ? Task.FromException<int>(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "private"))
                : Task.FromResult(42), CancellationToken.None));
        Assert.Equal(2, attempts);
        RedisOperationFailureDiagnostic observation = Assert.Single(OwnEvents(collector, executor));
        Assert.Equal(RedisOperationDiagnosticDisposition.Retry, observation.Disposition);
        Assert.Equal(1, observation.Attempt);
    }

    [Fact]
    public async Task FailureDiagnosticsDistinguishInitialFailuresAndCircuitEntryRejection()
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        var catalog = new RedisOperationBudgetCatalog();
        int threshold = catalog.Get(RedisOperationClass.SecurityAtomic).CircuitFailureThreshold;
        int commands = 0;
        for (int index = 0; index <= threshold; index++)
        {
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => executor.ExecuteAsync<int>(
                RedisOperationPort.PerceptionChallenge, (_, _) =>
                {
                    commands++;
                    throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "private");
                }, CancellationToken.None));
        }

        Assert.Equal(threshold, commands);
        RedisOperationFailureDiagnostic[] events = OwnEvents(collector, executor);
        Assert.Equal(threshold + 1, events.Length);
        Assert.All(events.Take(threshold), item => Assert.Equal(RedisOperationDiagnosticDisposition.Terminal, item.Disposition));
        Assert.Equal(RedisOperationDiagnosticStage.CircuitEntry, events[^1].Stage);
        Assert.Equal(RedisOperationDiagnosticDisposition.Rejected, events[^1].Disposition);
        Assert.Equal("none", events[^1].ExceptionCategory);
        Assert.Equal(0, events[^1].Attempt);
        Assert.Null(events[^1].ConnectionFailure);
        Assert.Equal(events.Length, events.Select(static item => item.CallIdentity).Distinct().Count());
    }

    [Fact]
    public async Task FailureDiagnosticsPreserveCallerCancellationAndProviderClassification()
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var unavailable = new RedisOperationExecutor(new UnavailableConnectionProvider(),
            new RedisOperationBudgetCatalog(), TimeProvider.System);
        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            unavailable.ExecuteAsync(RedisOperationPort.PerceptionChallenge, (_, _) => Task.FromResult(1), CancellationToken.None));
        Assert.Equal(RedisOperationFailureKind.ConnectionUnavailable, failure.FailureKind);
        RedisOperationFailureDiagnostic provider = Assert.Single(OwnEvents(collector, unavailable));
        Assert.Equal("connection-provider-unavailable", provider.ExceptionCategory);
        Assert.Equal(RedisOperationDiagnosticStage.Connection, provider.Stage);
        var cancelled = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        using var cancellation = new CancellationTokenSource();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled.ExecuteAsync<int>(
            RedisOperationPort.PerceptionChallenge, (_, token) =>
            {
                cancellation.Cancel();
                throw new OperationCanceledException(token);
            }, cancellation.Token));
        RedisOperationFailureDiagnostic caller = Assert.Single(OwnEvents(collector, cancelled));
        Assert.Equal(RedisOperationDiagnosticDisposition.CallerCancellation, caller.Disposition);
        Assert.Null(caller.FailureKind);
    }

    [Fact]
    public async Task FailureDiagnosticsSubscriberFailureCannotReplaceResultOrOriginalException()
    {
        using IDisposable faulty = RedisOperationFailureDiagnostics.Subscribe(_ => throw new InvalidOperationException("private"));
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        var original = new RedisServerException("private");
        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync<int>(RedisOperationPort.PerceptionChallenge, (_, _) => throw original, CancellationToken.None));
        Assert.Same(original, failure.InnerException);
        Assert.Single(OwnEvents(collector, executor));
        int attempts = 0;
        Assert.Equal(7, await executor.ExecuteAsync(RedisOperationPort.UnifiedCacheRead, (_, _) =>
            ++attempts == 1
                ? Task.FromException<int>(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "private"))
                : Task.FromResult(7), CancellationToken.None));
        Assert.Equal(2, attempts);
    }

    [Fact]
    public async Task FailureDiagnosticsObservePostQueueCircuitRejectionWithoutExecutingQueuedCommand()
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        RedisOperationBudget budget = new RedisOperationBudgetCatalog().Get(RedisOperationClass.SecurityAtomic);
        var release = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        Task<int>[] holders = Enumerable.Range(0, budget.MaxConcurrency - 1).Select(_ => executor.ExecuteAsync(
            RedisOperationPort.PerceptionChallenge, (_, _) => release.Task, CancellationToken.None)).ToArray();
        Task<int>? queued = null;
        int queuedCommands = 0;
        try
        {
            for (int index = 0; index < budget.CircuitFailureThreshold; index++)
            {
                bool last = index == budget.CircuitFailureThreshold - 1;
                await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => executor.ExecuteAsync<int>(
                    RedisOperationPort.PerceptionChallenge, (_, _) =>
                    {
                        if (last)
                        {
                            queued = executor.ExecuteAsync(RedisOperationPort.PerceptionChallenge, (_, _) =>
                            {
                                queuedCommands++;
                                return Task.FromResult(1);
                            }, CancellationToken.None);
                        }

                        throw new RedisServerException("private");
                    }, CancellationToken.None));
            }

            Assert.NotNull(queued);
            RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => queued);
            Assert.Equal(RedisOperationFailureKind.CircuitOpen, failure.FailureKind);
            Assert.Null(failure.InnerException);
            Assert.Equal(0, queuedCommands);
            RedisOperationFailureDiagnostic rejection = Assert.Single(OwnEvents(collector, executor),
                item => item.Stage == RedisOperationDiagnosticStage.CircuitAfterQueue);
            Assert.Equal(RedisOperationDiagnosticDisposition.Rejected, rejection.Disposition);
            Assert.Equal("none", rejection.ExceptionCategory);
        }
        finally
        {
            release.TrySetResult(1);
            await Task.WhenAll(holders);
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task FailureDiagnosticsDistinguishQueueDeadlineAndCallerCancellation(bool callerCancellation)
    {
        using var collector = new RedisOperationFailureDiagnosticCollector();
        var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        // Mechanical admission saturation, not a claim about physical Redis load or burn concurrency.
        var slots = (SemaphoreSlim[])typeof(RedisOperationExecutor).GetField("_operationSlots",
            System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic)!.GetValue(executor)!;
        SemaphoreSlim security = slots[(int)RedisOperationClass.SecurityAtomic];
        int capacity = security.CurrentCount;
        for (int index = 0; index < capacity; index++)
        {
            Assert.True(security.Wait(0));
        }

        using var cancellation = new CancellationTokenSource();
        int commands = 0;
        try
        {
            Task<int> pending = executor.ExecuteAsync(RedisOperationPort.PerceptionChallenge, (_, _) =>
            {
                commands++;
                return Task.FromResult(1);
            }, cancellation.Token);
            if (callerCancellation)
            {
                cancellation.Cancel();
                await Assert.ThrowsAnyAsync<OperationCanceledException>(() => pending);
            }
            else
            {
                RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => pending);
                Assert.Equal(RedisOperationFailureKind.CommandTimeout, failure.FailureKind);
            }

            Assert.Equal(0, commands);
            RedisOperationFailureDiagnostic observation = Assert.Single(OwnEvents(collector, executor));
            Assert.Equal(RedisOperationDiagnosticStage.Queue, observation.Stage);
            Assert.Equal(0, observation.Attempt);
            Assert.Equal(callerCancellation ? RedisOperationDiagnosticDisposition.CallerCancellation
                : RedisOperationDiagnosticDisposition.Terminal, observation.Disposition);
        }
        finally
        {
            security.Release(capacity);
        }
    }

    [Fact]
    public void FailureDiagnosticsRejectForeignNonPrivateAndSymlinkRoots()
    {
        string parent = Path.Combine(Path.GetTempPath(), $"redis-diagnostic-unit-{Guid.NewGuid():N}");
        string root = Path.Combine(parent, "redis-diagnostics-mechanical.owned");
        Directory.CreateDirectory(root);
        try
        {
            if (OperatingSystem.IsWindows())
            {
                Assert.Throws<InvalidOperationException>(() => RedisOperationFailureDiagnosticCollector.ValidatePrivateRoot(root, "mechanical"));
                return;
            }

            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            RedisOperationFailureDiagnosticCollector.ValidatePrivateRoot(root, "mechanical");
            Assert.Throws<InvalidOperationException>(() => RedisOperationFailureDiagnosticCollector.ValidatePrivateRoot(root, "foreign"));
            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute | UnixFileMode.GroupRead);
            Assert.Throws<InvalidOperationException>(() => RedisOperationFailureDiagnosticCollector.ValidatePrivateRoot(root, "mechanical"));
            File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
            string link = Path.Combine(parent, "redis-diagnostics-mechanical.link");
            Directory.CreateSymbolicLink(link, root);
            Assert.Throws<InvalidOperationException>(() => RedisOperationFailureDiagnosticCollector.ValidatePrivateRoot(link, "mechanical"));
        }
        finally
        {
            Directory.Delete(parent, recursive: true);
        }
    }

    [Fact]
    public async Task FailureDiagnosticsCollectorOverflowIsExplicitAndBounded()
    {
        using var collector = new RedisOperationFailureDiagnosticCollector(capacity: 2);
        for (int index = 0; index < 5; index++)
        {
            var executor = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => executor.ExecuteAsync<int>(
                RedisOperationPort.PerceptionChallenge, (_, _) => throw new RedisServerException("private"), CancellationToken.None));
        }

        RedisOperationDiagnosticSnapshot snapshot = collector.Snapshot();
        Assert.Equal(2, snapshot.Capacity);
        Assert.Equal(2, snapshot.RetainedCount);
        Assert.Equal(3, snapshot.DroppedCount);
        Assert.Equal("overflow-incomplete", snapshot.Completeness);
        Assert.Equal(2, snapshot.Events.Length);
        collector.Dispose();
        collector.Dispose();
        var after = CreateExecutor(Substitute.For<IConnectionMultiplexer>());
        await Assert.ThrowsAsync<RedisOperationUnavailableException>(() => after.ExecuteAsync<int>(
            RedisOperationPort.PerceptionChallenge, (_, _) => throw new RedisServerException("private"), CancellationToken.None));
        Assert.Equal(snapshot, collector.Snapshot() with
        {
            Events = snapshot.Events
        });
        Assert.Throws<ArgumentOutOfRangeException>(() => new RedisOperationFailureDiagnosticCollector(0));
        Assert.Throws<ArgumentOutOfRangeException>(() => new RedisOperationFailureDiagnosticCollector(
            RedisOperationFailureDiagnosticCollector.MaximumEvents + 1));
    }

    private static RedisOperationFailureDiagnostic[] OwnEvents(
        RedisOperationFailureDiagnosticCollector collector, RedisOperationExecutor executor)
        => collector.Snapshot().Events.Where(item => item.ExecutorIdentity == executor.DiagnosticIdentity).ToArray();

    [Fact]
    public void FailureDiagnosticsFailedSerializationDoesNotPublishFinalMarker()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"redis-diagnostic-publication-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            System.Reflection.MethodInfo writer = typeof(RedisOperationFailureDiagnosticCollector).GetMethod(
                "WritePrivate", System.Reflection.BindingFlags.Static | System.Reflection.BindingFlags.NonPublic)!;
            var payload = new FailingPublicationPayload();
            System.Reflection.TargetInvocationException failure = Assert.Throws<System.Reflection.TargetInvocationException>(() =>
                writer.Invoke(null, [root, "testhost-model-final.json", payload]));
            Assert.IsType<IOException>(failure.InnerException);
            Assert.False(File.Exists(Path.Combine(root, "testhost-model-final.json")));
            string pending = Assert.Single(Directory.GetFiles(root, "*.pending-*"));
            Assert.True(new FileInfo(pending).Length > 0);
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(pending));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class FailingPublicationPayload
    {
        [System.Text.Json.Serialization.JsonPropertyOrder(0)]
        public bool FinalizedAtProcessExit => true;

        [System.Text.Json.Serialization.JsonPropertyOrder(1)]
        public string Padding => new('x', 256 * 1024);

        [System.Text.Json.Serialization.JsonPropertyOrder(2)]
        public string Failure => throw new IOException("injected_writer_failure");
    }

    [Fact]
    public void FailureDiagnosticsFailedFlushRetainsCompleteJsonOnlyAsPending()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"redis-diagnostic-flush-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            Assert.Throws<ObjectDisposedException>(() => RedisOperationFailureDiagnosticCollector.PublishPrivate(
                root, "testhost-model-final.json",
                stream => JsonSerializer.Serialize(stream, new { FinalizedAtProcessExit = true }),
                stream =>
                {
                    // Actual FileStream flush fails after all JSON bytes were written to this private inode.
                    stream.Dispose();
                    stream.Flush(flushToDisk: true);
                }));
            Assert.False(File.Exists(Path.Combine(root, "testhost-model-final.json")));
            string pending = Assert.Single(Directory.GetFiles(root, "*.pending-*"));
            using JsonDocument json = JsonDocument.Parse(File.ReadAllBytes(pending));
            Assert.True(json.RootElement.GetProperty("FinalizedAtProcessExit").GetBoolean());
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(pending));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    [Fact]
    public void FailureDiagnosticsPublicationNeverOverwritesAnExistingPrivateFinal()
    {
        if (OperatingSystem.IsWindows())
        {
            return;
        }

        string root = Path.Combine(Path.GetTempPath(), $"redis-diagnostic-final-{Guid.NewGuid():N}");
        Directory.CreateDirectory(root);
        File.SetUnixFileMode(root, UnixFileMode.UserRead | UnixFileMode.UserWrite | UnixFileMode.UserExecute);
        try
        {
            const string Name = "testhost-model-final.json";
            RedisOperationFailureDiagnosticCollector.PublishPrivate(root, Name,
                stream => JsonSerializer.Serialize(stream, new { Phase = "first" }),
                static stream => stream.Flush(flushToDisk: true));
            string final = Path.Combine(root, Name);
            byte[] original = File.ReadAllBytes(final);
            Assert.Empty(Directory.GetFiles(root, "*.pending-*"));
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(final));
            Assert.Throws<IOException>(() => RedisOperationFailureDiagnosticCollector.PublishPrivate(root, Name,
                stream => JsonSerializer.Serialize(stream, new { Phase = "second" }),
                static stream => stream.Flush(flushToDisk: true)));
            Assert.Equal(original, File.ReadAllBytes(final));
            string pending = Assert.Single(Directory.GetFiles(root, "*.pending-*"));
            using JsonDocument json = JsonDocument.Parse(File.ReadAllBytes(pending));
            Assert.Equal("second", json.RootElement.GetProperty("Phase").GetString());
            Assert.Equal(UnixFileMode.UserRead | UnixFileMode.UserWrite, File.GetUnixFileMode(pending));
        }
        finally
        {
            Directory.Delete(root, recursive: true);
        }
    }

    private sealed class PendingConnectionProvider : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync()
            => new TaskCompletionSource<IConnectionMultiplexer>(TaskCreationOptions.RunContinuationsAsynchronously).Task;
    }

    private sealed class CountingProviderFailure : InvalidOperationException
    {
        public int MessageReads
        {
            get;
            private set;
        }

        public override string Message
        {
            get
            {
                MessageReads++;
                return "redis_multiplexer_private";
            }
        }
    }

    private sealed class FailingConnectionProvider(Exception exception) : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync() => Task.FromException<IConnectionMultiplexer>(exception);
    }

    [Fact]
    public async Task IdempotentPortRetriesTransientFailureWithinClassBudget()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        int attempts = 0;

        int result = await executor.ExecuteAsync(
            RedisOperationPort.UnifiedCacheRead,
            (_, _) => ++attempts == 1
                ? Task.FromException<int>(new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline"))
                : Task.FromResult(42),
            CancellationToken.None);

        Assert.Equal(42, result);
        Assert.Equal(2, attempts);
    }

    [Theory]
    [InlineData("READONLY replica is read-only")]
    [InlineData("MOVED 1 127.0.0.1:6380")]
    public async Task IdempotentPortRetriesRedisTopologyTransition(string message)
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        int attempts = 0;

        int result = await executor.ExecuteAsync(
            RedisOperationPort.UnifiedCacheRead,
            (_, _) => ++attempts == 1
                ? Task.FromException<int>(new RedisServerException(message))
                : Task.FromResult(9),
            CancellationToken.None);

        Assert.Equal(9, result);
        Assert.Equal(2, attempts);
    }

    [Fact]
    public async Task AtomicPortNeverRetriesAnUncertainFailure()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        int attempts = 0;

        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.PerceptionChallenge,
                (_, _) =>
                {
                    attempts++;
                    return Task.FromException<int>(
                        new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline"));
                },
                CancellationToken.None));

        Assert.Equal(1, attempts);
        Assert.Equal(RedisOperationClass.SecurityAtomic, failure.Port.OperationClass);
        Assert.Equal("fail-closed", failure.Budget.FailAction);
    }

    [Fact]
    public async Task CommandDeadlineEndsOptionalProjectionWithoutWaitingForUnderlyingCommand()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        var never = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);

        RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.ArticleServiceOptionalProjection,
                (_, _) => never.Task,
                CancellationToken.None));

        Assert.Equal(RedisOperationFailureKind.CommandTimeout, failure.FailureKind);
        Assert.Equal("use-local-or-base-value", failure.Budget.FailAction);
    }

    [Theory]
    [InlineData(5, true)]
    [InlineData(50, true)]
    [InlineData(500, false)]
    [InlineData(15000, false)]
    public async Task FaultDelayMatrixHonorsOptionalProjectionDeadline(int delayMilliseconds, bool succeeds)
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);

        Task<int> ExecuteAsync() => executor.ExecuteAsync(
            RedisOperationPort.ArticleServiceOptionalProjection,
            async (_, token) =>
            {
                await Task.Delay(delayMilliseconds, token);
                return delayMilliseconds;
            },
            CancellationToken.None);

        if (succeeds)
        {
            Assert.Equal(delayMilliseconds, await ExecuteAsync());
        }
        else
        {
            RedisOperationUnavailableException failure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(ExecuteAsync);
            Assert.Equal(RedisOperationFailureKind.CommandTimeout, failure.FailureKind);
        }
    }

    [Fact]
    public async Task CallerCancellationIsPreservedInsteadOfBeingReclassified()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.UnifiedCacheRead,
                (_, _) => Task.FromResult(1),
                cancellation.Token));
    }

    [Fact]
    public async Task SecurityCircuitDoesNotSuppressOptionalProjectionClass()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        for (int i = 0; i < 3; i++)
        {
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
                executor.ExecuteAsync(
                    RedisOperationPort.PerceptionChallenge,
                    (_, _) => Task.FromException<int>(
                        new RedisConnectionException(ConnectionFailureType.UnableToConnect, "offline")),
                    CancellationToken.None));
        }

        int result = await executor.ExecuteAsync(
            RedisOperationPort.ArticleServiceOptionalProjection,
            (_, _) => Task.FromResult(7),
            CancellationToken.None);

        Assert.Equal(7, result);
        RedisOperationUnavailableException circuitFailure = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.PerceptionChallenge,
                (_, _) => Task.FromResult(8),
                CancellationToken.None));
        Assert.Equal(RedisOperationFailureKind.CircuitOpen, circuitFailure.FailureKind);
    }

    [Fact]
    public async Task ThousandConcurrentContentMissesAreBoundedByRedisCircuitAndDatabaseGate()
    {
        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var catalog = new RedisOperationBudgetCatalog();
        var executor = new RedisOperationExecutor(
            new FixedConnectionProvider(connection),
            catalog,
            TimeProvider.System);
        var databaseGate = new DbConcurrencyGate(
            new DbConcurrencyGateOptions(4, TimeSpan.FromSeconds(1)),
            NullLogger<DbConcurrencyGate>.Instance);
        int redisCommands = 0;
        int activeDatabaseCalls = 0;
        int maxActiveDatabaseCalls = 0;
        int databaseFallbacks = 0;
        int databaseRejections = 0;

        Task<int> ExecuteRequestAsync()
            => ExecuteRequestCoreAsync();

        async Task<int> ExecuteRequestCoreAsync()
        {
            try
            {
                return await executor.ExecuteAsync<int>(
                    RedisOperationPort.UnifiedCacheRead,
                    async (_, token) =>
                    {
                        Interlocked.Increment(ref redisCommands);
                        await Task.Delay(20, token);
                        throw new RedisConnectionException(ConnectionFailureType.UnableToConnect, "fault-injected disconnect");
                    },
                    CancellationToken.None);
            }
            catch (RedisOperationUnavailableException failure)
                when (failure.Port.OperationClass == RedisOperationClass.ContentCacheRead)
            {
                return await databaseGate.ExecuteClassifiedAsync(
                    DbWorkloadClass.PublicShortRead,
                    "fault-injected-content-cache-miss",
                    async token =>
                    {
                        int active = Interlocked.Increment(ref activeDatabaseCalls);
                        UpdateMaximum(ref maxActiveDatabaseCalls, active);
                        try
                        {
                            await Task.Delay(10, token);
                            Interlocked.Increment(ref databaseFallbacks);
                            return 1;
                        }
                        finally
                        {
                            Interlocked.Decrement(ref activeDatabaseCalls);
                        }
                    },
                    _ =>
                    {
                        Interlocked.Increment(ref databaseRejections);
                        return Task.FromResult(0);
                    },
                    CancellationToken.None);
            }
        }

        int[] results = await Task.WhenAll(Enumerable.Range(0, 1000).Select(_ => ExecuteRequestAsync()));

        RedisOperationBudget budget = catalog.Get(RedisOperationClass.ContentCacheRead);
        int maximumCommandsBeforeCircuit = checked(
            (budget.MaxConcurrency + budget.CircuitFailureThreshold - 1) * (budget.RetryCount + 1));
        Assert.InRange(redisCommands, 1, maximumCommandsBeforeCircuit);
        Assert.InRange(maxActiveDatabaseCalls, 1, 4);
        Assert.Equal(databaseFallbacks, results.Sum());
        Assert.True(databaseRejections > 0);
        DbWorkloadGateSnapshot snapshot = databaseGate.GetDiagnostics().Workloads["public-short-read"];
        Assert.True(snapshot.P99ExecutionMs > 0);
        Assert.True(snapshot.QueueRejected > 0);
    }

    [Fact]
    public async Task MetricsExposeTimingFailureCircuitFallbackAndClassTags()
    {
        var measurements = new ConcurrentBag<(string Name, Dictionary<string, object?> Tags)>();
        using var listener = new MeterListener();
        listener.InstrumentPublished = (instrument, meterListener) =>
        {
            if (instrument.Meter.Name == "FsusBlog.Server.RedisOperations")
            {
                meterListener.EnableMeasurementEvents(instrument);
            }
        };
        listener.SetMeasurementEventCallback<long>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static pair => pair.Key, static pair => pair.Value))));
        listener.SetMeasurementEventCallback<double>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static pair => pair.Key, static pair => pair.Value))));
        listener.SetMeasurementEventCallback<int>((instrument, _, tags, _) =>
            measurements.Add((instrument.Name, tags.ToArray().ToDictionary(static pair => pair.Key, static pair => pair.Value))));
        listener.Start();

        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var executor = CreateExecutor(connection);
        Assert.Equal(
            1,
            await executor.ExecuteAsync(
                RedisOperationPort.UnifiedCacheRead,
                (_, _) => Task.FromResult(1),
                CancellationToken.None));

        var never = new TaskCompletionSource<int>(TaskCreationOptions.RunContinuationsAsynchronously);
        _ = await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
            executor.ExecuteAsync(
                RedisOperationPort.ArticleServiceOptionalProjection,
                (_, _) => never.Task,
                CancellationToken.None));

        using var cancellation = new CancellationTokenSource();
        Task<int> cancelled = executor.ExecuteAsync(
            RedisOperationPort.SharedDistributedCacheRead,
            async (_, token) =>
            {
                await Task.Delay(Timeout.InfiniteTimeSpan, token);
                return 0;
            },
            cancellation.Token);
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => cancelled);

        string[] requiredInstruments =
        [
            "fsus.redis.command.count",
            "fsus.redis.queue_time",
            "fsus.redis.server_time",
            "fsus.redis.end_to_end_time",
            "fsus.redis.timeout.count",
            "fsus.redis.cancel.count",
            "fsus.redis.circuit.state",
            "fsus.redis.fallback.count"
        ];
        Assert.All(requiredInstruments, name => Assert.Contains(measurements, item => item.Name == name));
        Assert.All(measurements, item =>
        {
            Assert.True(item.Tags.ContainsKey("fsus.redis.port"));
            Assert.True(item.Tags.ContainsKey("fsus.redis.class"));
            Assert.True(item.Tags.ContainsKey("fsus.redis.fail_action"));
        });
        Assert.Contains(
            measurements,
            item => item.Tags.GetValueOrDefault("fsus.redis.class") as string == "content-cache-read");
        Assert.Contains(
            measurements,
            item => item.Tags.GetValueOrDefault("fsus.redis.class") as string == "optional-projection");
    }

    [Fact]
    public async Task FinalFailuresAreBoundToCurrentRequestInOccurrenceOrderAndSerializeForEndpoint()
    {
        var catalog = new RedisOperationBudgetCatalog();
        using RuntimeCacheEvidenceObservation observation = RuntimeCacheEvidenceObservation.Begin(
            "redis-failure-request",
            HttpMethods.Get,
            "/api/binary/system/seo");
        var unavailableExecutor = new RedisOperationExecutor(
            new UnavailableConnectionProvider(),
            catalog,
            TimeProvider.System);

        RedisOperationUnavailableException connectionFailure =
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
                unavailableExecutor.ExecuteAsync(
                    RedisOperationPort.UnifiedCacheRead,
                    (_, _) => Task.FromResult(1),
                    CancellationToken.None));

        IConnectionMultiplexer connection = Substitute.For<IConnectionMultiplexer>();
        var timeoutExecutor = CreateExecutor(connection);
        RedisOperationUnavailableException timeoutFailure =
            await Assert.ThrowsAsync<RedisOperationUnavailableException>(() =>
                timeoutExecutor.ExecuteAsync(
                    RedisOperationPort.PerceptionChallenge,
                    (_, _) => Task.FromException<int>(new TimeoutException("fault-injected timeout")),
                    CancellationToken.None));

        RuntimeCacheRequestObservation completed = observation.Complete(
            StatusCodes.Status503ServiceUnavailable,
            "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");

        Assert.Equal(RedisOperationFailureKind.ConnectionUnavailable, connectionFailure.FailureKind);
        Assert.Equal(RedisOperationFailureKind.CommandTimeout, timeoutFailure.FailureKind);
        Assert.Collection(
            completed.RedisFailureEvents,
            first =>
            {
                Assert.Equal(1, first.Sequence);
                Assert.True(first.ElapsedMilliseconds >= 0);
                Assert.Equal(RedisOperationClass.ContentCacheRead, first.OperationClass);
                Assert.Equal(RedisOperationFailureKind.ConnectionUnavailable, first.FailureKind);
                Assert.Equal("bounded-origin-gate", first.FailAction);
            },
            second =>
            {
                Assert.Equal(2, second.Sequence);
                Assert.True(second.ElapsedMilliseconds >= completed.RedisFailureEvents[0].ElapsedMilliseconds);
                Assert.Equal(RedisOperationClass.SecurityAtomic, second.OperationClass);
                Assert.Equal(RedisOperationFailureKind.CommandTimeout, second.FailureKind);
                Assert.Equal("fail-closed", second.FailAction);
            });

        using JsonDocument endpointJson = JsonDocument.Parse(JsonSerializer.Serialize(
            completed,
            new JsonSerializerOptions(JsonSerializerDefaults.Web)));
        JsonElement events = endpointJson.RootElement.GetProperty("redisFailureEvents");
        Assert.Equal(2, events.GetArrayLength());
        Assert.Equal("ContentCacheRead", events[0].GetProperty("operationClass").GetString());
        Assert.Equal("ConnectionUnavailable", events[0].GetProperty("failureKind").GetString());
        Assert.Equal("bounded-origin-gate", events[0].GetProperty("failAction").GetString());
        Assert.Equal(2, events[1].GetProperty("sequence").GetInt64());
    }

    private static RedisOperationExecutor CreateExecutor(IConnectionMultiplexer connection)
        => new(
            new FixedConnectionProvider(connection),
            new RedisOperationBudgetCatalog(),
            TimeProvider.System);

    private static void UpdateMaximum(ref int target, int candidate)
    {
        int current = Volatile.Read(ref target);
        while (candidate > current)
        {
            int observed = Interlocked.CompareExchange(ref target, candidate, current);
            if (observed == current)
            {
                return;
            }

            current = observed;
        }
    }

    private sealed class FixedConnectionProvider(IConnectionMultiplexer connection) : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync() => Task.FromResult(connection);
    }

    private sealed class UnavailableConnectionProvider : IRedisConnectionProvider
    {
        public Task<IConnectionMultiplexer> WaitAsync()
            => Task.FromException<IConnectionMultiplexer>(
                new InvalidOperationException("redis_multiplexer_unavailable"));
    }
}
