using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Core.Extensions;
using FsusBlog.V2.Server.Content;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    private const string AppearancePowScope = "site";

    internal Task<byte[]> ReadAppearance(string? session, AppearanceRegistry registry, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, _) =>
        {
            var current = await AppearanceActivationStore.Read(db, tx, registry, ct);
            var previous = await AppearanceActivationStore.Previous(db, tx, current.Revision, ct);
            var canRollback = previous is not null && previous != current.Selected && registry.IsCurrent(previous);
            return Wire.EncodeAdminAppearanceState(new(current.Revision, current.Selected.ThemeDigest, current.Selected.FontDigest,
                registry.IsCurrent(current.Selected), canRollback, previous?.ThemeDigest ?? "", previous?.FontDigest ?? ""));
        }, ct);

    internal Task<byte[]> AppearanceCatalog(string? session, AppearanceRegistry registry, CancellationToken ct) =>
        WithLiveAdmin(session, (_, _, _) => Task.FromResult(Wire.EncodeAdminAppearanceCatalog(
            registry.Available().Select(entry => new AdminAppearancePackage(entry.Id, entry.Version, entry.ArchiveDigest, entry.Font)).ToArray())), ct);

    internal Task<byte[]> AppearanceFontDetail(string? session, AppearanceRegistry registry, string? digest, CancellationToken ct) =>
        WithLiveAdmin(session, (_, _, _) =>
        {
            if (digest is not { Length: WireLimits.AdminAppearanceDigestBytes } ||
                !digest.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f'))
                throw new BusinessException(Rejection.Invalid, "Choose an exact font archive digest.");
            var detail = registry.FontDetail(digest)
                ?? throw new BusinessException(Rejection.NotFound, "The font package is unavailable.");
            return Task.FromResult(Wire.EncodeAdminAppearanceFontDetail(new(detail.Id, detail.Version, detail.ArchiveDigest,
                detail.Name ?? "", detail.Family ?? "", detail.LicenseName, detail.LicenseText, detail.FaceWeight, detail.FaceStyle,
                detail.FaceDigest, detail.FaceBytes, detail.UnicodeRange ?? "", detail.Source?.Kind ?? "", detail.Source?.Package ?? "",
                detail.Source?.Version ?? "", detail.Source?.Upstream ?? "")));
        }, ct);

    internal Task<byte[]> AppearanceHistory(string? session, long? before, int limit, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, _) =>
            Wire.EncodeAdminAppearanceHistory(await AppearanceActivationStore.History(db, tx, before, limit, ct), limit), ct);

    internal Task<byte[]> BeginAppearanceStepUp(string? session, AppearanceRegistry registry, AdminAppearanceCommand command, CancellationToken ct) =>
        BeginStepUp(session, AppearanceIntentDigest(command),
            (db, tx, _) => CheckAppearance(db, tx, registry, command, ct), ct, StepUpAction.ActivateAppearance);

    internal Task<byte[]> CompleteAppearanceStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        CompleteStepUp(session, assertion, StepUpAction.ActivateAppearance, ct);

    internal Task<byte[]> IssueAppearancePow(string? session, AppearanceRegistry registry, AdminAppearanceCommand command, byte[] frame,
        ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, _) =>
        {
            await CheckAppearance(db, tx, registry, command, ct);
            return PowWire.EncodeChallenge(pow.Issue(PowScope.AdminAppearance, AppearancePowScope, session!, ScopedPow.Source(ctx),
                ScopedPow.ReadClientNonce(ctx), frame));
        }, ct);

    internal Task ApplyAppearance(string? session, AppearanceRegistry registry, AdminAppearanceCommand command, byte[] frame,
        string? proof, ScopedPow pow, HttpContext ctx, CancellationToken ct) =>
        WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var (current, next) = await CheckAppearance(db, tx, registry, command, ct, locked: true);
            if (proof is not { Length: 43 } || !proof.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ||
                !await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), AppearanceIntentDigest(command), ct,
                    StepUpAction.ActivateAppearance))
                throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact appearance change is required.");
            await pow.Consume(db, tx, PowScope.AdminAppearance, AppearancePowScope, session!, ScopedPow.Source(ctx), frame,
                ScopedPow.ReadProof(ctx), ct);
            if (!registry.IsCurrent(next)) throw UnapprovedAppearance();
            await AppearanceActivationStore.Change(db, tx, current, next, admin.Id, command.Rollback, ct);
            return true;
        }, ct);

    private static async Task<(AppearanceActivation, AppearanceSelection)> CheckAppearance(NpgsqlConnection db, NpgsqlTransaction tx,
        AppearanceRegistry registry, AdminAppearanceCommand command, CancellationToken ct, bool locked = false)
    {
        var current = await AppearanceActivationStore.Read(db, tx, registry, ct, locked);
        if (current.Revision != command.ExpectedRevision || current.Selected != new AppearanceSelection(command.CurrentTheme, command.CurrentFont))
            throw new BusinessException(Rejection.Conflict, "The active appearance changed. Reload before applying.");
        var next = new AppearanceSelection(command.Theme, command.Font);
        if (command.Rollback && next != await AppearanceActivationStore.Previous(db, tx, current.Revision, ct))
            throw new BusinessException(Rejection.Conflict, "The previous activation has changed or is unavailable.");
        if (next == current.Selected || !registry.IsCurrent(next)) throw UnapprovedAppearance();
        return (current, next);
    }

    private static BusinessException UnapprovedAppearance() => new(Rejection.Invalid, "Choose an available, different signed appearance.");

    private static byte[] AppearanceIntentDigest(AdminAppearanceCommand command) => SHA256.HashData(Wire.EncodeAdminAppearanceCommand(command));
}
