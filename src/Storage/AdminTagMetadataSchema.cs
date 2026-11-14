using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] AdminTagMetadataColumns =
    [
        "taxonomy_epoch singleton:bool revision:int8",
        "admin_tag_metadata_command principal_id:uuid request_id:uuid tag_id:int4 revision:int8 old_name:text old_description:text name:text description:text changed:bool fingerprint:bytea session_reference:bytea happened_at:timestamptz"
    ];

    private static readonly string[] AdminTagMetadataConstraints =
    [
        "taxonomy_epoch p singleton",
        "taxonomy_epoch c singleton singleton",
        "taxonomy_epoch c revision revision>=0",
        "admin_tag_metadata_command p principal_id,request_id",
        "admin_tag_metadata_command f principal_id public.admin_principal:id",
        "admin_tag_metadata_command f tag_id public.tag:id",
        "admin_tag_metadata_command c revision revision>=0",
        "admin_tag_metadata_command c fingerprint octet_length(fingerprint)=32",
        "admin_tag_metadata_command c session_reference octet_length(session_reference)=32"
    ];

    internal static async Task<bool> HasAdminTagMetadataAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select count(oid) from (values (to_regclass('public.taxonomy_epoch')),
                (to_regclass('public.admin_tag_metadata_command'))) expected(oid)
            """, db, tx);
        return (await query.ExecuteScalarAsync(ct)) switch
        {
            0L => false,
            2L => true,
            _ => throw new InvalidOperationException("The administrator tag metadata schema is incomplete.")
        };
    }

    private static async Task VerifyTaxonomyEpochAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select revision=coalesce((select max(revision) from public.admin_tag_metadata_command where changed),0)
            from public.taxonomy_epoch where singleton
            """, db, tx);
        if (await query.ExecuteScalarAsync(ct) is not true)
            throw new InvalidOperationException("The taxonomy epoch and durable command history do not agree.");
    }
}
