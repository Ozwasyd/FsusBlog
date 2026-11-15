using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;
using NpgsqlTypes;

namespace FsusBlogV2.Storage;

internal static class AdminSignInHistory
{
    internal const int RetainedSignIns = 50;

    internal static async Task RecordAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        byte[] digest, long generation, CancellationToken ct)
    {
        await RetireAsync(db, tx, principal, null, ct);
        await using (var start = new NpgsqlCommand("""
            with clock as (select date_trunc('milliseconds',clock_timestamp()) as now),
            recorded as (
                insert into public.admin_sign_in(principal_id,started_at,expires_at)
                select $1,now,now+interval '2 hours' from clock
                returning id,expires_at
            )
            insert into public.admin_session(digest,principal_id,generation,expires_at,sign_in_id)
            select $2,$1,$3,expires_at,id from recorded
            """, db, tx))
        {
            start.Parameters.AddWithValue(principal);
            start.Parameters.AddWithValue(digest);
            start.Parameters.AddWithValue(generation);
            await start.ExecuteNonQueryAsync(ct);
        }

        await using var prune = new NpgsqlCommand("""
            delete from public.admin_sign_in where principal_id=$1 and id in (
                select id from public.admin_sign_in where principal_id=$1 order by id desc offset $2
            )
            """, db, tx);
        prune.Parameters.AddWithValue(principal);
        prune.Parameters.AddWithValue(RetainedSignIns);
        await prune.ExecuteNonQueryAsync(ct);
    }

    internal static async Task RetireAsync(NpgsqlConnection db, NpgsqlTransaction tx, Guid? principal, byte[]? digest,
        CancellationToken ct)
    {
        if (principal is null && digest is null) throw new ArgumentException("A session owner or digest is required.");
        await using var command = new NpgsqlCommand("""
            with retired as (
                delete from public.admin_session
                    where ($1::uuid is null or principal_id=$1) and ($2::bytea is null or digest=$2)
                    returning principal_id,sign_in_id
            )
            update public.admin_sign_in sign_in
            set ended_at=least(sign_in.expires_at,greatest(sign_in.started_at,date_trunc('milliseconds',clock_timestamp())))
            from retired where sign_in.principal_id=retired.principal_id and sign_in.id=retired.sign_in_id
                and sign_in.ended_at is null
            """, db, tx);
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Uuid, Value = (object?)principal ?? DBNull.Value });
        command.Parameters.Add(new NpgsqlParameter { NpgsqlDbType = NpgsqlDbType.Bytea, Value = (object?)digest ?? DBNull.Value });
        await command.ExecuteNonQueryAsync(ct);
    }
}
