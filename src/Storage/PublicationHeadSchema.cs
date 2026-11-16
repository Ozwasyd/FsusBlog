using System;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] PublicationHeadColumns =
    [
        "publication_transparency_head singleton:bool seq:int8 entry_sha256:bytea origin:text key_id:text key_version:int4 key_sha256:bytea attested_at:timestamptz signature:bytea"
    ];

    private static readonly string[] PublicationHeadConstraints =
    [
        "article_publication_transparency u seq,entry_sha256",
        "publication_transparency_head p singleton",
        "publication_transparency_head c singleton singleton",
        "publication_transparency_head c entry_sha256 octet_length(entry_sha256)=32",
        "publication_transparency_head c signature octet_length(signature)=64",
        "publication_transparency_head f seq,entry_sha256 public.article_publication_transparency:seq,entry_sha256",
        "publication_transparency_head f key_id,key_version,key_sha256 public.publication_proof_key:key_id,version,spki_sha256",
    ];

    internal static Task<bool> HasPublicationHeadAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, "public.publication_transparency_head", ct);

    internal static async Task VerifyPublicationCheckpointSchemaAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using (var marker = new NpgsqlCommand("""
            select version from public.v2_schema
            where current_setting('session_replication_role')='origin'
              and not exists(select from pg_catalog.pg_namespace where nspname='fsus_legacy_candidate')
            """, db, tx))
        await using (var row = await marker.ExecuteReaderAsync(ct))
        {
            if (!await row.ReadAsync(ct) || row.GetInt32(0) != Version || await row.ReadAsync(ct))
                throw new InvalidOperationException("Automatic daily checkpoints require an active native V2 database.");
        }
        if (await PublicationTransparencyStateAsync(db, tx, ct) is not true || !await HasPublicationHeadAsync(db, tx, ct))
            throw new InvalidOperationException("Automatic daily checkpoints require the active native ledger and signed head.");

        var columns = Columns.Where(fact => fact.StartsWith("v2_schema ", StringComparison.Ordinal) ||
                                            fact.StartsWith("blog_outbox ", StringComparison.Ordinal))
            .Concat(PublicationCanonicalColumns).Concat(GetPublicationProofColumns(true))
            .Concat(PublicationTransparencyColumns).Concat(PublicationHeadColumns).ToArray();
        var relations = columns.Select(fact => fact.Split(' ', 2)[0]).ToHashSet(StringComparer.Ordinal);
        var hasCover = await HasPublicationCoverAsync(db, tx, ct);
        var constraints = Constraints.Concat(PublicationCanonicalConstraints)
            .Append(PublicationCanonicalVersionConstraint(hasCover)).Concat(PublicationProofConstraints)
            .Concat(PublicationTransparencyConstraints).Concat(PublicationHeadConstraints)
            .Where(fact => relations.Contains(fact.Split(' ', 2)[0])).ToArray();
        await VerifyRelationsAsync(db, tx, columns, constraints, ct);
    }
}
