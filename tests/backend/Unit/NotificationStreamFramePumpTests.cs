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

        frame.Retain();
        Assert.True(connection.TryEnqueue(frame));
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));

        Assert.Throws<InvalidOperationException>(() => NotificationStreamFramePump.WriteDequeuedFrame(new ThrowingPipeWriter(), connection, dequeued));

        Assert.Equal(0, connection.DeliverySnapshot.LegacyPipeCopyCompleted);
        Assert.Equal(0, connection.DeliverySnapshot.SocketWriteCompleted);
        Assert.Equal(0, connection.DeliverySnapshot.FanoutExpanded);

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

        frame.Retain();
        Assert.True(connection.TryEnqueue(frame));
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));

        int length = NotificationStreamFramePump.WriteDequeuedFrame(pipe.Writer, connection, dequeued);

        Assert.Equal(1, connection.DeliverySnapshot.LegacyPipeCopyCompleted);
        Assert.Equal(0, connection.DeliverySnapshot.SocketWriteCompleted);
        Assert.Equal(0, connection.DeliverySnapshot.FanoutExpanded);

        Assert.Equal(5, length);
        Assert.Equal(0, GetPrivateInt(connection, "_queuedFrames"));
        Assert.Equal(1, GetPrivateInt(frame, "_refCount"));

        frame.Release();
    }

    [Fact]
    public async Task WriteDequeuedFrame_CopiesLargeFrameFromOwnedMemory()
    {
        const int FrameLength = 128 * 1024;
        var connection = new NotificationStreamConnection("conn-3", "user-3", Array.Empty<string>(), queueCapacity: 8);
        SharedNotificationStreamFrame frame = CreateFrame(FrameLength);
        var pipe = new Pipe(new PipeOptions(pauseWriterThreshold: FrameLength * 2, resumeWriterThreshold: FrameLength));

        frame.Retain();
        Assert.True(connection.TryEnqueue(frame));
        Assert.True(connection.Reader.TryRead(out SharedNotificationStreamFrame? dequeued));

        int written = NotificationStreamFramePump.WriteDequeuedFrame(pipe.Writer, connection, dequeued);
        Assert.Equal(1, connection.DeliverySnapshot.LegacyPipeCopyCompleted);
        Assert.Equal(0, connection.DeliverySnapshot.SocketWriteCompleted);
        Assert.Equal(0, connection.DeliverySnapshot.FanoutExpanded);
        await pipe.Writer.FlushAsync();
        ReadResult result = await pipe.Reader.ReadAsync();

        Assert.Equal(FrameLength, written);
        Assert.Equal(FrameLength, result.Buffer.Length);
        Assert.Equal(0, result.Buffer.FirstSpan[0]);
        Assert.Equal(255, result.Buffer.Slice(FrameLength - 1, 1).FirstSpan[0]);
        Assert.Equal(0, GetPrivateInt(connection, "_queuedFrames"));
        Assert.Equal(1, GetPrivateInt(frame, "_refCount"));

        pipe.Reader.AdvanceTo(result.Buffer.End);
        await pipe.Reader.CompleteAsync();
        await pipe.Writer.CompleteAsync();
        frame.Release();
    }

    private static SharedNotificationStreamFrame CreateFrame(string value)
    {
        byte[] buffer = ArrayPool<byte>.Shared.Rent(value.Length);
        System.Text.Encoding.UTF8.GetBytes(value.AsSpan(), buffer);
        return SharedNotificationStreamFrame.FromOwnedBuffer(buffer, value.Length);
    }

    private static SharedNotificationStreamFrame CreateFrame(int length)
    {
        byte[] buffer = ArrayPool<byte>.Shared.Rent(length);
        for (int i = 0; i < length; i++)
        {
            buffer[i] = (byte)(i & 0xff);
        }

        return SharedNotificationStreamFrame.FromOwnedBuffer(buffer, length);
    }

    private static int GetPrivateInt(object instance, string fieldName)
    {
        var field = instance.GetType().GetField(fieldName, BindingFlags.Instance | BindingFlags.NonPublic);
        return (int)(field?.GetValue(instance) ?? throw new InvalidOperationException($"field not found: {fieldName}"));
    }

    private sealed class ThrowingPipeWriter : PipeWriter
    {
        public override void Advance(int bytes)
        {
        }

        public override void CancelPendingFlush()
        {
        }

        public override void Complete(Exception? exception = null)
        {
        }

        public override ValueTask CompleteAsync(Exception? exception = null) => ValueTask.CompletedTask;

        public override ValueTask<FlushResult> FlushAsync(CancellationToken cancellationToken = default) => ValueTask.FromResult(default(FlushResult));

        public override Memory<byte> GetMemory(int sizeHint = 0) => throw new InvalidOperationException("simulated write failure");

        public override Span<byte> GetSpan(int sizeHint = 0) => throw new InvalidOperationException("simulated write failure");
    }
}
