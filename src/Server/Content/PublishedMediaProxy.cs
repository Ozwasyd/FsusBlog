using System.Diagnostics;
using System.Net;

namespace FsusBlog.V2.Server.Content;

internal sealed class PublishedMediaProxy
{
    internal const int PrefixBytes = 1024 * 1024;
    internal const int TailBytesPerSecond = 8 * 1024 * 1024;
    private const int ChunkBytes = 64 * 1024;

    private readonly PublicMediaAddressRate rate = new(TimeProvider.System);

    internal bool Admit(HttpContext context)
    {
        if (rate.Admit(context.Connection.RemoteIpAddress ?? IPAddress.None)) return true;
        context.Response.StatusCode = StatusCodes.Status429TooManyRequests;
        // Retry-After uses whole seconds for the decisecond replenishment interval.
        context.Response.Headers.RetryAfter = "1";
        return false;
    }

    internal static async Task WriteImage(HttpContext context, ReadOnlyMemory<byte> bytes, string contentType,
        Func<bool> isCurrent)
    {
        if (HttpMethods.IsHead(context.Request.Method) || bytes.Length <= PrefixBytes)
        {
            await PublicResponse.Write(context, bytes, contentType);
            return;
        }

        var response = context.Response;
        var ct = context.RequestAborted;
        response.ContentType = contentType;
        response.ContentLength = bytes.Length;
        response.Headers["Incremental"] = "?1";
        await response.Body.WriteAsync(bytes[..PrefixBytes], ct);

        for (var offset = PrefixBytes; offset < bytes.Length;)
        {
            var count = Math.Min(ChunkBytes, bytes.Length - offset);
            // Start the next interval after each write. Downstream stalls cannot bank a later burst.
            var started = Stopwatch.GetTimestamp();
            var interval = TimeSpan.FromTicks(((long)count * TimeSpan.TicksPerSecond + TailBytesPerSecond - 1) / TailBytesPerSecond);
            var remaining = interval;
            while (remaining > TimeSpan.Zero)
            {
                await Task.Delay(TimeSpan.FromMilliseconds(Math.Ceiling(remaining.TotalMilliseconds)), ct);
                remaining = interval - Stopwatch.GetElapsedTime(started);
            }
            if (!isCurrent())
            {
                context.Abort();
                return;
            }
            await response.Body.WriteAsync(bytes.Slice(offset, count), ct);
            offset += count;
        }
    }
}
