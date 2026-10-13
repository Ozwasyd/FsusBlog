using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Devices;

using Xunit;

namespace FsusBlog.Server.Tests.Unit;

public sealed class GpuPeerTransferTests
{
    [Fact]
    public void OuterDisposalRetainsHoldsUntilCompletePayloadArrives()
    {
        var sourceSession = new GpuPeerTestSession();
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[] { 3, 1, 4, 1, 5, 9 });
        var destination = new GpuPeerTestHold(destinationSession, new byte[6]) { Access = GpuPeerAllocationAccess.ExclusiveWrite };
        var resources = new GpuPeerTestResource();
        GpuPeerTransfer operation = GpuPeerTransfer.Submit(sourceSession, destinationSession, source, destination, 6, resources);
        operation.Dispose();
        Assert.False(source.Disposed);
        Assert.False(destination.Disposed);
        Assert.False(resources.Disposed);
        source.CanSubmit = false;
        destination.CanSubmit = false;
        sourceSession.Completion = GpuCompletion.Complete;
        Assert.True(operation.Poll().Succeeded);
        Assert.Equal(source.Bytes, destination.Bytes);
        Assert.True(source.Disposed);
        Assert.True(destination.Disposed);
        Assert.True(resources.Disposed);
        Assert.Equal(1, sourceSession.ReleasedSubmissions);
        operation.Dispose();
        Assert.Equal(1, sourceSession.ReleasedSubmissions);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void UncertainSubmissionOrCompletionQuarantinesResources(bool submissionThrows)
    {
        var sourceSession = new GpuPeerTestSession { ThrowOnSubmit = submissionThrows, Completion = GpuCompletion.Uncertain };
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[4]);
        var destination = new GpuPeerTestHold(destinationSession, new byte[4]) { Access = GpuPeerAllocationAccess.ExclusiveWrite };
        var resources = new GpuPeerTestResource();
        GpuPeerTransfer operation = GpuPeerTransfer.Submit(sourceSession, destinationSession, source, destination, 4, resources);
        Assert.Equal(MemoryFailure.DeviceLost, operation.Poll().Failure);
        Assert.True(operation.IsQuarantined);
        operation.Dispose();
        Assert.False(source.Disposed);
        Assert.False(destination.Disposed);
        Assert.False(resources.Disposed);
        Assert.Equal(0, sourceSession.ReleasedSubmissions);
    }

    [Fact]
    public void CompletedOldEpochCannotPublishSuccess()
    {
        var sourceSession = new GpuPeerTestSession { Completion = GpuCompletion.Complete };
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[4]);
        var destination = new GpuPeerTestHold(destinationSession, new byte[4]) { Access = GpuPeerAllocationAccess.ExclusiveWrite };
        var resources = new GpuPeerTestResource();
        GpuPeerTransfer operation = GpuPeerTransfer.Submit(sourceSession, destinationSession, source, destination, 4, resources);
        destination.IsCurrent = false;
        Assert.Equal(MemoryFailure.StaleLocation, operation.Poll().Failure);
        Assert.True(resources.Disposed);
    }

    [Fact]
    public void AllocationFromDifferentSessionFailsBeforeNativeSubmission()
    {
        var sourceSession = new GpuPeerTestSession();
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(destinationSession, new byte[4]);
        var destination = new GpuPeerTestHold(destinationSession, new byte[4]) { Access = GpuPeerAllocationAccess.ExclusiveWrite };
        var resources = new GpuPeerTestResource();
        Assert.Throws<InvalidOperationException>(() => GpuPeerTransfer.Submit(sourceSession, destinationSession,
            source, destination, 4, resources));
        Assert.Equal(0, sourceSession.Submissions);
        Assert.True(source.Disposed);
        Assert.True(destination.Disposed);
        Assert.True(resources.Disposed);
    }

    [Fact]
    public void CompletionReleaseFailureRetainsAllocationAndCharges()
    {
        var sourceSession = new GpuPeerTestSession { Completion = GpuCompletion.Complete, ThrowOnRelease = true };
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[4]);
        var destination = new GpuPeerTestHold(destinationSession, new byte[4]) { Access = GpuPeerAllocationAccess.ExclusiveWrite };
        var resources = new GpuPeerTestResource();
        GpuPeerTransfer operation = GpuPeerTransfer.Submit(sourceSession, destinationSession, source, destination, 4, resources);
        Assert.Equal(MemoryFailure.DeviceLost, operation.Poll().Failure);
        Assert.True(operation.IsQuarantined);
        Assert.False(resources.Disposed);
        Assert.False(source.Disposed);
        Assert.False(destination.Disposed);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void WrongContentOrNonexclusiveDestinationRejectsBeforeSubmission(bool wrongContent)
    {
        var sourceSession = new GpuPeerTestSession();
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[4]);
        var destination = new GpuPeerTestHold(destinationSession, new byte[4])
        {
            Content = wrongContent ? source.Content with { Generation = new(2) } : source.Content,
            Access = wrongContent ? GpuPeerAllocationAccess.ExclusiveWrite : GpuPeerAllocationAccess.Read
        };
        var resources = new GpuPeerTestResource();
        Assert.Throws<InvalidOperationException>(() => GpuPeerTransfer.Submit(sourceSession, destinationSession,
            source, destination, 4, resources));
        Assert.Equal(0, sourceSession.Submissions);
        Assert.True(resources.Disposed);
    }

    [Fact]
    public void PartialPayloadCannotPublishWholeAllocation()
    {
        var sourceSession = new GpuPeerTestSession();
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[4]);
        var destination = new GpuPeerTestHold(destinationSession, new byte[4]) { Access = GpuPeerAllocationAccess.ExclusiveWrite };
        Assert.Throws<ArgumentOutOfRangeException>(() => GpuPeerTransfer.Submit(sourceSession, destinationSession,
            source, destination, 3, new GpuPeerTestResource()));
        Assert.Equal(0, sourceSession.Submissions);
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public void PreheldDisabledOwnerCannotStartNewPeerTransfer(bool disableSource)
    {
        var sourceSession = new GpuPeerTestSession();
        var destinationSession = new GpuPeerTestSession();
        var source = new GpuPeerTestHold(sourceSession, new byte[4]) { CanSubmit = !disableSource };
        var destination = new GpuPeerTestHold(destinationSession, new byte[4])
        {
            Access = GpuPeerAllocationAccess.ExclusiveWrite,
            CanSubmit = disableSource
        };
        var resources = new GpuPeerTestResource();
        Assert.True(source.IsCurrent);
        Assert.True(destination.IsCurrent);
        Assert.Throws<InvalidOperationException>(() => GpuPeerTransfer.Submit(sourceSession, destinationSession,
            source, destination, 4, resources));
        Assert.Equal(0, sourceSession.Submissions);
        Assert.True(source.Disposed);
        Assert.True(destination.Disposed);
        Assert.True(resources.Disposed);
    }
}

