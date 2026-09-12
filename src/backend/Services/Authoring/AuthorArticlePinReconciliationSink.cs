using System.Security.Cryptography;

namespace FsusBlog.Server.Services.Authoring;

/// <summary>
/// Applies closed-article removal obligations through the sole pin write authority. The initial
/// collection revision is checked before any mutation and each removal advances the same CAS chain.
/// </summary>
public sealed class AuthorArticlePinReconciliationSink(IAuthorArticlePinStore pinStore)
    : IAuthorArticlePinReconciliationSink
{
    public async Task<bool> RecordClosedRemovalsAsync(
        IReadOnlyList<AuthorArticlePinClosedRemovalObligation> obligations,
        CancellationToken cancellationToken = default)
    {
        if (obligations.Count == 0)
        {
            return true;
        }

        AuthorArticlePinClosedRemovalObligation first = obligations[0];
        if (obligations.Any(obligation =>
                obligation.Owner != first.Owner
                || obligation.CollectionRevision != first.CollectionRevision
                || !string.Equals(
                    obligation.ContentDigest,
                    AuthorArticlePinProjectionContract.ComputeClosedRemovalDigest(
                        obligation.Owner,
                        obligation.CollectionRevision,
                        obligation.PinId,
                        obligation.ArticleId,
                        obligation.ReasonCode),
                    StringComparison.Ordinal)))
        {
            return false;
        }

        AuthorArticlePinCollectionSnapshot current = await pinStore.GetAuthoritySnapshotAsync(
            first.Owner,
            cancellationToken).ConfigureAwait(false);
        if (current.Revision != first.CollectionRevision)
        {
            HashSet<int> present = current.Pins.Select(static pin => pin.ArticleId).ToHashSet();
            return obligations.All(obligation => !present.Contains(obligation.ArticleId));
        }

        long revision = current.Revision;
        foreach (AuthorArticlePinClosedRemovalObligation obligation in obligations)
        {
            AuthorArticlePinWriteReceipt receipt = await pinStore.RemoveAsync(
                new RemoveAuthorArticlePinCommand(
                    first.Owner,
                    obligation.ArticleId,
                    revision,
                    CreateRequestId(obligation.ContentDigest)),
                cancellationToken).ConfigureAwait(false);
            revision = receipt.Revision;
        }
        return true;
    }

    private static Guid CreateRequestId(string digest)
    {
        byte[] hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(digest));
        Span<byte> bytes = hash.AsSpan(0, 16);
        bytes[6] = (byte)((bytes[6] & 0x0f) | 0x70);
        bytes[8] = (byte)((bytes[8] & 0x3f) | 0x80);
        return new Guid(bytes);
    }
}
