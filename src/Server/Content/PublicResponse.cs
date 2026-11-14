namespace FsusBlog.V2.Server.Content;

// The response contains an already-rendered snapshot with no validators or range support.
internal static class PublicResponse
{
    internal static Task Write(HttpContext context, ReadOnlyMemory<byte> bytes, string contentType)
    {
        var response = context.Response;
        response.ContentType = contentType;
        response.ContentLength = bytes.Length;
        if (HttpMethods.IsHead(context.Request.Method)) return Task.CompletedTask;
        var write = response.Body.WriteAsync(bytes, context.RequestAborted);
        return write.IsCompletedSuccessfully ? Task.CompletedTask : Finish(context, write);
    }

    private static async Task Finish(HttpContext context, ValueTask write)
    {
        try { await write; }
        catch (OperationCanceledException) { context.Abort(); }
    }
}
