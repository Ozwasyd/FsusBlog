namespace FsusBlog.V2.Server;

internal static class ClientMutationHeader
{
    internal const string Mismatch = "Command key does not match its request header.";

    internal static bool Matches(HttpContext context, Guid key, bool required = false) =>
        context.Request.Headers.TryGetValue(WireHeaders.ClientMutationId, out var header)
            ? header.Count == 1 && Guid.TryParseExact(header[0], "D", out var parsed) && parsed == key
            : !required;

    internal static void Require(HttpContext context, Guid key, bool required = false)
    {
        if (!Matches(context, key, required)) throw new BusinessException(Rejection.Invalid, Mismatch);
    }
}
