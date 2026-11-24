namespace FsusBlog.V2.Server.Administration;

internal sealed class AdminCommentRiskStore(AdminSessionGate gate, AdminStepUpService stepUp)
{
    internal Task<(AdminRootCommentPowPolicy State, string PermissionSession)> ReadRootCommentPowPolicy(string? session, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var current = await RootCommentPowPolicy.Read(db, tx, ct);
            var previous = await current.PreviousSeconds(db, tx, ct);
            return (new AdminRootCommentPowPolicy(current.Generation, current.Digest, current.ProofSeconds, previous),
                AdminSessionGate.PermissionBinding(admin.Digest));
        }, ct);

    internal Task<byte[]> BeginRootCommentPowStepUp(string? session, AdminRootCommentPowCommand intent, CancellationToken ct) =>
        stepUp.BeginStepUp(session, RootCommentPowIntentDigest(intent),
            (db, tx, _) => CheckRootCommentPowIntent(db, tx, intent, ct), ct, AdminStepUpAction.ActivateRootCommentPow);

    internal Task<byte[]> CompleteRootCommentPowStepUp(string? session, PasskeyLoginRequest assertion, CancellationToken ct) =>
        stepUp.CompleteStepUp(session, assertion, AdminStepUpAction.ActivateRootCommentPow, ct);

    internal Task<(AdminRootCommentPowPolicy State, string PermissionSession)> ApplyRootCommentPowPolicy(string? session,
        AdminRootCommentPowCommand intent, string? proof, CancellationToken ct) =>
        gate.WithLiveAdmin(session, async (db, tx, admin) =>
        {
            var current = await CheckRootCommentPowIntent(db, tx, intent, ct, update: true);
            if (!await stepUp.ConsumeProofAsync(db, tx, admin, proof, RootCommentPowIntentDigest(intent), ct,
                    AdminStepUpAction.ActivateRootCommentPow))
                throw new BusinessException(Rejection.Forbidden, "A current Passkey proof for this exact root comment policy change is required.");
            var next = await current.Activate(db, tx, admin.Id, intent.ProofSeconds, intent.Rollback, ct);
            return (new AdminRootCommentPowPolicy(next.Generation, next.Digest, next.ProofSeconds, current.ProofSeconds),
                AdminSessionGate.PermissionBinding(admin.Digest));
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
