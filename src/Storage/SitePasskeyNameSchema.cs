using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private static readonly SchemaFacts SitePasskeyNameShape = Table(
        "site_passkey_name credential_id:bytea user_id:uuid revision:int8 name:text",
        "p credential_id",
        "f credential_id,user_id public.passkey_credential:credential_id,user_id delete-cascade",
        "c revision revision>0",
        "c name char_length(name)>=1ANDchar_length(name)<=64ANDoctet_length(name)<=256");

    private const string SitePasskeyNameRelation = "public.site_passkey_name";

    internal static Task<bool> HasSitePasskeyNamesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct) =>
        HasRelationAsync(db, tx, SitePasskeyNameRelation, ct);
}
