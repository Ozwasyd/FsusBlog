using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminSiteConfigStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    private const string SiteConfigPowScope = "site";

    internal Task<byte[]> ReadSiteConfig(string? session, PublicSiteConfiguration config, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            var current = await SiteConfigOverrideStore.Read(db, tx, config, ct);
            return Wire.EncodeAdminSiteConfigState(config.ToAdminState(current));
        }, ct);

    internal Task<byte[]> BeginSiteConfigStepUp(string? session, PublicSiteConfiguration config, AdminSiteConfigCommand command,
        CancellationToken ct) =>
        stepUp.BeginStepUp(session, CommandDigest(command),
            (db, tx, _) => CheckSiteConfig(db, tx, config, command, ct), ct, AdminStepUpAction.UpdateSiteConfig);

    internal Task<byte[]> CompleteSiteConfigStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.UpdateSiteConfig, ct);

    internal Task<byte[]> IssueSiteConfigPow(string? session, PublicSiteConfiguration config, AdminSiteConfigCommand command,
        byte[] frame, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, _) =>
        {
            await CheckSiteConfig(db, tx, config, command, ct);
            return PowWire.EncodeChallenge(pow.Issue(PowScope.AdminSiteConfig, SiteConfigPowScope, session!,
                ScopedPow.Source(ctx), ScopedPow.ReadClientNonce(ctx), frame));
        }, ct);

    internal Task SaveSiteConfig(string? session, PublicSiteConfiguration config, Publications publications,
        AdminSiteConfigCommand command, byte[] frame, string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        publications.AdministrativePublication(async invalidate =>
        {
            var saved = await gate.WithLiveAdmin(session, async (db, tx, admin) =>
            {
                var current = await CheckSiteConfig(db, tx, config, command, ct, forUpdate: true);
                var (seo, compliance) = config.ValidateOverride(command);
                if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, CommandDigest(command), ct,
                        AdminStepUpAction.UpdateSiteConfig))
                    throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact site configuration change is required.");
                await pow.Consume(db, tx, PowScope.AdminSiteConfig, SiteConfigPowScope, session!, ScopedPow.Source(ctx),
                    frame, ScopedPow.ReadProof(ctx), ct);
                var next = await SiteConfigOverrideStore.Save(db, tx, admin.Id, current, seo, compliance, ct);
                invalidate();
                return next;
            }, ct);
            config.ApplyOverride(saved);
            return true;
        }, ct);

    private static async Task<PublicSiteConfiguration.Snapshot> CheckSiteConfig(NpgsqlConnection db, NpgsqlTransaction tx,
        PublicSiteConfiguration config, AdminSiteConfigCommand command, CancellationToken ct, bool forUpdate = false)
    {
        var current = await SiteConfigOverrideStore.Read(db, tx, config, ct, forUpdate);
        SiteConfigOverrideStore.RequireMatch(current, command);
        var (nextSeo, nextCompliance) = config.ValidateOverride(command);
        var nextDigest = PublicSiteConfiguration.ComputeDigest(SiteConfigWire.EncodeSeo(nextSeo),
            SiteConfigWire.EncodeCompliance(nextCompliance));
        if (nextDigest == current.Digest)
            throw new BusinessException(Rejection.Invalid, "Change at least one site configuration value before saving.");
        return current;
    }

    internal static byte[] CommandDigest(AdminSiteConfigCommand command) =>
        SHA256.HashData(Wire.EncodeAdminSiteConfigCommand(command));
}
