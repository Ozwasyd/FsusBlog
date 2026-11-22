using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Sessions;

internal static class SiteDisplayNames
{
    internal static Task<SiteDisplayNameState> Read(Store store, string? token, string? expectedCurrent, CancellationToken ct) =>
        store.WithSession(token, false, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            SiteSessions.RequireCurrent(actor.Id, digest, expectedCurrent);
            var name = await SqlCommands.Scalar(db, tx, ct, """
                select display_name
                from public.comment_public_handle
                where user_id = $1
                """, actor.Id) as string;
            return new SiteDisplayNameState(name ?? "");
        }, ct);

    internal static Task<SiteDisplayNameState> Update(Store store, string? token, string? expectedCurrent,
        SiteDisplayNameCommand command, CancellationToken ct)
    {
        var normalized = Normalize(command.DisplayName);
        return store.WithSessionForAccountUpdate(token, async (db, tx, actor) =>
        {
            var digest = Store.TokenDigest(token)!;
            SiteSessions.RequireCurrent(actor.Id, digest, expectedCurrent);
            await SqlCommands.Execute(db, tx, ct, """
                insert into public.comment_public_handle(user_id, display_name)
                values ($1, $2)
                on conflict (user_id) do update
                    set display_name = excluded.display_name
                """, actor.Id, normalized);
            return new SiteDisplayNameState(normalized);
        }, ct);
    }

    internal static string Normalize(string? value)
    {
        var trimmed = (value ?? "").Trim();
        if (trimmed.Length == 0)
            throw new BusinessException(Rejection.Invalid, "Display name must not be empty.");
        var runes = 0;
        foreach (var rune in trimmed.EnumerateRunes())
        {
            if (Rune.IsControl(rune))
                throw new BusinessException(Rejection.Invalid, "Display name must not contain control characters.");
            runes++;
            if (runes > WireLimits.SiteDisplayNameChars)
                throw new BusinessException(Rejection.Invalid, "Display name is too long.");
        }
        if (Encoding.UTF8.GetByteCount(trimmed) > WireLimits.PublicCommentHandleBytes)
            throw new BusinessException(Rejection.Invalid, "Display name exceeds byte limit.");
        return trimmed;
    }
}
