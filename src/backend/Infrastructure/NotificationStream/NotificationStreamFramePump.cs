using System.IO.Pipelines;

namespace FsusBlog.Server.Infrastructure.NotificationStream;

internal static class NotificationStreamFramePump
{
    internal static int WriteDequeuedFrame(PipeWriter writer, NotificationStreamConnection connection, SharedNotificationStreamFrame frame)
    {
        int frameLength = frame.Length;
        bool written = false;

        try
        {
            frame.Memory.Span.CopyTo(writer.GetSpan(frameLength));
            writer.Advance(frameLength);
            connection.MarkWriteActivity();
            written = true;
            return frameLength;
        }
        finally
        {
            try
            {
                connection.AcknowledgeDequeuedFrame(written);
            }
            finally
            {
                frame.Release();
            }
        }
    }
}
