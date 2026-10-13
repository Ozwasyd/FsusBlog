namespace FsusBlog.Shared.Contracts.ArticleVault;

/// <summary>Describes the closed state of a local writer's control receipt.</summary>
public enum ArticleVaultWriterLeaseState
{
    Released,
    Active,
    Revoked,
    Expired
}

/// <summary>Defines transitions; acquisition still requires an exclusive native process lock.</summary>
public enum ArticleVaultWriterLeaseAction
{
    Acquire,
    Renew,
    Release,
    Revoke,
    Expire
}

/// <summary>Records identity, generation and a hash chain without tokens or article source.</summary>
public sealed record ArticleVaultWriterLeaseReceipt(
    string Schema,
    ArticleVaultAgentBinding Binding,
    long Generation,
    ArticleVaultWriterLeaseState State,
    long ObservedUnixMilliseconds,
    long DeadlineUnixMilliseconds,
    string? PreviousReceiptSha256,
    string ContentSha256);

/// <summary>
/// Verifies a lease control state. Serialized receipts never establish kernel lock ownership,
/// authorize an executor, or permit a second process to steal an expired live process's lock.
/// </summary>
public static class ArticleVaultWriterLease
{
    public const long MaximumLeaseMilliseconds = 60000;

    public static bool VerifyTransition(ArticleVaultWriterLeaseReceipt? previous, ArticleVaultWriterLeaseReceipt next)
    {
        if (!Verify(next) || (previous is not null && !Verify(previous)))
        {
            return false;
        }

        ArticleVaultWriterLeaseAction action = next.State switch
        {
            ArticleVaultWriterLeaseState.Active => previous?.State == ArticleVaultWriterLeaseState.Active
                ? ArticleVaultWriterLeaseAction.Renew : ArticleVaultWriterLeaseAction.Acquire,
            ArticleVaultWriterLeaseState.Released => ArticleVaultWriterLeaseAction.Release,
            ArticleVaultWriterLeaseState.Revoked => ArticleVaultWriterLeaseAction.Revoke,
            ArticleVaultWriterLeaseState.Expired => ArticleVaultWriterLeaseAction.Expire,
            _ => throw new InvalidDataException("writer_lease_state_invalid")
        };
        try
        {
            ArticleVaultWriterLeaseReceipt expected = Transition(previous, next.Binding, action,
                previous?.ContentSha256, next.ObservedUnixMilliseconds,
                next.State == ArticleVaultWriterLeaseState.Active
                    ? next.DeadlineUnixMilliseconds - next.ObservedUnixMilliseconds : MaximumLeaseMilliseconds);
            return expected == next;
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    public static bool Verify(ArticleVaultWriterLeaseReceipt? receipt)
        => receipt is not null && receipt.Schema == ArticleVaultAgentProtocol.LeaseSchema
            && ArticleVaultAgentProtocol.IsBinding(receipt.Binding)
            && receipt.Generation > 0 && Enum.IsDefined(receipt.State)
            && receipt.ObservedUnixMilliseconds >= 0
            && receipt.DeadlineUnixMilliseconds >= receipt.ObservedUnixMilliseconds
            && receipt.DeadlineUnixMilliseconds - receipt.ObservedUnixMilliseconds <= MaximumLeaseMilliseconds
            && (receipt.State != ArticleVaultWriterLeaseState.Active || receipt.DeadlineUnixMilliseconds > receipt.ObservedUnixMilliseconds)
            && (receipt.PreviousReceiptSha256 is not null
                || (receipt.Generation == 1 && receipt.State == ArticleVaultWriterLeaseState.Active))
            && (receipt.PreviousReceiptSha256 is null || ArticleVaultAgentProtocol.IsDigest(receipt.PreviousReceiptSha256))
            && ArticleVaultAgentProtocol.IsDigest(receipt.ContentSha256)
            && receipt.ContentSha256 == ArticleVaultAgentProtocol.Digest(receipt with
            {
                ContentSha256 = string.Empty
            });

    public static ArticleVaultWriterLeaseReceipt Transition(
        ArticleVaultWriterLeaseReceipt? previous,
        ArticleVaultAgentBinding owner,
        ArticleVaultWriterLeaseAction action,
        string? expectedPreviousReceiptSha256,
        long nowUnixMilliseconds,
        long durationMilliseconds = MaximumLeaseMilliseconds)
    {
        if (!ArticleVaultAgentProtocol.IsBinding(owner) || !Enum.IsDefined(action)
            || nowUnixMilliseconds < 0 || durationMilliseconds is < 1 or > MaximumLeaseMilliseconds
            || nowUnixMilliseconds > long.MaxValue - durationMilliseconds
            || (previous is not null && !Verify(previous))
            || expectedPreviousReceiptSha256 != previous?.ContentSha256)
        {
            throw new InvalidDataException("writer_lease_input_invalid");
        }

        if (previous is not null
            && (previous.Binding.SiteIdentity != owner.SiteIdentity
                || previous.Binding.VaultIdentity != owner.VaultIdentity
                || previous.Binding.RootSha256 != owner.RootSha256
                || nowUnixMilliseconds < previous.ObservedUnixMilliseconds))
        {
            throw new InvalidDataException("writer_lease_binding_or_clock_drift");
        }

        bool active = previous?.State == ArticleVaultWriterLeaseState.Active;
        bool currentOwner = previous?.Binding == owner;
        if (action == ArticleVaultWriterLeaseAction.Acquire)
        {
            // Expiration is a separate persisted transition, never implicit preemption.
            if (active || previous?.Generation == long.MaxValue)
            {
                throw new InvalidDataException("writer_lease_acquire_blocked");
            }
        }
        else if (!active || !currentOwner)
        {
            throw new InvalidDataException("writer_lease_owner_or_state_invalid");
        }

        if (action == ArticleVaultWriterLeaseAction.Renew && nowUnixMilliseconds >= previous!.DeadlineUnixMilliseconds)
        {
            throw new InvalidDataException("writer_lease_expired");
        }

        if (action == ArticleVaultWriterLeaseAction.Expire && nowUnixMilliseconds < previous!.DeadlineUnixMilliseconds)
        {
            throw new InvalidDataException("writer_lease_not_expired");
        }

        ArticleVaultWriterLeaseState state = action switch
        {
            ArticleVaultWriterLeaseAction.Acquire or ArticleVaultWriterLeaseAction.Renew => ArticleVaultWriterLeaseState.Active,
            ArticleVaultWriterLeaseAction.Release => ArticleVaultWriterLeaseState.Released,
            ArticleVaultWriterLeaseAction.Revoke => ArticleVaultWriterLeaseState.Revoked,
            ArticleVaultWriterLeaseAction.Expire => ArticleVaultWriterLeaseState.Expired,
            _ => throw new InvalidDataException("writer_lease_action_invalid")
        };
        var receipt = new ArticleVaultWriterLeaseReceipt(
            ArticleVaultAgentProtocol.LeaseSchema,
            owner,
            action == ArticleVaultWriterLeaseAction.Acquire ? (previous?.Generation ?? 0) + 1 : previous!.Generation,
            state,
            nowUnixMilliseconds,
            state == ArticleVaultWriterLeaseState.Active ? nowUnixMilliseconds + durationMilliseconds : nowUnixMilliseconds,
            previous?.ContentSha256,
            string.Empty);
        return receipt with
        {
            ContentSha256 = ArticleVaultAgentProtocol.Digest(receipt)
        };
    }
}

/// <summary>Reads closed lease receipts; a decoded receipt is not native process ownership.</summary>
public static class ArticleVaultWriterLeaseCodec
{
    public static ArticleVaultWriterLeaseReceipt Decode(ReadOnlySpan<byte> bytes)
    {
        ArticleVaultWriterLeaseReceipt receipt = ArticleVaultAgentProtocol.Decode<ArticleVaultWriterLeaseReceipt>(bytes);
        if (!ArticleVaultWriterLease.Verify(receipt))
        {
            throw new InvalidDataException("writer_lease_receipt_invalid");
        }

        return receipt;
    }
}
