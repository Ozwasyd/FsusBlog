using System.Threading;
using System.Threading.Tasks;
using Npgsql;

namespace FsusBlogV2.Storage;

internal static partial class CurrentSchema
{
    private const string SitePasskeyNameColumns = "site_passkey_name credential_id:bytea user_id:uuid revision:int8 name:text";
    private static readonly string[] SitePasskeyNameConstraints =
    [
        "site_passkey_name p credential_id",
        "site_passkey_name f credential_id,user_id public.passkey_credential:credential_id,user_id delete-cascade",
        "site_passkey_name c revision revision>0",
        "site_passkey_name c name char_length(name)>=1ANDchar_length(name)<=64ANDoctet_length(name)<=256"
    ];

    internal static async Task<bool> HasSitePasskeyNamesAsync(NpgsqlConnection db, NpgsqlTransaction tx, CancellationToken ct)
    {
        await using var query = new NpgsqlCommand("select pg_catalog.to_regclass('public.site_passkey_name') is not null", db, tx);
        return await query.ExecuteScalarAsync(ct) is true;
    }
}
