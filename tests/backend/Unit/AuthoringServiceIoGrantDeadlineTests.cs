using System.Collections.Immutable;
using System.Net;

using FsusBlog.Server.Infrastructure.AuthoringExtensions;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class AuthoringServiceIoGrantDeadlineTests
{
    [Theory]
    [InlineData(1)]
    [InlineData(2)]
    public async Task Fetch_RejectsExpiryDuringEitherNonCooperativeDnsAwait(int expireOnCall)
    {
        using var fixture = new IoFixture();
        AuthoringNetworkGrant grant = fixture.NetworkGrant(DateTimeOffset.UtcNow.AddMilliseconds(100));
        int calls = 0;
        fixture.ResolveAddress = async _ =>
        {
            if (++calls == expireOnCall)
            {
                await PassDeadlineAsync(grant.ExpiresAt);
            }
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Broker().FetchAsync(grant, grant.RuntimeIdentity, grant.Purpose, "/"));

        Assert.Equal(0, fixture.NetworkCalls);
    }

    [Fact]
    public async Task Fetch_RejectsLateNonCooperativeTransportResult()
    {
        using var fixture = new IoFixture();
        AuthoringNetworkGrant grant = fixture.NetworkGrant(DateTimeOffset.UtcNow.AddMilliseconds(100));
        fixture.GetResponse = _ => PassDeadlineAsync(grant.ExpiresAt);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Broker().FetchAsync(grant, grant.RuntimeIdentity, grant.Purpose, "/"));

        Assert.Equal(1, fixture.NetworkCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Fetch_RejectsCallerCancellationAtNonCooperativeAwait(bool duringTransport)
    {
        using var fixture = new IoFixture();
        using var cancellation = new CancellationTokenSource();
        AuthoringNetworkGrant grant = fixture.NetworkGrant(DateTimeOffset.UtcNow.AddMinutes(1));
        if (duringTransport)
        {
            fixture.GetResponse = _ =>
            {
                cancellation.Cancel();
                return Task.CompletedTask;
            };
        }
        else
        {
            fixture.ResolveAddress = _ =>
            {
                cancellation.Cancel();
                return Task.CompletedTask;
            };
        }

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await fixture.Broker().FetchAsync(grant, grant.RuntimeIdentity, grant.Purpose, "/", cancellation.Token));

        Assert.Equal(duringTransport ? 1 : 0, fixture.NetworkCalls);
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task File_RejectsExpiryAfterNonCooperativePathAwait(bool stage)
    {
        using var fixture = new IoFixture();
        AuthoringFileGrant grant = fixture.FileGrant(stage, DateTimeOffset.UtcNow.AddMilliseconds(100));
        fixture.ResolvePath = _ => PassDeadlineAsync(grant.ExpiresAt);

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            if (stage)
            {
                await fixture.Broker().StageProposedWriteAsync(grant, grant.RuntimeIdentity, grant.Purpose, [4, 5, 6]);
            }
            else
            {
                await fixture.Broker().ReadFileAsync(grant, grant.RuntimeIdentity, grant.Purpose);
            }
        });

        Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
        Assert.Equal(new byte[] { 1, 2, 3 }, File.ReadAllBytes(fixture.Input));
    }

    [Fact]
    public async Task ReadBounded_RejectsCancelledNonCooperativeEndOfStream()
    {
        using var cancellation = new CancellationTokenSource();
        using var stream = new CallbackReadStream(() => cancellation.Cancel());

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await PinnedHttpsAuthoringNetworkTransport.ReadBoundedAsync(stream, 10, cancellation.Token));
    }

    [Fact]
    public async Task Stage_CancellationAtPermissionsCleansAfterReleaseAndKeepsCleanupEvidence()
    {
        using var fixture = new IoFixture();
        using var cancellation = new CancellationTokenSource();
        string path = Path.Combine(fixture.Staging, "cancel-at-permissions");
        var cleanupFailure = new IOException("injected cleanup failure");
        OperationCanceledException failure = await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
                path,
                new byte[] { 4, 5, 6 },
                _ => cancellation.Cancel(),
                created =>
                {
                    using var released = new FileStream(created, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                    throw cleanupFailure;
                },
                cancellation.Token));

        Assert.Equal(cancellation.Token, failure.CancellationToken);
        Assert.True(File.Exists(path));
        ImmutableArray<Exception> secondary = Assert.IsType<ImmutableArray<Exception>>(
            failure.Data[AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey]);
        Assert.Same(cleanupFailure, Assert.Single(secondary));
    }

    [Theory]
    [InlineData(-1)]
    [InlineData(0)]
    [InlineData(1)]
    public void Deadline_RejectsExactExpiryEvenBeforeTimerCallback(long ticksAfterExpiry)
    {
        DateTimeOffset start = DateTimeOffset.UtcNow;
        var clock = new MutableTimeProvider(start);
        DateTimeOffset expiresAt = start.AddMinutes(1);
        using var deadline = new AuthoringExtensionServiceIoBroker.GrantIoDeadline(expiresAt, default, clock);
        clock.Now = expiresAt.AddTicks(ticksAfterExpiry);
        Assert.False(deadline.Token.IsCancellationRequested);

        if (ticksAfterExpiry < 0)
        {
            deadline.ThrowIfExpiredOrCancelled();
        }
        else
        {
            Assert.Throws<OperationCanceledException>(deadline.ThrowIfExpiredOrCancelled);
        }
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    [InlineData(2)]
    [InlineData(3)]
    public async Task DeadlineToken_CancelsButOperationWaitsForNonCooperativeOwnerToSettle(int operation)
    {
        using var fixture = new IoFixture();
        var entered = new TaskCompletionSource<CancellationToken>(TaskCreationOptions.RunContinuationsAsynchronously);
        var released = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var cancelled = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        async Task Block(CancellationToken token)
        {
            entered.TrySetResult(token);
            using CancellationTokenRegistration registration = token.Register(() => cancelled.TrySetResult());
            await released.Task;
        }
        if (operation == 0)
        {
            fixture.ResolveAddress = Block;
        }
        else if (operation == 1)
        {
            fixture.GetResponse = Block;
        }
        else
        {
            fixture.ResolvePath = Block;
        }
        DateTimeOffset expiresAt = DateTimeOffset.UtcNow.AddMilliseconds(200);
        AuthoringNetworkGrant networkGrant = fixture.NetworkGrant(expiresAt);
        AuthoringFileGrant fileGrant = fixture.FileGrant(operation == 3, expiresAt);
        Task run = operation switch
        {
            0 or 1 => fixture.Broker().FetchAsync(networkGrant, networkGrant.RuntimeIdentity, networkGrant.Purpose, "/").AsTask(),
            2 => fixture.Broker().ReadFileAsync(fileGrant, fileGrant.RuntimeIdentity, fileGrant.Purpose).AsTask(),
            _ => fixture.Broker().StageProposedWriteAsync(fileGrant, fileGrant.RuntimeIdentity, fileGrant.Purpose, [4, 5, 6]).AsTask()
        };
        try
        {
            CancellationToken bounded = await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            await cancelled.Task.WaitAsync(TimeSpan.FromSeconds(5));
            Assert.True(bounded.IsCancellationRequested);
            Assert.False(run.IsCompleted);
            Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
        }
        finally
        {
            released.TrySetResult();
        }
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task File_RejectsCallerCancellationAfterNonCooperativePathAwait(bool stage)
    {
        using var fixture = new IoFixture();
        using var cancellation = new CancellationTokenSource();
        AuthoringFileGrant grant = fixture.FileGrant(stage, DateTimeOffset.UtcNow.AddMinutes(1));
        fixture.ResolvePath = _ =>
        {
            cancellation.Cancel();
            return Task.CompletedTask;
        };

        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
        {
            if (stage)
            {
                await fixture.Broker().StageProposedWriteAsync(grant, grant.RuntimeIdentity, grant.Purpose, [4, 5, 6], cancellation.Token);
            }
            else
            {
                await fixture.Broker().ReadFileAsync(grant, grant.RuntimeIdentity, grant.Purpose, cancellation.Token);
            }
        });
        Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stage_ExpiryAfterWriteOrPermissionsReleasesAndCleansOwnedArtifact(bool atPermissions)
    {
        using var fixture = new IoFixture();
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset expiresAt = clock.Now.AddMinutes(1);
        using var deadline = new AuthoringExtensionServiceIoBroker.GrantIoDeadline(expiresAt, default, clock);
        string path = Path.Combine(fixture.Staging, "expired-stage");
        int checks = 0;
        int permissions = 0;
        int deletes = 0;
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
                path,
                new byte[] { 4, 5, 6 },
                _ =>
                {
                    permissions++;
                    clock.Now = expiresAt;
                },
                created =>
                {
                    deletes++;
                    using (var released = new FileStream(created, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                    {
                        Assert.Equal(3, released.Length);
                    }
                    File.Delete(created);
                },
                deadline.Token,
                () =>
                {
                    checks++;
                    if (!atPermissions)
                    {
                        clock.Now = expiresAt;
                    }
                    deadline.ThrowIfExpiredOrCancelled();
                }));
        Assert.True(checks > 0);
        Assert.Equal(atPermissions ? 1 : 0, permissions);
        Assert.Equal(1, deletes);
        Assert.False(File.Exists(path));
        Assert.False(File.Exists(Path.Combine(fixture.Owned, "output.bin")));
    }

    [Fact]
    public async Task Stage_PrimaryFailurePreservesExistingCleanupEvidenceWhenDeleteAlsoFails()
    {
        using var fixture = new IoFixture();
        string path = Path.Combine(fixture.Staging, "primary-failure");
        var first = new IOException("primary permissions failure");
        var earlierCleanup = new IOException("earlier cleanup failure");
        var latestCleanup = new IOException("latest cleanup failure");
        first.Data[AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey] = ImmutableArray.Create<Exception>(earlierCleanup);
        Exception observed = await Assert.ThrowsAsync<IOException>(async () =>
            await AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
                path, new byte[] { 4, 5, 6 }, _ => throw first, _ => throw latestCleanup, default));

        Assert.Same(first, observed);
        Assert.Equal(new Exception[] { earlierCleanup, latestCleanup },
            Assert.IsType<ImmutableArray<Exception>>(observed.Data[AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey]));
        Assert.True(File.Exists(path));
    }

    [Theory]
    [InlineData(0)]
    [InlineData(1)]
    public async Task ReadBounded_ExpiryAtNonCooperativeChunkAndEofNeverReturnsPayload(int returnedBytes)
    {
        var clock = new MutableTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset expiresAt = clock.Now.AddMinutes(1);
        using var deadline = new AuthoringExtensionServiceIoBroker.GrantIoDeadline(expiresAt, default, clock);
        using var stream = new CallbackReadStream(() => clock.Now = expiresAt, returnedBytes);
        await Assert.ThrowsAnyAsync<OperationCanceledException>(async () =>
            await PinnedHttpsAuthoringNetworkTransport.ReadBoundedAsync(stream, 10, deadline.Token, deadline.ThrowIfExpiredOrCancelled));
    }

    [Fact]
    public async Task LiveGrant_ReturnsMatchingPayloadAndOpaqueReceiptWithoutWritingTarget()
    {
        using var fixture = new IoFixture();
        DateTimeOffset expiresAt = DateTimeOffset.UtcNow.AddMinutes(1);
        AuthoringNetworkGrant network = fixture.NetworkGrant(expiresAt);
        AuthoringFileGrant read = fixture.FileGrant(false, expiresAt);
        AuthoringFileGrant stage = fixture.FileGrant(true, expiresAt);
        var broker = fixture.Broker();
        Assert.Equal(new byte[] { 7, 8, 9 },
            (await broker.FetchAsync(network, network.RuntimeIdentity, network.Purpose, "/")).Payload.ToArray());
        Assert.Equal(new byte[] { 1, 2, 3 },
            (await broker.ReadFileAsync(read, read.RuntimeIdentity, read.Purpose)).Payload.ToArray());
        AuthoringServiceIoReceipt receipt = await broker.StageProposedWriteAsync(stage, stage.RuntimeIdentity, stage.Purpose, [4, 5, 6]);
        Assert.Equal(stage.GrantId, receipt.GrantId);
        Assert.Equal(stage.RuntimeIdentity, receipt.RuntimeIdentity);
        Assert.Equal(stage.Purpose, receipt.Purpose);
        Assert.Equal("write-staged-for-host-approval", receipt.Outcome);
        Assert.Matches("^[0-9a-f]{64}$", receipt.ArtifactReference!);
        Assert.Equal(new byte[] { 4, 5, 6 }, File.ReadAllBytes(Path.Combine(fixture.Staging, receipt.ArtifactReference!)));
        Assert.False(File.Exists(Path.Combine(fixture.Owned, stage.RelativePath)));
        await broker.RevokeStagedWriteAsync(receipt);
        Assert.Empty(Directory.EnumerateFiles(fixture.Staging));
    }

    [Theory]
    [InlineData(false, false, false)]
    [InlineData(false, false, true)]
    [InlineData(false, true, false)]
    [InlineData(false, true, true)]
    [InlineData(true, false, false)]
    [InlineData(true, false, true)]
    [InlineData(true, true, false)]
    [InlineData(true, true, true)]
    public async Task Stage_WriteAndDisposeMustSettleBeforeCancelledOrExpiredArtifactCleanup(
        bool duringDispose, bool expire, bool failCleanup)
    {
        using var fixture = new IoFixture();
        using var cancellation = new CancellationTokenSource();
        var clock = new ManualTimerTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset expiresAt = clock.Now.AddMinutes(1);
        using var deadline = new AuthoringExtensionServiceIoBroker.GrantIoDeadline(expiresAt, cancellation.Token, clock);
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        string path = Path.Combine(fixture.Staging, "blocked-owned-stage");
        var cleanupFailure = new IOException("cleanup denied after settle");
        OwnedStageStream? owned = null;
        int deletions = 0;
        int permissions = 0;
        Task run = AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
            path, new byte[] { 4, 5, 6 }, _ => permissions++,
            created =>
            {
                deletions++;
                Assert.True(owned!.Released);
                using (var released = new FileStream(created, FileMode.Open, FileAccess.ReadWrite, FileShare.None))
                {
                    Assert.Equal(3, released.Length);
                }
                if (failCleanup)
                {
                    throw cleanupFailure;
                }
                File.Delete(created);
            }, deadline.Token, deadline.ThrowIfExpiredOrCancelled,
            created => owned = new OwnedStageStream(
                new FileStream(created, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.Asynchronous),
                duringDispose, entered, release)).AsTask();
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (expire)
            {
                clock.Now = expiresAt;
                clock.Timer!.Fire();
            }
            else
            {
                cancellation.Cancel();
            }
            Assert.True(deadline.Token.IsCancellationRequested);
            Assert.Equal(deadline.Token, owned!.WriteToken);
            Assert.False(run.IsCompleted);
            Assert.False(owned!.Released);
            Assert.Equal(0, deletions);
            Assert.Equal(0, permissions);
            Assert.Throws<IOException>(() => new FileStream(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None));
        }
        finally
        {
            release.TrySetResult();
        }
        OperationCanceledException observed = await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
        Assert.True(owned!.Released);
        Assert.Equal(1, deletions);
        Assert.Equal(failCleanup, File.Exists(path));
        if (failCleanup)
        {
            Assert.Same(cleanupFailure, Assert.Single(Assert.IsType<ImmutableArray<Exception>>(
                observed.Data[AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey])));
        }
        else
        {
            Assert.False(observed.Data.Contains(AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey));
        }
    }

    [Theory]
    [InlineData(false)]
    [InlineData(true)]
    public async Task Stage_DisposeFailurePreservesPrimaryCauseAndOrderedCleanupEvidence(bool cancelWrite)
    {
        using var fixture = new IoFixture();
        using var cancellation = new CancellationTokenSource();
        var entered = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var release = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var disposeFailure = new IOException("dispose failed after release");
        var deleteFailure = new IOException("delete failed after release");
        string path = Path.Combine(fixture.Staging, "dispose-failure");
        OwnedStageStream? owned = null;
        Task run = AuthoringExtensionServiceIoBroker.WriteOwnedProposalAsync(
            path, new byte[] { 4, 5, 6 }, _ => throw new InvalidOperationException("permissions must not run"),
            created =>
            {
                Assert.True(owned!.Released);
                using var released = new FileStream(created, FileMode.Open, FileAccess.ReadWrite, FileShare.None);
                throw deleteFailure;
            }, cancellation.Token, createProposal: created => owned = new OwnedStageStream(
                new FileStream(created, FileMode.CreateNew, FileAccess.Write, FileShare.None, 4096, FileOptions.Asynchronous),
                !cancelWrite, entered, release, disposeFailure)).AsTask();
        try
        {
            await entered.Task.WaitAsync(TimeSpan.FromSeconds(5));
            if (cancelWrite)
            {
                cancellation.Cancel();
            }
            Assert.False(run.IsCompleted);
        }
        finally
        {
            release.TrySetResult();
        }
        Exception observed = cancelWrite
            ? await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run)
            : await Assert.ThrowsAsync<IOException>(() => run);
        Assert.True(owned!.Released);
        ImmutableArray<Exception> secondary = Assert.IsType<ImmutableArray<Exception>>(
            observed.Data[AuthoringExtensionServiceIoBroker.StagedWriteCleanupFailuresKey]);
        if (cancelWrite)
        {
            Assert.Equal(cancellation.Token, Assert.IsAssignableFrom<OperationCanceledException>(observed).CancellationToken);
            Assert.Equal(new Exception[] { disposeFailure, deleteFailure }, secondary);
        }
        else
        {
            Assert.Same(disposeFailure, observed);
            Assert.Same(deleteFailure, Assert.Single(secondary));
        }
        Assert.True(File.Exists(path));
    }

    [Fact]
    public void Deadline_LongGrantRearmsTimerWithoutShorteningExpiryAndDisposesIt()
    {
        DateTimeOffset start = DateTimeOffset.UtcNow;
        var clock = new ManualTimerTimeProvider(start);
        DateTimeOffset expiresAt = start.AddDays(60);
        var deadline = new AuthoringExtensionServiceIoBroker.GrantIoDeadline(expiresAt, default, clock);
        CancellationToken token = deadline.Token;
        Assert.Equal(TimeSpan.FromMilliseconds(uint.MaxValue - 1), clock.Timer!.DueTime);
        clock.Now = start.AddDays(49);
        clock.Timer.Fire();
        Assert.False(token.IsCancellationRequested);
        Assert.Equal(expiresAt - clock.Now, clock.Timer.DueTime);
        clock.Now = expiresAt;
        clock.Timer.Fire();
        Assert.True(token.IsCancellationRequested);
        Assert.Throws<OperationCanceledException>(deadline.ThrowIfExpiredOrCancelled);
        deadline.Dispose();
        deadline.Dispose();
        Assert.True(clock.Timer.Disposed);
        clock.Timer.Fire();
    }

    [Fact]
    public async Task Deadline_CancellationCallbackCanDisposeItsOwner()
    {
        var clock = new ManualTimerTimeProvider(DateTimeOffset.UtcNow);
        DateTimeOffset expiresAt = clock.Now.AddMinutes(1);
        using var deadline = new AuthoringExtensionServiceIoBroker.GrantIoDeadline(expiresAt, default, clock);
        CancellationToken token = deadline.Token;
        using CancellationTokenRegistration registration = token.Register(deadline.Dispose);
        clock.Now = expiresAt;
        await Task.Run(clock.Timer!.Fire).WaitAsync(TimeSpan.FromSeconds(5));
        Assert.True(token.IsCancellationRequested);
        Assert.True(clock.Timer.Disposed);
        clock.Timer.Fire();
    }

    [Fact]
    public async Task LiveFarFutureFileGrantsRemainUsable()
    {
        using var fixture = new IoFixture();
        var broker = fixture.Broker();
        AuthoringFileGrant read = fixture.FileGrant(false, DateTimeOffset.MaxValue);
        AuthoringFileGrant stage = fixture.FileGrant(true, DateTimeOffset.MaxValue);
        Assert.Equal(new byte[] { 1, 2, 3 },
            (await broker.ReadFileAsync(read, read.RuntimeIdentity, read.Purpose)).Payload.ToArray());
        AuthoringServiceIoReceipt receipt = await broker.StageProposedWriteAsync(stage, stage.RuntimeIdentity, stage.Purpose, [4, 5, 6]);
        await broker.RevokeStagedWriteAsync(receipt);
    }

    private sealed class OwnedStageStream(
        FileStream inner,
        bool blockDispose,
        TaskCompletionSource entered,
        TaskCompletionSource release,
        Exception? disposeFailure = null) : Stream
    {
        public CancellationToken WriteToken
        {
            get; private set;
        }
        public bool Released
        {
            get; private set;
        }
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => inner.Length;
        public override long Position
        {
            get => inner.Position; set => throw new NotSupportedException();
        }
        public override void Flush() => inner.Flush();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();
        public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override async ValueTask WriteAsync(ReadOnlyMemory<byte> buffer, CancellationToken cancellationToken = default)
        {
            WriteToken = cancellationToken;
            await inner.WriteAsync(buffer);
            if (!blockDispose)
            {
                entered.TrySetResult();
                await release.Task;
            }
        }
        public override async ValueTask DisposeAsync()
        {
            if (blockDispose)
            {
                entered.TrySetResult();
                await release.Task;
            }
            await inner.DisposeAsync();
            Released = true;
            GC.SuppressFinalize(this);
            if (disposeFailure is not null)
            {
                throw disposeFailure;
            }
        }
    }

    private sealed class ManualTimerTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public ManualTimer? Timer
        {
            get; private set;
        }
        public override DateTimeOffset GetUtcNow() => Now;
        public override ITimer CreateTimer(TimerCallback callback, object? state, TimeSpan dueTime, TimeSpan period) =>
            Timer = new ManualTimer(callback, state, dueTime);
    }

    private sealed class ManualTimer(TimerCallback callback, object? state, TimeSpan dueTime) : ITimer
    {
        public TimeSpan DueTime { get; private set; } = dueTime;
        public bool Disposed
        {
            get; private set;
        }
        public bool Change(TimeSpan dueTime, TimeSpan period)
        {
            DueTime = dueTime;
            return !Disposed;
        }
        public void Fire() => callback(state);
        public void Dispose() => Disposed = true;
        public ValueTask DisposeAsync()
        {
            Dispose();
            return ValueTask.CompletedTask;
        }
    }

    private sealed class MutableTimeProvider(DateTimeOffset now) : TimeProvider
    {
        public DateTimeOffset Now { get; set; } = now;
        public override DateTimeOffset GetUtcNow() => Now;
    }

    private static async Task PassDeadlineAsync(DateTimeOffset deadline)
    {
        TimeSpan remaining = deadline - DateTimeOffset.UtcNow;
        if (remaining > TimeSpan.Zero)
        {
            await Task.Delay(remaining + TimeSpan.FromMilliseconds(10));
        }
        Assert.True(DateTimeOffset.UtcNow >= deadline);
    }

    private sealed class CallbackReadStream(Action read, int returnedBytes = 0) : MemoryStream
    {
        public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
        {
            read();
            return ValueTask.FromResult(returnedBytes);
        }
    }

    private sealed class IoFixture : IDisposable, IAuthoringNetworkAddressResolver,
        IAuthoringFilePathVerifier, IAuthoringPinnedNetworkTransport
    {
        private readonly string _root = Path.Combine(Path.GetTempPath(), "fsusblog-io-deadline-" + Guid.NewGuid().ToString("N"));
        public string Owned => Path.Combine(_root, "owned");
        public string Staging => Path.Combine(_root, "staging");
        public string Input => Path.Combine(Owned, "input.bin");
        public Func<CancellationToken, Task> ResolveAddress { get; set; } = _ => Task.CompletedTask;
        public Func<CancellationToken, Task> ResolvePath { get; set; } = _ => Task.CompletedTask;
        public Func<CancellationToken, Task> GetResponse { get; set; } = _ => Task.CompletedTask;
        public int NetworkCalls
        {
            get; private set;
        }

        public IoFixture()
        {
            Directory.CreateDirectory(Owned);
            Directory.CreateDirectory(Staging);
            File.WriteAllBytes(Input, [1, 2, 3]);
        }

        public AuthoringExtensionServiceIoBroker Broker() => new(
            new AuthoringServiceGrantValidator(this, this, TimeProvider.System,
                ImmutableHashSet.Create(StringComparer.Ordinal, Owned)), this, Staging);

        public AuthoringNetworkGrant NetworkGrant(DateTimeOffset expiresAt) => new(
            new string('a', 64), new string('b', 64), "example.com", 443, "import", true, 1024, expiresAt);

        public AuthoringFileGrant FileGrant(bool stage, DateTimeOffset expiresAt) => new(
            new string('c', 64), new string('b', 64), Owned, stage ? "output.bin" : "input.bin",
            stage ? AuthoringFileGrantOperation.ProposeWrite : AuthoringFileGrantOperation.Read,
            stage ? "export" : "import", 1024, expiresAt);

        public async ValueTask<ImmutableArray<IPAddress>> ResolveAsync(string host, CancellationToken cancellationToken)
        {
            await ResolveAddress(cancellationToken);
            return [IPAddress.Parse("93.184.216.34")];
        }

        public async ValueTask<(string CanonicalPath, bool HasReparseBoundary)> ResolveAsync(
            string canonicalRoot, string relativePath, CancellationToken cancellationToken)
        {
            await ResolvePath(cancellationToken);
            return (Path.Combine(canonicalRoot, relativePath), false);
        }

        public async ValueTask<AuthoringPinnedNetworkResponse> GetAsync(
            AuthoringPinnedNetworkRequest request, CancellationToken cancellationToken)
        {
            NetworkCalls++;
            await GetResponse(cancellationToken);
            return new(200, "application/octet-stream", [7, 8, 9]);
        }

        public void Dispose() => Directory.Delete(_root, true);
    }
}
