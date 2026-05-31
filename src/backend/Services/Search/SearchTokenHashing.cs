namespace FsusBlog.Server.Services;

internal static class SearchTokenHashing
{
    public static ulong Fingerprint64(ReadOnlySpan<byte> bytes)
    {
        const ulong offset = 14695981039346656037UL;
        const ulong prime = 1099511628211UL;

        ulong hash = offset ^ (uint)bytes.Length;
        for (int i = 0; i < bytes.Length; i++)
        {
            hash ^= bytes[i];
            hash *= prime;
        }

        return hash;
    }
}
