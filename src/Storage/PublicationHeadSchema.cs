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

    internal static async Task<bool> HasPublicationHeadAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var command = new NpgsqlCommand(
            "select pg_catalog.to_regclass('public.publication_transparency_head') is not null", db, tx);
        return await command.ExecuteScalarAsync(ct) is true;
    }
}
