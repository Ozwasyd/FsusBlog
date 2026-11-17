using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Operations;
using Npgsql;

namespace FsusBlog.V2.Server.Authoring;

internal enum AuthorTextRebuildProfile { Legacy = 1, Summary = 2, Heading = 3, PropertyText = 4 }

internal readonly struct AuthorTextRebuildQueue(InstanceLease lease)
{
    internal bool Installed => lease.AuthorTextRebuildInstalled;

    internal Task EnqueueProperties(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, long schemaRevision,
        IReadOnlyList<(Guid Id, long Revision)> definitions, CancellationToken ct) =>
        Enqueue(db, tx, actor, AuthorTextRebuildProfile.PropertyText, schemaRevision, definitions, ct);

    internal async Task Enqueue(NpgsqlConnection db, NpgsqlTransaction tx, Identity actor, AuthorTextRebuildProfile profile,
        long schemaRevision, IReadOnlyList<(Guid Id, long Revision)> definitions, CancellationToken ct)
    {
        if (!Installed || definitions.Count == 0) return;
        await using var command = SqlCommands.Create(db, tx, """
            insert into public.author_text_rebuild_job
                (owner_id,profile,definition_id,owner_generation,schema_revision,definition_revision,available_at)
            select $1,$2,d.id,$3,$4,d.revision,statement_timestamp()
            from unnest($5::uuid[],$6::bigint[]) as d(id,revision)
            on conflict (owner_id,profile,definition_id) do update set owner_generation=excluded.owner_generation,
                schema_revision=excluded.schema_revision,definition_revision=excluded.definition_revision,
                available_at=excluded.available_at
            where (author_text_rebuild_job.owner_generation,author_text_rebuild_job.schema_revision,
                author_text_rebuild_job.definition_revision) is distinct from
                (excluded.owner_generation,excluded.schema_revision,excluded.definition_revision)
            """, actor.Id, (int)profile, actor.Generation, schemaRevision,
            definitions.Select(item => item.Id).ToArray(), definitions.Select(item => item.Revision).ToArray());
        command.CommandTimeout = 3;
        await command.ExecuteNonQueryAsync(ct);
    }
}
