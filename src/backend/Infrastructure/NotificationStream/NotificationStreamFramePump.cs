using System.IO.Pipelines;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal static class NotificationStreamFramePump
{
    internal static int WriteDequeuedFrame(PipeWriter writer, NotificationStreamConnection connection, SharedNotificationStreamFrame frame)
    {
        int frameLength = frame.Length;

        try
        {
            frame.Memory.Span.CopyTo(writer.GetSpan(frameLength));
            writer.Advance(frameLength);
            connection.MarkWriteActivity();
            return frameLength;
        }
        finally
        {
            connection.AcknowledgeDequeuedFrame();
            frame.Release();
        }
    }
}
