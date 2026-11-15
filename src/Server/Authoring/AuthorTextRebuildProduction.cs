using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal static partial class AuthorTextIndex
{
    internal static Task LockRebuild(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, CancellationToken ct) =>
        Store.LockCommand(db, tx, owner, Scope, ct);

    internal static async Task<bool> ResumeBody(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner,
        AuthorTextRebuildProfile profile, CancellationToken ct)
    {
        var heading = profile == AuthorTextRebuildProfile.Heading;
        var summary = heading || profile == AuthorTextRebuildProfile.Summary;
        await Reconcile(db, tx, owner, ct, summary, heading);
        await using var current = Store.Sql(db, tx, $"with {Changed(summary, heading)} select exists(select from changed)", owner);
        current.CommandTimeout = 3;
        return await current.ExecuteScalarAsync(ct) is true;
    }

    internal static async Task<bool> ResumeProperty(NpgsqlConnection db, NpgsqlTransaction tx, Guid owner, PropertyStore properties,
        AuthorTextPropertyScope text, CancellationToken ct)
    {
        await properties.ReconcileTextProjection(text, ct);
        await using var current = Store.Sql(db, tx, $"""
            with eligible as materialized ({Eligible}), {AuthorTextPropertyIndex.Changes("eligible", 2, 3)}
            select exists(select from property_text_changed)
            """, owner, text.Definition.Id, text.Definition.Revision);
        current.CommandTimeout = 3;
        return await current.ExecuteScalarAsync(ct) is true;
    }
}
