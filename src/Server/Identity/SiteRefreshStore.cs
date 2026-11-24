using static FsusBlog.V2.Server.SqlCommands;

namespace FsusBlog.V2.Server.Passkeys;

internal sealed class SiteRefreshStore(NpgsqlDataSource source, InstanceLease? lease = null)
{
    internal const string Setting = "FSUSBLOG_SITE_PERSISTENT_REFRESH";
    internal sealed record Issued(string Access, DateTimeOffset AccessExpires, string? Refresh = null, DateTimeOffset? RefreshExpires = null);
    internal enum ResultKind { Rotated, Contention, Rejected, Compromised }
    internal sealed record Result(ResultKind Kind, Issued? Cookies = null);
    private sealed record Family(Guid Id, byte[] Access, byte[] Refresh, byte[]? PreviousAccess, long Generation, bool Active,
        bool Recent, long AccountGeneration);

    internal static async Task<Issued> Start(NpgsqlConnection db, NpgsqlTransaction tx, string access,
        DateTimeOffset accessExpires, CancellationToken ct)
    {
        var (refresh, digest) = NewToken();
        var refreshExpires = new DateTimeOffset((DateTime)(await Scalar(db, tx, ct, """
            insert into public.site_session_refresh
                (family_id,access_digest,refresh_digest,generation,idle_expires_at,absolute_expires_at,rotated_at)
            values($1,$2,$3,0,statement_timestamp()+interval '720 hours',statement_timestamp()+interval '2160 hours',statement_timestamp())
            returning idle_expires_at
            """, Guid.NewGuid(), Store.TokenDigest(access)!, digest))!);
        return new(access, accessExpires, refresh, refreshExpires);
    }

    internal Task<bool> HasCurrent(string? refresh, CancellationToken ct) =>
        Store.TokenDigest(refresh) is not { } digest ? Task.FromResult(false) :
        InstanceLease.RunProtected(source, lease, async (db, tx) => await Scalar(db, tx, ct, """
            select exists (
                select from public.site_session_refresh f join public.user_session s on s.digest=f.access_digest
                join public.blog_user u on u.id=s.user_id
                where f.refresh_digest=$1 and f.idle_expires_at>clock_timestamp() and u.enabled and s.generation=u.generation
            )
            """, digest) is true, ct);

    internal async Task<Result> Rotate(string? refresh, string? access, CancellationToken ct)
    {
        if (Store.TokenDigest(refresh) is not { } digest) return new(ResultKind.Rejected);
        var accessDigest = Store.TokenDigest(access);
        await using var db = await source.OpenConnectionAsync(ct);
        await using var tx = await InstanceLease.BeginProtected(db, lease, ct);
        var family = await Resolve(db, tx, digest, ct);
        if (family is not { Active: true }) return new(ResultKind.Rejected);
        var isCurrent = Same(family.Refresh, digest);
        var contextMatches = access is null || Same(family.Access, accessDigest) || Same(family.PreviousAccess, accessDigest);
        if (isCurrent && (access is null || Same(family.Access, accessDigest)))
        {
            var rotated = await Replace(db, tx, family, ct);
            await InstanceLease.CommitProtected(tx, lease, ct);
            return new(ResultKind.Rotated, rotated);
        }
        if (isCurrent && family.Recent && Same(family.PreviousAccess, accessDigest))
            return new(ResultKind.Contention);
        if (isCurrent) return new(ResultKind.Rejected);
        var used = await QueryOneValue(db, tx, ct, """
            select generation,used_at>=clock_timestamp()-interval '5 seconds'
            from public.site_session_refresh_tombstone
            where refresh_digest=$1 and family_id=$2 and expires_at>clock_timestamp()
            """, r => (Generation: r.GetInt64(0), Recent: r.GetBoolean(1)), digest, family.Id);
        if (used is not var (generation, recent)) return new(ResultKind.Rejected);
        if (contextMatches && family.Recent && recent && generation == family.Generation - 1)
            return new(ResultKind.Contention);
        await Delete(db, tx, family.Access, ct);
        await InstanceLease.CommitProtected(tx, lease, ct);
        return new(ResultKind.Compromised);
    }

    internal Task SignOut(string? refresh, string? access, CancellationToken ct)
    {
        if (Store.TokenDigest(refresh) is not { } digest) return Task.CompletedTask;
        return InstanceLease.RunProtected(source, lease, async (db, tx) =>
        {
            // A supplied access credential must belong to this family. An expired one still identifies the family.
            var family = await Resolve(db, tx, digest, ct);
            var accessDigest = Store.TokenDigest(access);
            if (family is not null && (access is null || Same(family.Access, accessDigest) || Same(family.PreviousAccess, accessDigest)))
                await Delete(db, tx, family.Access, ct);
        }, ct);
    }

