internal static class ProtocolRejection
{
    internal static void Assert(Action action, string acceptedMessage)
    {
        try { action(); }
        catch (ProtocolException) { return; }
        throw new InvalidOperationException(acceptedMessage);
    }
}
