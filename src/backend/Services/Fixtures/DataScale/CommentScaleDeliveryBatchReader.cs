using System.Runtime.CompilerServices;
using System.Text.Json;

using FsusBlog.Server.Models.CommentIdentity;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// Streams existing canonical delivery observations for a bounded batch of distinct
/// current mutation authorities. This is a read consumer, not a graph factory,
/// writer, mutation runner, semantic verifier or qualification receipt producer.
/// </summary>
public sealed class CommentScaleDeliveryBatchReader(ICommentThreadFixturePort comments)
{
    /// <summary>Bounds authority count only; no throughput or graph-size claim is made.</summary>
    public const int MaximumAuthoritiesPerBatch = 256;

    /// <summary>
    /// Preflights the whole batch before any port read, then yields each original
    /// single-pass observation in input order. A later read failure propagates;
    /// already yielded observations remain a read prefix, not an atomic snapshot.
    /// The caller must independently admit owner facts and their temporal references.
    /// Missing/pending/failed delivery, first-page queue limits, simulation validity
    /// and absent public/outbox revision fields retain the canonical port's meaning.
    /// No worker drain, retry, command, cache repair or capability custody is added.
    /// </summary>
    public async IAsyncEnumerable<CommentFixtureDeliveryObservation> ReadAsync(
        CommentFixturePortBinding binding,
        IReadOnlyList<CommentFixtureMutationResult> authorities,
        [EnumeratorCancellation] CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(comments);
        ArgumentNullException.ThrowIfNull(binding);
        ArgumentNullException.ThrowIfNull(authorities);
        cancellationToken.ThrowIfCancellationRequested();
        int count = authorities.Count;
        if (binding.Capabilities is null || binding.AuthPrepareReferenceDigests is null
            || !binding.IsValid() || count > MaximumAuthoritiesPerBatch)
        {
            throw new InvalidOperationException("Comment delivery batch binding or bounded size is invalid.");
        }

        // Compare the complete existing contract, including nested reference lists.
        // Serialization is structural equality here, never a new receipt or digest.
        string bindingMaterial = JsonSerializer.Serialize(binding);
        var pending = new List<(CommentFixtureMutationResult Authority, string Material)>(count);
        var roles = new HashSet<string>(StringComparer.Ordinal);
        var identities = new HashSet<long>();
        for (int index = 0; index < count; index++)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CommentFixtureMutationResult authority = authorities[index];
            if (authority is null || authority.Identity is null || authority.Before is null || authority.After is null
                || JsonSerializer.Serialize(authority.Binding) != bindingMaterial
                || !CommentScalePlanContract.IsRole(authority.SemanticRole)
                || !roles.Add(authority.SemanticRole)
                || authority.Identity.CommentId <= 0 || !identities.Add(authority.Identity.CommentId)
                || (authority.Identity.ActorMode == CommentAuthorModes.Public
                    ? authority.Identity.AccountId is not > 0
                    : authority.Identity.ActorMode != CommentAuthorModes.ZkAnonymous || authority.Identity.AccountId is not null)
                || string.IsNullOrWhiteSpace(authority.Identity.CapabilityId)
                || authority.Before.CurrentVersion <= 0 || authority.After.CurrentVersion <= 0
                || !Enum.IsDefined(authority.Before.ModerationStatus) || !Enum.IsDefined(authority.After.ModerationStatus)
                || !CommentScalePlanContract.IsDigest(authority.Before.ContentDigest)
                || !CommentScalePlanContract.IsDigest(authority.After.ContentDigest)
                || authority.Before.Revisions is null || authority.After.Revisions is null
                || authority.Before.ModerationEvents is null || authority.After.ModerationEvents is null
                || authority.Before.OutboxEventIds is null || authority.After.OutboxEventIds is null
                || authority.BusinessTimeUtc.Kind != DateTimeKind.Utc
                || !CommentScalePlanContract.IsDigest(authority.Identity.OperationPlanDigest)
                || !CommentScalePlanContract.IsDigest(authority.ActorReferenceDigest)
                || !CommentScalePlanContract.IsDigest(authority.SecurityReferenceDigest)
                || !CommentScalePlanContract.IsDigest(authority.PolicyDigest)
                || !CommentScalePlanContract.IsDigest(authority.CommandDigest))
            {
                throw new InvalidOperationException("Comment delivery batch contains crossed, duplicate or malformed authority facts.");
            }
            pending.Add((authority, JsonSerializer.Serialize(authority)));
        }

        foreach ((CommentFixtureMutationResult authority, string material) in pending)
        {
            cancellationToken.ThrowIfCancellationRequested();
            CommentFixtureDeliveryObservation observation = await comments.ObserveDeliveryAsync(authority, cancellationToken)
                .ConfigureAwait(false);
            cancellationToken.ThrowIfCancellationRequested();
            if (observation is null || JsonSerializer.Serialize(observation.Authority) != material)
            {
                throw new InvalidOperationException("Canonical delivery observation changed its supplied mutation authority.");
            }
            yield return observation;
        }
    }
}
