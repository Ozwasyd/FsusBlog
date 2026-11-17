internal sealed record AedsError(int Status, byte[] Packet) : IResult
{
    public async Task ExecuteAsync(HttpContext ctx)
    {
        ctx.Response.StatusCode = Status;
        ctx.Response.ContentType = "application/octet-stream";
        ctx.Response.ContentLength = Packet.Length;
        await ctx.Response.Body.WriteAsync(Packet, ctx.RequestAborted);
    }
}
