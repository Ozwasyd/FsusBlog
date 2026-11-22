using FsusBlogV2.Storage;
using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Security;

internal sealed record RootCommentPowPolicy(long Generation, int ProofSeconds)
{
    private static readonly string[] Digests = Enumerable
        .Range(WireLimits.RootCommentPowMinSeconds, WireLimits.PowChallengeSeconds - WireLimits.RootCommentPowMinSeconds + 1)
        .Select(seconds => Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(string.Create(
            CultureInfo.InvariantCulture, $"root-comment-classic-pow-v1:{WireLimits.PowChallengeDifficulty}:{seconds}")))))
        .ToArray();

    internal string Digest => Digests[ProofSeconds - WireLimits.RootCommentPowMinSeconds];

    internal static async Task<RootCommentPowPolicy> Read(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct, bool update = false)
    {
        // PostgreSQL serializes policy activation against the same transaction that uses the proof.
        await using var query = Store.Sql(db, tx, """
            select generation, proof_seconds from public.root_comment_pow_policy where singleton
            """ + (update ? " for update" : " for share"));
        await using var row = await query.ExecuteReaderAsync(ct);
        await row.ReadRequired(ct, () => new PublicUnavailableException());
        var policy = new RootCommentPowPolicy(row.GetInt64(0), row.GetInt32(1));
        if (policy.Generation <= 0 || !Wire.IsRootCommentPowLifetime(policy.ProofSeconds))
            throw new PublicUnavailableException();
        return policy;
    }

    internal async Task<int> PreviousSeconds(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        if (Generation == 1) return 0;
        return await SqlCommands.Scalar(db, tx, ct, """
            select previous_seconds from public.root_comment_pow_policy_audit
            where generation=$1 and proof_seconds=$2
            """, Generation, ProofSeconds) is int prior && Wire.IsRootCommentPowLifetime(prior) && prior != ProofSeconds
            ? prior : throw new PublicUnavailableException();
    }

    internal async Task<RootCommentPowPolicy> Activate(NpgsqlConnection db, NpgsqlTransaction tx, Guid actor,
        int seconds, bool rollback, CancellationToken ct)
    {
        var next = new RootCommentPowPolicy(checked(Generation + 1), seconds);
        if (await SqlCommands.Execute(db, tx, ct, """
            with change as (
                update public.root_comment_pow_policy set generation=$3,proof_seconds=$4
                where singleton and generation=$1 and proof_seconds=$2 returning generation
            )
            insert into public.root_comment_pow_policy_audit
                (generation,principal_id,previous_seconds,proof_seconds,rollback,happened_at)
            select generation,$5,$2,$4,$6,clock_timestamp() from change
            """, Generation, ProofSeconds, next.Generation, next.ProofSeconds, actor, rollback) != 1)
            throw new BusinessException(Rejection.Conflict, "The root comment proof policy changed. Check its current settings.");
        return next;
    }
}
