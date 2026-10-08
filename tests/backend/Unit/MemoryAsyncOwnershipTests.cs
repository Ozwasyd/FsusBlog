using System.Threading.Tasks.Sources;

using FsusBlog.Core.Algorithms;

namespace FsusBlog.Server.Tests.Unit;

public sealed class MemoryAsyncOwnershipTests
{
    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task RetirementWaitsForActualTransportCompletionAndConsumesValueTaskOnce()
    {
        using OwnedAedsFrame frame = CreateFrame();
        var transport = new BarrierTransport();
        var recorder = new ReleaseRecorder(transport);
        Task operation = WriteWithLeaseAsync(frame, transport);
        await transport.Started.Task;
        Assert.True(frame.Retire(recorder.Record));
        Assert.False(operation.IsCompleted);
        Assert.Equal(0, recorder.Releases);
        Assert.Equal(1, frame.ActiveReadLeaseCount);
        transport.Complete();
        await operation;
        Assert.Equal(1, transport.ResultConsumptions);
        Assert.Equal(frame.LogicalLength, transport.Copied!.Length);
        Assert.Equal(1, recorder.Releases);
        Assert.False(recorder.ReleasedBeforeTerminal);
        Assert.Equal(frame.Capacity, recorder.Capacity);
        Assert.False(frame.Retire());
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public async Task OuterWaitCancellationDoesNotCompleteIndependentConsumerOwnership()
    {
        using OwnedAedsFrame frame = CreateFrame();
        var transport = new BarrierTransport();
        var recorder = new ReleaseRecorder(transport);
        Task operation = WriteWithLeaseAsync(frame, transport);
        await transport.Started.Task;
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() => operation.WaitAsync(cancellation.Token));
        Assert.True(frame.Retire(recorder.Record));
        Assert.False(transport.Terminal);
        Assert.False(operation.IsCompleted);
        Assert.Equal(0, recorder.Releases);
        Assert.Equal(1, frame.ActiveReadLeaseCount);
        transport.Complete();
        await operation;
        Assert.Equal(1, recorder.Releases);
        Assert.False(recorder.ReleasedBeforeTerminal);
        Assert.Equal(1, transport.ResultConsumptions);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Negative)]
    public async Task IndependentRecorderDetectsDeliberatelyEarlyReleaseBeforeBarrierOpens()
    {
        using OwnedAedsFrame frame = CreateFrame();
        var transport = new BarrierTransport();
        var recorder = new ReleaseRecorder(transport);
        OwnedAedsFrameReadLease lease = frame.AcquireReadLease();
        Task operation = transport.Start(lease.Memory).AsTask();
        lease.Dispose();
        frame.Retire(recorder.Record);
        Assert.True(recorder.ReleasedBeforeTerminal);
        Assert.False(transport.Terminal);
        Assert.Equal(1, recorder.Releases);
        transport.Complete();
        await Assert.ThrowsAsync<ObjectDisposedException>(() => operation);
        Assert.Equal(1, transport.ResultConsumptions);
    }

    [Fact]
    [CoversBehavior("binary-api-aeds-contract", BehaviorTestKind.Positive)]
    public void SelectionBeforeCloseCannotAcquireAReleasedOldFrame()
    {
        using OwnedAedsFrame oldFrame = CreateFrame();
        using OwnedAedsFrame current = CreateFrame();
        OwnedAedsFrame selectedBeforeClose = oldFrame;
        int releases = 0;
        oldFrame.Retire(_ => releases++);
        Assert.False(selectedBeforeClose.TryAcquireReadLease(out OwnedAedsFrameReadLease? oldLease));
        Assert.Null(oldLease);
        using OwnedAedsFrameReadLease retry = current.AcquireReadLease();
        Assert.Equal(current.LogicalLength, retry.Memory.Length);
        Assert.Equal(1, releases);
    }

    private static OwnedAedsFrame CreateFrame()
        => OwnedAedsFrame.TakeOwnership(new AedsEncoder().Encode(AedsFrameType.ArticleDetail, new byte[] { 1, 2, 3 }), AedsFrameType.ArticleDetail);

    private static async Task WriteWithLeaseAsync(OwnedAedsFrame frame, BarrierTransport transport)
    {
        using OwnedAedsFrameReadLease lease = frame.AcquireReadLease();
        await transport.Start(lease.Memory).ConfigureAwait(false);
    }

    private sealed class ReleaseRecorder(BarrierTransport transport)
    {
        public int Releases
        {
            get; private set;
        }
        public int Capacity
        {
            get; private set;
        }
        public bool ReleasedBeforeTerminal
        {
            get; private set;
        }
        public void Record(int capacity)
        {
            Releases++;
            Capacity = capacity;
            ReleasedBeforeTerminal |= !transport.Terminal;
        }
    }

    // FIXTURE: This is an actual incomplete IValueTaskSource operation. The independent
    // terminal flag is set only after its late source read, before signaling completion.
    private sealed class BarrierTransport : IValueTaskSource
    {
        private ManualResetValueTaskSourceCore<bool> _source = new() { RunContinuationsAsynchronously = true };
        private ReadOnlyMemory<byte> _input;
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Terminal
        {
            get; private set;
        }
        public int ResultConsumptions
        {
            get; private set;
        }
        public byte[]? Copied
        {
            get; private set;
        }

        public ValueTask Start(ReadOnlyMemory<byte> input)
        {
            _input = input;
            Started.SetResult();
            return new ValueTask(this, _source.Version);
        }

        public void Complete()
        {
            try
            {
                Copied = _input.ToArray();
                Terminal = true;
                _source.SetResult(true);
            }
            catch (ObjectDisposedException exception)
            {
                Terminal = true;
                _source.SetException(exception);
            }
        }

        public void GetResult(short token)
        {
            ResultConsumptions++;
            if (ResultConsumptions != 1)
            {
                throw new InvalidOperationException("Fixture ValueTask consumed more than once.");
            }
            _source.GetResult(token);
        }

        public ValueTaskSourceStatus GetStatus(short token) => _source.GetStatus(token);
        public void OnCompleted(Action<object?> continuation, object? state, short token, ValueTaskSourceOnCompletedFlags flags)
            => _source.OnCompleted(continuation, state, token, flags);
    }
}
