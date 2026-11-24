namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminSitePageStore(AdminSessionGate gate, AdminStepUpService? stepUp = null)
{
    internal Task<byte[]> SitePagesOverview(string? token, SitePages pages, CancellationToken ct) =>
        gate.WithSession(token, async (db, tx, _) =>
            Wire.EncodeAdminSitePages(new(await pages.ConfiguredMaskAsync(db, tx, ct))), ct);

    internal Task<byte[]> SitePage(string? token, SitePages pages, string slug, CancellationToken ct) =>
        gate.WithSession(token, (db, tx, _) => pages.ConfiguredFrame(db, tx, slug, ct), ct);

    internal Task<AdminSitePageRevision> CurrentSitePage(string? session, SitePages pages, string slug, CancellationToken ct) =>
        gate.WithLiveAdmin(session, (db, tx, _) =>
            SitePagePublicationStore.Read(db, tx, pages.EditorBaseline(slug), ct), ct);

    internal Task<byte[]> BeginSitePageStepUp(string? session, SitePages pages, AdminSitePagePublish intent, CancellationToken ct) =>
        RequireStepUp().BeginStepUp(session, SitePageIntentDigest(intent),
            (db, tx, _) => CurrentSitePage(db, tx, pages, intent, ct), ct, AdminStepUpAction.PublishSitePage);

    internal Task<byte[]> CompleteSitePageStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        RequireStepUp().CompleteStepUp(session, assertion, AdminStepUpAction.PublishSitePage, ct);

    internal Task<byte[]> IssueSitePagePow(string? session, SitePages pages, AdminSitePagePublish intent, byte[] frame,
        ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await CurrentSitePage(db, tx, pages, intent, ct);
            return PowWire.EncodeChallenge(pow.Issue(PowScope.AdminSitePagePublish, intent.Slug, session!, ScopedPow.Source(ctx),
                ScopedPow.ReadClientNonce(ctx), frame));
        }, ct);

    internal Task PublishSitePage(string? session, SitePages pages, AdminSitePagePublish intent, byte[] frame,
        string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var stepUpService = RequireStepUp();
            var current = await CurrentSitePage(db, tx, pages, intent, ct, forUpdate: true);
            if (!await stepUpService.ConsumeProofAsync(db, tx, admin, proof, SitePageIntentDigest(intent), ct,
                    AdminStepUpAction.PublishSitePage))
                throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact site page change is required.");
            await pow.Consume(db, tx, PowScope.AdminSitePagePublish, intent.Slug, session!, ScopedPow.Source(ctx),
                frame, ScopedPow.ReadProof(ctx), ct);
            await SitePagePublicationStore.Publish(db, tx, admin.Id, current, intent.Markdown, ct);
            pages.MarkPublished(intent.Slug);
            return true;
        }, ct);

    private AdminStepUpService RequireStepUp() =>
        stepUp ?? throw new InvalidOperationException("Administrator site page editor Step-Up is not configured.");

    private static async Task<AdminSitePageRevision> CurrentSitePage(NpgsqlConnection db, NpgsqlTransaction tx, SitePages pages,
        AdminSitePagePublish intent, CancellationToken ct, bool forUpdate = false)
    {
        var current = await SitePagePublicationStore.Read(db, tx, pages.EditorBaseline(intent.Slug), ct, forUpdate);
        SitePagePublicationStore.RequireMatch(current, intent);
        return current;
    }

    internal static byte[] SitePageIntentDigest(AdminSitePagePublish intent) => SHA256.HashData(Wire.EncodeAdminSitePagePublish(intent));
}
