using System.IO.Pipelines;

namespace FsusBlog.Server.Infrastructure.Sse;

internal static class SseFramePump
{
    internal static int WriteDequeuedFrame(PipeWriter writer, SseConnection connection, SharedSseFrame frame)
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
