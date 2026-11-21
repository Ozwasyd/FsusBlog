using System;
using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    internal const string AuthoringWorkspaceRelation = "public.authoring_workspace";

    private static string[] GetAuthoringWorkspaceColumns(bool layout, bool groups) =>
    [
        "authoring_workspace user_id:uuid schema_version:int4 revision:int8 updated_at:timestamptz active_article_id:int4 tabs:_int4" +
        (layout ? " inspector_open:bool=false" : "") +
        (groups ? " secondary_active_article_id:int4=0 secondary_tabs:_int4='{}'::integer[] focused_group:int4=0" : "")
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

    internal static async Task<bool> HasAuthoringWorkspaceGroupsAsync(NpgsqlConnection connection, NpgsqlTransaction transaction, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("""
            select count(*) from pg_catalog.pg_attribute where attrelid=pg_catalog.to_regclass($1)
                and attname in ('secondary_active_article_id', 'secondary_tabs', 'focused_group') and attnum>0 and not attisdropped
            """, connection, transaction);
        query.Parameters.AddWithValue(AuthoringWorkspaceRelation);
        return await query.ExecuteScalarAsync(ct) switch
        {
            0L => false,
            3L => true,
            _ => throw new InvalidOperationException("The authoring workspace group schema is incomplete.")
        };
    }

    private static bool HasAuthoringWorkspaceLayout(CatalogPresenceSnapshot catalog) =>
        catalog.HasColumn(AuthoringWorkspaceRelation, "inspector_open");

    private static bool HasAuthoringWorkspaceGroups(CatalogPresenceSnapshot catalog)
    {
        var count = (catalog.HasColumn(AuthoringWorkspaceRelation, "secondary_active_article_id") ? 1 : 0)
            + (catalog.HasColumn(AuthoringWorkspaceRelation, "secondary_tabs") ? 1 : 0)
            + (catalog.HasColumn(AuthoringWorkspaceRelation, "focused_group") ? 1 : 0);
        return Complete(count, 3, "The authoring workspace group schema is incomplete.");
    }

    private static readonly string[] AuthoringWorkspaceConstraints =
    [
        "authoring_workspace p user_id",
        "authoring_workspace f user_id public.admin_principal:id",
        "authoring_workspace c schema_version schema_version=1",
        "authoring_workspace c revision revision>0",
        "authoring_workspace c active_article_id active_article_id>=0",
        "authoring_workspace c tabs cardinality(tabs)<=100"
    ];

    private static readonly string[] AuthoringWorkspaceGroupsConstraints =
    [
        "authoring_workspace c secondary_active_article_id secondary_active_article_id>=0",
        "authoring_workspace c focused_group focused_group>=0ANDfocused_group<=1",
        "authoring_workspace c tabs,secondary_tabs (cardinality(tabs)+cardinality(secondary_tabs))<=100",
        "authoring_workspace c focused_group,secondary_active_article_id focused_group=0ORsecondary_active_article_id>0"
    ];
}
