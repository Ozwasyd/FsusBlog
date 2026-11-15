using System.Security.Cryptography;
using FsusBlog.V2.Contracts;
using FsusBlog.V2.Core;
using FsusBlog.V2.Server.Security;
using FsusBlogV2.Storage;
using Npgsql;

namespace FsusBlog.V2.Server.Administration;

internal sealed partial class AdminPasskeyStore
{
    internal Task<(AdminRootCommentPowPolicy State, string PermissionSession)> ReadRootCommentPowPolicy(string? session, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.SystemConfigPermission, async (db, tx, admin) =>
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct);
            var previous = await current.PreviousSeconds(db, tx, ct);
            return (new AdminRootCommentPowPolicy(current.Generation, current.Digest, current.ProofSeconds, previous),
                PermissionBinding(admin.Digest));
        }, ct);

    internal Task<byte[]> BeginRootCommentPowStepUp(string? session, AdminRootCommentPowCommand intent, CancellationToken ct) =>
        BeginStepUp(session, RootCommentPowIntentDigest(intent),
            (db, tx, _) => CheckRootCommentPowIntent(db, tx, intent, ct), ct, StepUpAction.ActivateRootCommentPow);

    internal Task<byte[]> CompleteRootCommentPowStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        CompleteStepUp(session, assertion, StepUpAction.ActivateRootCommentPow, ct);

    internal Task<(AdminRootCommentPowPolicy State, string PermissionSession)> ApplyRootCommentPowPolicy(string? session,
        AdminRootCommentPowCommand intent, string? proof, CancellationToken ct) =>
        WithLiveAdmin(session, CurrentSchema.SystemConfigPermission, async (db, tx, admin) =>
        {
            var current = await CheckRootCommentPowIntent(db, tx, intent, ct, update: true);
            if (proof is not { Length: 43 } || !proof.All(character => char.IsAsciiLetterOrDigit(character) || character is '-' or '_') ||
                !await ConsumeStepUpProof(db, tx, admin, ChallengeDigest(proof, null), RootCommentPowIntentDigest(intent), ct,
                    StepUpAction.ActivateRootCommentPow))
                throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact root comment policy change is required.");
            var next = await current.Activate(db, tx, admin.Id, intent.ProofSeconds, intent.Rollback, ct);
            return (new AdminRootCommentPowPolicy(next.Generation, next.Digest, next.ProofSeconds, current.ProofSeconds),
                PermissionBinding(admin.Digest));
        }, ct);

    private static async Task<RootCommentPowPolicy> CheckRootCommentPowIntent(NpgsqlConnection db, NpgsqlTransaction tx,
        AdminRootCommentPowCommand intent, CancellationToken ct, bool update = false)
    {
        var current = await RootCommentPowPolicy.Read(db, tx, ct, update);
        if (current.Generation != intent.ExpectedGeneration || current.Digest != intent.ExpectedDigest ||
            (intent.Rollback && await current.PreviousSeconds(db, tx, ct) != intent.ProofSeconds))
            throw new BusinessException(Rejection.Conflict, "The root comment proof policy changed. Check its current settings.");
        if (current.ProofSeconds == intent.ProofSeconds)
            throw new BusinessException(Rejection.Invalid, "Choose a different root comment proof lifetime.");
        return current;
    }

    private static byte[] RootCommentPowIntentDigest(AdminRootCommentPowCommand intent) =>
        SHA256.HashData(Wire.EncodeAdminRootCommentPowCommand(intent));
}
