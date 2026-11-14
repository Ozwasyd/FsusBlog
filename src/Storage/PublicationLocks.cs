namespace FsusBlogV2.Storage;

internal static class PublicationLocks
{
    internal const long Ownership = 716729109726707501L;

    // PostgreSQL keeps two-int keys separate from the bigint keys used for per-command locks.
    internal const int HandoffClass = 1179866434;
    internal const int HandoffObject = 1;
}