internal sealed class GpuPeerTestResource : IDisposable
{
    public bool Disposed
    {
        get; private set;
    }
    public void Dispose() => Disposed = true;
}

internal sealed class GpuPeerTestHold : IGpuPeerAllocationHold
{
    public bool CanSubmit { get; set; } = true;
    public GpuPeerTestHold(GpuPeerTestSession session, byte[] bytes)
    {
        Session = session;
        Bytes = bytes;
        Address = new((ulong)session.Buffers.Count + 1);
        session.Buffers[Address] = bytes;
    }
    public IGpuDriverSession Session
    {
        get;
    }
    public MemoryContentIdentity Content { get; set; } = new(new(Guid.Parse("11111111-1111-1111-1111-111111111111")), new(1), new(Guid.Parse("22222222-2222-2222-2222-222222222222")));
    public GpuPeerAllocationAccess Access { get; set; } = GpuPeerAllocationAccess.Read;
    public MemoryLocationToken Location { get; } = new(new(Guid.NewGuid()), new(Guid.NewGuid()), new(1), new(1));
    public GpuDeviceAddress Address
    {
        get;
    }
    public byte[] Bytes
    {
        get;
    }
    public long Length => Bytes.Length;
    public bool IsCurrent { get; set; } = true;
    public bool Disposed
    {
        get; private set;
    }
    public void Dispose() => Disposed = true;
}

internal sealed class GpuPeerTestSession : IGpuPeerDriverSession
{
    public GpuDeviceIdentity Identity { get; } = new("Test", "fixture", "fixture", 12000, false);
    public Dictionary<GpuDeviceAddress, byte[]> Buffers { get; } = new();
    public GpuCompletion Completion { get; set; } = GpuCompletion.Pending;
    public bool ThrowOnSubmit
    {
        get; set;
    }
    public bool ThrowOnRelease
    {
        get; set;
    }
    public int Submissions
    {
        get; private set;
    }
    public int ReleasedSubmissions
    {
        get; private set;
    }
    private Action? _complete;
    public MemoryDetection DetectPeerAccess(IGpuPeerDriverSession destination) => MemoryDetection.Present;
    public GpuSubmission SubmitPeerTransfer(GpuDeviceAddress source, IGpuPeerDriverSession destination,
        GpuDeviceAddress destinationAddress, long bytes)
    {
        Submissions++;
        _complete = () => Buffers[source].AsSpan(0, (int)bytes).CopyTo(((GpuPeerTestSession)destination).Buffers[destinationAddress]);
        if (ThrowOnSubmit)
        {
            throw new GpuDriverException("peer enqueue", 1);
        }
        return new(1, 2);
    }
    public GpuCompletion Query(GpuSubmission submission)
    {
        if (Completion == GpuCompletion.Complete)
        {
            _complete?.Invoke();
        }
        return Completion;
    }
    public void ReleaseSubmission(GpuSubmission submission)
    {
        if (ThrowOnRelease)
        {
            throw new GpuDriverException("release", 1);
        }
        ReleasedSubmissions++;
    }
    public void Dispose()
    {
    }
    public GpuDeviceAddress AllocateDevice(long bytes) => throw new NotSupportedException();
    public void FreeDevice(GpuDeviceAddress address) => throw new NotSupportedException();
    public GpuHostAddress AllocateHost(long bytes, bool cpuReadback) => throw new NotSupportedException();
    public void FreeHost(GpuHostAddress address) => throw new NotSupportedException();
    public void WriteHost(GpuHostAddress address, ReadOnlySpan<byte> source) => throw new NotSupportedException();
    public void ReadHost(GpuHostAddress address, Span<byte> destination) => throw new NotSupportedException();
    public GpuSubmission SubmitUpload(GpuHostAddress source, GpuDeviceAddress destination, long bytes) => throw new NotSupportedException();
    public GpuSubmission SubmitReadback(GpuDeviceAddress source, GpuHostAddress destination, long bytes) => throw new NotSupportedException();
}
