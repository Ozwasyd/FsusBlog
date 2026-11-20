using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<AdminSitePageRevision> CurrentSitePage(string? session, SitePages pages, string slug, CancellationToken ct) =>
        WithLiveAdmin(session, (db, tx, _) =>
            SitePagePublicationStore.Read(db, tx, pages.EditorBaseline(slug), ct), ct);

    internal Task<byte[]> BeginSitePageStepUp(string? session, SitePages pages, AdminSitePagePublish intent, CancellationToken ct) =>
        BeginStepUp(session, SitePageIntentDigest(intent),
            (db, tx, _) => CurrentSitePage(db, tx, pages, intent, ct), ct, StepUpAction.PublishSitePage);

    internal Task<byte[]> CompleteSitePageStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        CompleteStepUp(session, assertion, StepUpAction.PublishSitePage, ct);

    internal Task<byte[]> IssueSitePagePow(string? session, SitePages pages, AdminSitePagePublish intent, byte[] frame,
        ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, _) =>
        {
            await CurrentSitePage(db, tx, pages, intent, ct);
            return PowWire.EncodeChallenge(pow.Issue(PowScope.AdminSitePagePublish, intent.Slug, session!, ScopedPow.Source(ctx),
                ScopedPow.ReadClientNonce(ctx), frame));
        }, ct);

    internal Task PublishSitePage(string? session, SitePages pages, AdminSitePagePublish intent, byte[] frame,
        string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var current = await CurrentSitePage(db, tx, pages, intent, ct, forUpdate: true);
            if (proof is not { Length: 43 } || !proof.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ||
                !await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), SitePageIntentDigest(intent), ct,
                    StepUpAction.PublishSitePage))
                throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact site page change is required.");
            await pow.Consume(db, tx, PowScope.AdminSitePagePublish, intent.Slug, session!, ScopedPow.Source(ctx),
                frame, ScopedPow.ReadProof(ctx), ct);
            await SitePagePublicationStore.Publish(db, tx, admin.Id, current, intent.Markdown, ct);
            return true;
        }, ct);

    private static async Task<AdminSitePageRevision> CurrentSitePage(NpgsqlConnection db, NpgsqlTransaction tx, SitePages pages,
        AdminSitePagePublish intent, CancellationToken ct, bool forUpdate = false)
    {
        var current = await SitePagePublicationStore.Read(db, tx, pages.EditorBaseline(intent.Slug), ct, forUpdate);
        SitePagePublicationStore.RequireMatch(current, intent);
        return current;
    }

    internal static byte[] SitePageIntentDigest(AdminSitePagePublish intent) => SHA256.HashData(Wire.EncodeAdminSitePagePublish(intent));
}
