using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly string[] AdminCommentBatchColumns =
    [
        "admin_comment_batch id:int8:a principal_id:uuid session_reference:bytea decision:int2 item_count:int4 decided_at:timestamptz",
        "admin_comment_batch_item batch_id:int8 moderation_id:int8",
        "admin_comment_batch_step_up digest:bytea principal_id:uuid session_digest:bytea generation:int8 action:int4 body_digest:bytea options:text? expires_at:timestamptz kind:int2"
    ];

    private static readonly string[] AdminCommentBatchConstraints =
    [
        "admin_comment_batch p id",
        "admin_comment_batch f principal_id public.admin_principal:id",
        "admin_comment_batch c session_reference octet_length(session_reference)=32",
        "admin_comment_batch c decision decision>=1ANDdecision<=2",
        "admin_comment_batch c item_count item_count>=2ANDitem_count<=20",
        "admin_comment_batch_item p batch_id,moderation_id",
        "admin_comment_batch_item u moderation_id",
        "admin_comment_batch_item f batch_id public.admin_comment_batch:id",
        "admin_comment_batch_item f moderation_id public.admin_comment_moderation:id",
        "admin_comment_batch_step_up p digest",
        "admin_comment_batch_step_up f principal_id public.admin_principal:id",
        "admin_comment_batch_step_up f session_digest public.admin_session:digest delete-cascade",
        "admin_comment_batch_step_up u session_digest,kind",
        "admin_comment_batch_step_up c digest octet_length(digest)=32",
        "admin_comment_batch_step_up c session_digest octet_length(session_digest)=32",
        "admin_comment_batch_step_up c generation generation>0",
        "admin_comment_batch_step_up c action action=6",
        "admin_comment_batch_step_up c body_digest octet_length(body_digest)=32",
        "admin_comment_batch_step_up c options octet_length(options)>=1ANDoctet_length(options)<=8192",
        "admin_comment_batch_step_up c kind,options kind=1ANDoptionsISNOTNULLORkind=2ANDoptionsISNULL"
    ];

    internal static async Task<bool> HasAdminCommentBatchSchemaAsync(NpgsqlConnection connection, NpgsqlTransaction transaction,
        CancellationToken cancellationToken)
    {
        await using var query = new NpgsqlCommand("""
            select count(*) from (values ('public.admin_comment_batch'),('public.admin_comment_batch_item'),
                ('public.admin_comment_batch_step_up')) as names(name)
            where pg_catalog.to_regclass(name) is not null
            """, connection, transaction);
        return await query.ExecuteScalarAsync(cancellationToken) switch
        {
            0L => false,
            3L => true,
            _ => throw new InvalidOperationException("Administrator comment batch storage is incomplete.")
        };
    }
}
