using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static string[] GetPublicationProofColumns(bool? transparency) =>
    [
        "publication_proof_key key_id:text version:int4 spki_sha256:bytea not_before:timestamptz not_after:timestamptz revoked_at:timestamptz? compromised_at:timestamptz?",
        "article_publication_proof publication_id:int8 origin:text key_id:text key_version:int4 key_sha256:bytea issued_at:timestamptz signature:bytea" +
            (transparency switch { true => " transparency_seq:int8", false => " transparency_seq:int8?", _ => "" })
    ];

    private static readonly string[] PublicationProofConstraints =
    [
        "publication_proof_key p key_id",
        "publication_proof_key c version version>0",
        "publication_proof_key u spki_sha256",
        "publication_proof_key c spki_sha256 octet_length(spki_sha256)=32",
        "publication_proof_key c not_after,not_before not_after>=not_before",
        "publication_proof_key u key_id,version,spki_sha256",
        "article_publication_proof p publication_id",
        "article_publication_proof f publication_id public.article_publication_canonical:publication_id",
        "article_publication_proof f key_id,key_version,key_sha256 public.publication_proof_key:key_id,version,spki_sha256",
        "article_publication_proof c signature octet_length(signature)=64"
    ];

    private const string PublicationProofRelation = "public.article_publication_proof";
    private static readonly string[] PublicationProofRelations =
        [PublicationProofRelation, "public.publication_proof_key"];

    internal static Task<bool> HasPublicationProofAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasCompleteRelationsAsync(db, tx, ct, "Native publication proof schema is incomplete.",
            PublicationProofRelations);

    private static bool HasPublicationProof(CatalogPresenceSnapshot catalog) =>
        catalog.HasCompleteRelations("Native publication proof schema is incomplete.", PublicationProofRelations);
}
