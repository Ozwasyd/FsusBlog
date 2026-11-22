using System.Text;
using System.Text.Json;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using Npgsql;

namespace FsusBlog.V2.Server.Content;

internal static class SiteConfigOverrideStore
{
    private const int MaxJsonBytes = 16384;
    private static readonly UTF8Encoding Utf8 = new(false, true);

    private sealed record StoredSeo(
        string Title,
        string Description,
        string Author,
        string OgImage,
        string FaviconSvgUrl,
        string FaviconIcoUrl,
        string FaviconPngUrl,
        string AppleTouchIconUrl,
        string ManifestName,
        string ManifestShortName,
        string PwaIcon192Url,
        string PwaIcon512Url,
        string PwaMaskableIconUrl,
        string ThemeColor,
        string BackgroundColor,
        string SiteLogoUrl,
        string SiteLogoDarkUrl,
        string SiteWordmarkUrl);

    internal static async Task<PublicSiteConfiguration.Snapshot> Read(NpgsqlConnection db, NpgsqlTransaction tx,
        PublicSiteConfiguration config, CancellationToken ct, bool forUpdate = false)
    {
        var sql = "select revision, seo_json, compliance_json from public.site_config_override where singleton";
        if (forUpdate) sql += " for update";
        await using var command = Store.Sql(db, tx, sql);
        await using var row = await command.ExecuteReaderAsync(ct);
        if (!await row.ReadAsync(ct)) throw new PublicUnavailableException();
        var revision = row.GetInt64(0);
        if (revision == 0) return config.Baseline;
        var storedSeo = JsonSerializer.Deserialize<StoredSeo>(row.GetString(1))
            ?? throw new InvalidOperationException("Stored site SEO override is invalid.");
        var storedCompliance = JsonSerializer.Deserialize<SiteCompliance>(row.GetString(2))
            ?? throw new InvalidOperationException("Stored site compliance override is invalid.");
        var (seo, compliance) = config.ValidateOverride(new AdminSiteConfigCommand(
            revision, config.Baseline.Digest,
            storedSeo.Title, storedSeo.Description, storedSeo.Author, storedSeo.OgImage,
            storedSeo.FaviconSvgUrl, storedSeo.FaviconIcoUrl, storedSeo.FaviconPngUrl, storedSeo.AppleTouchIconUrl,
            storedSeo.ManifestName, storedSeo.ManifestShortName,
            storedSeo.PwaIcon192Url, storedSeo.PwaIcon512Url, storedSeo.PwaMaskableIconUrl,
            storedSeo.ThemeColor, storedSeo.BackgroundColor,
            storedSeo.SiteLogoUrl, storedSeo.SiteLogoDarkUrl, storedSeo.SiteWordmarkUrl,
            storedCompliance.Enabled, storedCompliance.RegionMode, storedCompliance.CopyrightStartYear ?? 0,
            storedCompliance.CopyrightOwner, storedCompliance.CopyrightText,
            storedCompliance.ContentLicenseName, storedCompliance.ContentLicenseUrl,
            storedCompliance.IcpRecordNumber, storedCompliance.IcpRecordUrl,
            storedCompliance.PoliceRecordNumber, storedCompliance.PoliceRecordUrl, storedCompliance.PoliceBadgeIconUrl,
            storedCompliance.OperatorName, storedCompliance.ContactEmail));
        return PublicSiteConfiguration.CreateSnapshot(revision, seo, compliance);
    }

    internal static async Task SyncAsync(NpgsqlConnection db, NpgsqlTransaction tx, PublicSiteConfiguration config, CancellationToken ct)
    {
        var snapshot = await Read(db, tx, config, ct);
        config.ApplyOverride(snapshot);
    }

    internal static void RequireMatch(PublicSiteConfiguration.Snapshot current, AdminSiteConfigCommand command)
    {
        if (current.Revision != command.ExpectedRevision || current.Digest != command.ExpectedDigest)
            throw new BusinessException(Rejection.Conflict, "The site configuration changed. Reload before saving.");
    }

    internal static async Task<PublicSiteConfiguration.Snapshot> Save(NpgsqlConnection db, NpgsqlTransaction tx, Guid principal,
        PublicSiteConfiguration.Snapshot previous, SiteSeo nextSeo, SiteCompliance nextCompliance, CancellationToken ct)
    {
        var seoJson = JsonSerializer.Serialize(new StoredSeo(
            nextSeo.Title, nextSeo.Description, nextSeo.Author, nextSeo.OgImage,
            nextSeo.FaviconSvgUrl, nextSeo.FaviconIcoUrl, nextSeo.FaviconPngUrl, nextSeo.AppleTouchIconUrl,
            nextSeo.ManifestName, nextSeo.ManifestShortName,
            nextSeo.PwaIcon192Url, nextSeo.PwaIcon512Url, nextSeo.PwaMaskableIconUrl,
            nextSeo.ThemeColor, nextSeo.BackgroundColor,
            nextSeo.SiteLogoUrl, nextSeo.SiteLogoDarkUrl, nextSeo.SiteWordmarkUrl));
        var complianceJson = JsonSerializer.Serialize(nextCompliance);
        if (Utf8.GetByteCount(seoJson) > MaxJsonBytes || Utf8.GetByteCount(complianceJson) > MaxJsonBytes)
            throw new BusinessException(Rejection.Invalid, "Site configuration exceeds storage size limits.");

        var nextSnapshot = PublicSiteConfiguration.CreateSnapshot(previous.Revision + 1, nextSeo, nextCompliance);
        if (await SqlCommands.Execute(db, tx, ct, """
            with saved as (
                update public.site_config_override set revision=revision+1, seo_json=$2, compliance_json=$3
                where singleton and revision=$1
                returning revision
            )
            insert into public.site_config_audit (revision, principal_id, previous_digest, next_digest, happened_at)
            select revision, $4, $5, $6, clock_timestamp() from saved
            """, previous.Revision, seoJson, complianceJson, principal,
            Convert.FromHexString(previous.Digest), Convert.FromHexString(nextSnapshot.Digest)) != 1)
            throw new BusinessException(Rejection.Conflict, "The site configuration changed. Reload before saving.");
        return nextSnapshot;
    }
}