    internal static async Task<Guid?> FindCurrentFamily(NpgsqlConnection db, NpgsqlTransaction tx, byte[] access, CancellationToken ct) =>
        await Scalar(db, tx, ct, """
            select family_id from public.site_session_refresh where access_digest=$1 and idle_expires_at>clock_timestamp()
            """, access) as Guid?;

    private static async Task<Family?> Resolve(NpgsqlConnection db, NpgsqlTransaction tx, byte[] digest, CancellationToken ct)
    {
        var found = await QueryOneValue(db, tx, ct, """
            select f.family_id,s.user_id from public.site_session_refresh f join public.user_session s on s.digest=f.access_digest
            where f.family_id=coalesce(
                (select family_id from public.site_session_refresh where refresh_digest=$1),
                (select family_id from public.site_session_refresh_tombstone where refresh_digest=$1 and expires_at>clock_timestamp())
            )
            """, r => (Family: r.GetGuid(0), Actor: r.GetGuid(1)), digest);
        if (found is not var (family, actor)) return null;
        if (await Scalar(db, tx, ct, "select 1 from public.blog_user where id=$1 and enabled for update", actor) is null) return null;
        return await QueryOne(db, tx, ct, """
            select f.access_digest,f.refresh_digest,f.previous_access_digest,f.generation,
                f.idle_expires_at>clock_timestamp() and f.absolute_expires_at>clock_timestamp() and s.generation=u.generation,
                f.rotated_at>=clock_timestamp()-interval '5 seconds',s.generation
            from public.site_session_refresh f join public.user_session s on s.digest=f.access_digest
            join public.blog_user u on u.id=s.user_id
            where f.family_id=$1 and s.user_id=$2 for update of s,f
            """, r => new Family(family, r.GetFieldValue<byte[]>(0), r.GetFieldValue<byte[]>(1),
                r.IsDBNull(2) ? null : r.GetFieldValue<byte[]>(2), r.GetInt64(3), r.GetBoolean(4),
                r.GetBoolean(5), r.GetInt64(6)), family, actor);
    }

    private static async Task<Issued> Replace(NpgsqlConnection db, NpgsqlTransaction tx, Family family, CancellationToken ct)
    {
        var (access, accessDigest) = NewToken();
        var (refresh, refreshDigest) = NewToken();
        await Execute(db, tx, ct, """
            insert into public.site_session_refresh_tombstone(refresh_digest,family_id,generation,used_at,expires_at)
            values($1,$2,$3,statement_timestamp(),statement_timestamp()+interval '720 hours')
            """, family.Refresh, family.Id, family.Generation);
        var idleExpires = await Scalar(db, tx, ct, """
            update public.site_session_refresh set refresh_digest=$2,previous_access_digest=$3,generation=generation+1,
                idle_expires_at=least(absolute_expires_at,statement_timestamp()+interval '720 hours'),rotated_at=statement_timestamp()
            where family_id=$1 and refresh_digest=$4 and generation=$5 and idle_expires_at>clock_timestamp()
            returning idle_expires_at
            """, family.Id, refreshDigest, family.Access, family.Refresh, family.Generation) is DateTime idle ? new DateTimeOffset(idle) : throw Changed();
        var accessExpires = await Scalar(db, tx, ct, """
            update public.user_session set digest=$2,expires_at=least($3,statement_timestamp()+interval '8 hours')
            where digest=$1 and generation=$4 returning expires_at
            """, family.Access, accessDigest, idleExpires, family.AccountGeneration) is DateTime expiry ? new DateTimeOffset(expiry) : throw Changed();
        await Execute(db, tx, ct, """
            with expired as (
                select refresh_digest from public.site_session_refresh_tombstone where expires_at<=clock_timestamp()
                order by expires_at limit 32 for update skip locked
            )
            delete from public.site_session_refresh_tombstone as tombstone using expired
            where tombstone.refresh_digest=expired.refresh_digest
            """);
        return new(access, accessExpires, refresh, idleExpires);
    }

    private static Task Delete(NpgsqlConnection db, NpgsqlTransaction tx, byte[] access, CancellationToken ct) =>
        Execute(db, tx, ct, "delete from public.user_session where digest=$1", access);

    internal static (string Token, byte[] Digest) NewToken()
    {
        var bytes = RandomNumberGenerator.GetBytes(32);
        try { return (Convert.ToHexStringLower(bytes), SHA256.HashData(bytes)); }
        finally { CryptographicOperations.ZeroMemory(bytes); }
    }

    private static bool Same(byte[]? expected, byte[]? presented) =>
        expected is not null && presented is not null && CryptographicOperations.FixedTimeEquals(expected, presented);

    private static BusinessException Changed() => new(Rejection.Unauthorized, "The site session is no longer available.");
}
