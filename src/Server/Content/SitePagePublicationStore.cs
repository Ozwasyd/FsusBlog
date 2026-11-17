using System.Security.Cryptography;
using System.Text;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal static class SitePagePublicationStore
{
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private static byte[] MarkdownHash(string markdown) => SHA256.HashData(Utf8.GetBytes(markdown));

    internal static string Digest(string markdown) => Convert.ToHexStringLower(MarkdownHash(markdown));

    internal static async Task<AdminSitePageRevision> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminSitePageRevision baseline, CancellationToken ct, bool forUpdate = false)
    {
        var sql = "select revision, markdown from public.site_page_content where slug=$1";
        if (forUpdate) sql += " for update";
        await using var command = Store.Sql(db, tx, sql, baseline.Slug);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new PublicUnavailableException();
        var revision = row.GetInt64(0);
        if (revision == 0) return baseline;
        var markdown = row.GetString(1);
        return new(baseline.Slug, revision, Digest(markdown), markdown);
    }

    internal static void RequireMatch(AdminSitePageRevision current, AdminSitePagePublish intent)
    {
        if (current.Revision != intent.ExpectedRevision || current.Digest != intent.ExpectedDigest)
            throw new BusinessException(Rejection.Conflict, "The published page changed. Reload before publishing.");
    }

    internal static async Task Publish(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        AdminSitePageRevision previous, string markdown, CancellationToken ct)
    {
        await using var command = Store.Sql(db, tx, """
            with saved as (
                update public.site_page_content set revision=revision+1,markdown=$3 where slug=$1 and revision=$2
                returning slug,revision
            )
            insert into public.site_page_publish_audit (slug,revision,principal_id,previous_digest,next_digest,happened_at)
            select slug,revision,$4,$5,$6,clock_timestamp() from saved
            """, previous.Slug, previous.Revision, markdown, principal, Convert.FromHexString(previous.Digest),
            MarkdownHash(markdown));
        if (await command.ExecuteNonQueryAsync(ct) != 1)
            throw new BusinessException(Rejection.Conflict, "The published page changed. Reload before publishing.");
    }
}
