using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AuthoringWorkspaceRelation = "public.authoring_workspace";

    private static string[] GetAuthoringWorkspaceColumns(bool layout) =>
    [
        "authoring_workspace user_id:uuid schema_version:int4 revision:int8 updated_at:timestamptz active_article_id:int4 tabs:_int4" +
        (layout ? " inspector_open:bool=false" : "")
    ];

    internal static async Task<bool> HasAuthoringWorkspaceLayoutAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select exists (select from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass($1)
                and attname='inspector_open' and attnum>0 and not attisdropped)
            """, connection, transaction);
        query.Parameters.AddWithValue(AuthoringWorkspaceRelation);
        return await query.ExecuteScalarAsync(ct) is true;
    }

    private static readonly string[] AuthoringWorkspaceConstraints =
    [
        "authoring_workspace p user_id",
        "authoring_workspace f user_id public.blog_user:id",
        "authoring_workspace c schema_version schema_version=1",
        "authoring_workspace c revision revision>0",
        "authoring_workspace c active_article_id active_article_id>=0",
        "authoring_workspace c tabs cardinality(tabs)<=100"
    ];
}
