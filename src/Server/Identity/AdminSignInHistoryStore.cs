using FsusBlog.V2.Contracts;
using FsusBlogV2.Storage;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminSignInHistoryStore(AdminSessionGate gate)
{
    internal Task<(AdminSignInHistorySnapshot History, string PermissionSession)> RecentSignIns(string? token, CancellationToken ct) =>
        gate.WithLiveAdmin(token, async (db, tx, admin) =>
        {
            await using var command = Store.Sql(db, tx, """
                select h.started_at,h.expires_at,h.ended_at,coalesce(h.id=s.sign_in_id,false)
                from public.admin_sign_in h
                join public.admin_session s on s.principal_id=h.principal_id and s.digest=$2
                where h.principal_id=$1 order by h.id desc limit $3
                """, admin.Id, admin.Digest, AdminSignInHistory.RetainedSignIns);
            await using var reader = await command.ExecuteReaderAsync(ct);
            var signIns = new List<AdminSignIn>();
            while (await reader.ReadAsync(ct))
            {
                var started = reader.GetUnixMilliseconds(0);
                var expires = reader.GetUnixMilliseconds(1);
                var current = reader.GetBoolean(3);
                if (current != reader.IsDBNull(2) || (current && expires != admin.Snapshot.ExpiresAt))
                    throw new PublicUnavailableException();
                var ended = current ? 0 : reader.GetUnixMilliseconds(2);
                var state = current ? AdminSignInState.Current : ended == expires ? AdminSignInState.Expired : AdminSignInState.Ended;
                signIns.Add(new(started, expires, ended, state));
            }
            return (new AdminSignInHistorySnapshot(admin.Snapshot.Generation, signIns), AdminSessionGate.PermissionBinding(admin.Digest));
        }, ct);
}
