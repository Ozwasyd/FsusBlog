using System.Buffers;
using System.IO.Pipelines;
using System.Reflection;
using FsusBlog.Server.Infrastructure.NotificationStream;
using Microsoft.Extensions.Logging.Abstractions;

namespace FsusBlog.Server.Tests;

public sealed class NotificationStreamFramePumpTests
{
    [Fact]
    public void WriteDequeuedFrame_ReleasesFrameAndAcknowledgesQueue_WhenWriteThrows()
    {
        var connection = new NotificationStreamConnection("conn-1", "user-1", Array.Empty<string>(), queueCapacity: 8);
        SharedNotificationStreamFrame frame = CreateFrame("hello");

        Assert.True(connection.TryEnqueue(frame));
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));

        Assert.Throws<InvalidOperationException>(() => NotificationStreamFramePump.WriteDequeuedFrame(new ThrowingPipeWriter(), connection, dequeued));

        Assert.Equal(0, GetPrivateInt(connection, "_queuedFrames"));
        Assert.Equal(1, GetPrivateInt(frame, "_refCount"));

        frame.Release();
    }

    [Fact]
    public void WriteDequeuedFrame_ReturnsLengthBeforeRelease()
    {
        var connection = new NotificationStreamConnection("conn-2", "user-2", Array.Empty<string>(), queueCapacity: 8);
        SharedNotificationStreamFrame frame = CreateFrame("world");
        var pipe = new Pipe();

        Assert.True(connection.TryEnqueue(frame));
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));

        int length = NotificationStreamFramePump.WriteDequeuedFrame(pipe.Writer, connection, dequeued);

        Assert.Equal(5, length);
        Assert.Equal(0, GetPrivateInt(connection, "_queuedFrames"));
        Assert.Equal(1, GetPrivateInt(frame, "_refCount"));

        frame.Release();
    }

    private static SharedNotificationStreamFrame CreateFrame(string value)
    {
        byte[] buffer = ArrayPool<byte>.Shared.Rent(value.Length);
        System.Text.Encoding.UTF8.GetBytes(value.AsSpan(), buffer);
        return SharedNotificationStreamFrame.FromOwnedBuffer(buffer, value.Length);
    }

    private static int GetPrivateInt(object instance, string fieldName)
    {
        var field = instance.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic);
        return (int)(field?.GetValue(instance) ?? throw new InvalidOperationException($"field not found: {fieldName}"));
    }

    private sealed class ThrowingPipeWriter : PipeWriter
    {
        public override void Advance(int bytes) { }

        public override void CancelPendingFlush() { }

        public override void Complete(Exception? exception = null) { }

        public override ValueTask CompleteAsync(Exception? exception = null) => ValueTask.CompletedTask;

        public override ValueTask<FlushResult> FlushAsync(CancellationToken cancellationToken = default) => ValueTask.FromResult(default(FlushResult));

        public override Memory<byte> GetMemory(int sizeHint = 0) => throw new InvalidOperationException("simulated write failure");

        public override Span<byte> GetSpan(int sizeHint = 0) => throw new InvalidOperationException("simulated write failure");
    }
}
