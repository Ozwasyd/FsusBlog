using System.Security.Cryptography;

using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Services.Security;

using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Host-only approval producer. HTTP/AEDS confirmation screens and production composition are
/// separately owned; no runtime registration or automatic approval is provided by this leaf.
/// </summary>
public sealed class AuthoringExtensionApprovalAuthority(
    IHttpContextAccessor contexts,
    IConfiguration configuration,
    PostgresAuthoringExtensionApprovalStore store,
    IAuthoringFencedExtensionStateStore state,
    IAuthoringLifecycleReceiptStore receipts,
    IAdminPrincipalService administrators) : IAuthoringExtensionApprovalAuthority
{
    private static readonly object s_issuer = new();
    private const string RetainBackups = "retain-exact-source-and-destination-backups";
    private const string PurgeBackups = "purge-current-and-retained-backups";

    /// <summary>Opaque server-issued capability, bound to the durable claim revision.</summary>
    public sealed class ApprovedClaim
    {
        private readonly AuthoringApprovalDecision _decision;

        internal ApprovedClaim(object issuer, AuthoringApprovalDecision decision)
        {
            Require(ReferenceEquals(issuer, s_issuer) && decision.Status == AuthoringApprovalStatus.Claimed,
                "approval_server_issuer_required");
            _decision = decision;
        }

        public string DecisionId => _decision.DecisionId;
        public string OperationSha256 => _decision.OperationSha256;
        public AuthoringApprovalOperation Operation => _decision.Operation;
        public string Digest => _decision.Digest;
        public DateTimeOffset ExpiresAt => _decision.ExpiresAt;
        public AuthoringStateScope Scope => _decision.Scope;
        public AuthoringExtensionOperationContext OperationContext => _decision.OperationContext;
        public AuthoringLifecycleReceipt ExpectedLifecycleReceipt => _decision.ExpectedLifecycleReceipt;
        public AuthoringFencedStateMigration? FrozenPlan => _decision.FrozenPlan;
        public AuthoringFencedStateDeletion? FencedDeletion => _decision.Measurement is { } measurement
            ? new(measurement, DecisionId) : null;

        internal string ResultPackageIdentity => _decision.NewPackageIdentity;

        internal bool Matches(AuthoringApprovalDecision decision) =>
            decision.DecisionId == DecisionId && decision.Digest == Digest &&
            decision.Actor == _decision.Actor && decision.Operation == Operation &&
            decision.ExpectedLifecycleReceipt == ExpectedLifecycleReceipt &&
            decision.Revision >= _decision.Revision;
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> PrepareMigrationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration plan, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, plan);
        Require(frozen.From.SiteId == actor.SiteId, "approval_site_mismatch");
        (long records, long bytes) = await ValidateMigrationAsync(oldPackage, newPackage, frozen, expectedLifecycleReceipt, cancellationToken);
        string digest = MigrationDigest(oldPackage, newPackage, frozen, expectedLifecycleReceipt, records, bytes);
        AuthoringApprovalDecision result = await store.CreateAsync(actor.Id, actor.SessionId, actor.SiteId,
            current => Decision(current, AuthoringApprovalOperation.Migration, oldPackage, newPackage, frozen.From,
                frozen, null, records, bytes, RetainBackups, digest, expectedLifecycleReceipt), cancellationToken);
        return Preview(result);
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> PrepareDeletionAsync(
        VerifiedAuthoringPackage package, AuthoringStateScope scope, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        Require(scope.SiteId == actor.SiteId, "approval_site_mismatch");
        Require(expectedLifecycleReceipt.State == AuthoringLifecycleState.RetainedData, "approval_deletion_requires_retained_data");
        ValidateOwner(package, scope);
        await ValidateReceiptAsync(package, expectedLifecycleReceipt, cancellationToken);
        AuthoringStateMeasurement measurement = await state.MeasureAsync(package, scope, cancellationToken);
        string digest = DeletionDigest(package, measurement, expectedLifecycleReceipt);
        AuthoringApprovalDecision result = await store.CreateAsync(actor.Id, actor.SessionId, actor.SiteId,
            current => Decision(current, AuthoringApprovalOperation.Deletion, package, package, scope,
                null, measurement, measurement.Records, measurement.Bytes, PurgeBackups, digest, expectedLifecycleReceipt), cancellationToken);
        return Preview(result);
    }

    /// <summary>Called only after an explicit exact preview confirmation; MFA proves identity, not consent.</summary>
    public async ValueTask<AuthoringExtensionApprovalPreview> ConfirmMigrationAsync(
        string decisionId, VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration frozenPlan, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        string displayedDigest, string stepUpProof, CancellationToken cancellationToken = default)
    {
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, frozenPlan);
        return Preview(await ChangeAsync(decisionId, async (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Pending, "approval_not_pending");
            (long records, long bytes) = await ValidateMigrationAsync(oldPackage, newPackage, frozen, expectedLifecycleReceipt, token);
            Match(current, AuthoringApprovalOperation.Migration,
                MigrationDigest(oldPackage, newPackage, frozen, expectedLifecycleReceipt, records, bytes), expectedLifecycleReceipt);
            Require(current.Digest == displayedDigest, "approval_display_digest_mismatch");
            await ConsumeProofAsync(current, stepUpProof, token);
            return current with { Status = AuthoringApprovalStatus.Approved };
        }, cancellationToken, AuthoringApprovalStatus.Approved));
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> ConfirmDeletionAsync(
        string decisionId, VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, string displayedDigest, string stepUpProof,
        CancellationToken cancellationToken = default) =>
        Preview(await ChangeAsync(decisionId, async (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Pending, "approval_not_pending");
            await ValidateDeletionAsync(package, measurement, expectedLifecycleReceipt, token);
            Match(current, AuthoringApprovalOperation.Deletion, DeletionDigest(package, measurement, expectedLifecycleReceipt), expectedLifecycleReceipt);
            Require(current.Digest == displayedDigest, "approval_display_digest_mismatch");
            await ConsumeProofAsync(current, stepUpProof, token);
            return current with { Status = AuthoringApprovalStatus.Approved };
        }, cancellationToken, AuthoringApprovalStatus.Approved));

    public async ValueTask<ApprovedClaim> ClaimMigrationAsync(
        string decisionId, VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration frozenPlan, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, frozenPlan);
        AuthoringApprovalDecision decision = await ChangeAsync(decisionId, async (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Approved, "approval_not_approved_or_replayed");
            (long records, long bytes) = await ValidateMigrationAsync(oldPackage, newPackage, frozen, expectedLifecycleReceipt, token);
            Match(current, AuthoringApprovalOperation.Migration,
                MigrationDigest(oldPackage, newPackage, frozen, expectedLifecycleReceipt, records, bytes), expectedLifecycleReceipt);
            return current with { Status = AuthoringApprovalStatus.Claimed };
        }, cancellationToken, AuthoringApprovalStatus.Claimed);
        return new(s_issuer, decision);
    }

    public async ValueTask<ApprovedClaim> ClaimDeletionAsync(
        string decisionId, VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, CancellationToken cancellationToken = default)
    {
        AuthoringApprovalDecision decision = await ChangeAsync(decisionId, async (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Approved, "approval_not_approved_or_replayed");
            await ValidateDeletionAsync(package, measurement, expectedLifecycleReceipt, token);
            Match(current, AuthoringApprovalOperation.Deletion, DeletionDigest(package, measurement, expectedLifecycleReceipt), expectedLifecycleReceipt);
            return current with { Status = AuthoringApprovalStatus.Claimed };
        }, cancellationToken, AuthoringApprovalStatus.Claimed);
        return new(s_issuer, decision);
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> DenyAsync(string decisionId, CancellationToken cancellationToken = default) =>
        Preview(await ChangeAsync(decisionId, (current, _) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Pending, "approval_not_pending");
            return ValueTask.FromResult(current with { Status = AuthoringApprovalStatus.Denied });
        }, cancellationToken, AuthoringApprovalStatus.Denied));

    public async ValueTask<AuthoringExtensionApprovalPreview> RevokeAsync(string decisionId, CancellationToken cancellationToken = default) =>
        Preview(await ChangeAsync(decisionId, (current, _) =>
        {
            Require(current.Status is AuthoringApprovalStatus.Pending or AuthoringApprovalStatus.Approved, "approval_not_revocable");
            return ValueTask.FromResult(current with { Status = AuthoringApprovalStatus.Revoked });
        }, cancellationToken, AuthoringApprovalStatus.Revoked));

    /// <summary>After restart, mark a stranded durable claim for recovery without granting a second claim.</summary>
    public async ValueTask<AuthoringExtensionApprovalPreview> MarkInterruptedAsync(string decisionId, CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        AuthoringApprovalDecision result = await store.ChangeAsync(decisionId, actor.Id, actor.SessionId, actor.SiteId,
            (current, _) =>
            {
                Require(current.Status == AuthoringApprovalStatus.Claimed, "approval_not_interrupted_claim");
                return ValueTask.FromResult(current with { Status = AuthoringApprovalStatus.RecoveryRequired });
            }, cancellationToken, fenceLifecycle: false);
        return Preview(result);
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> ReadAsync(string decisionId, CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        return Preview(await store.ChangeAsync(decisionId, actor.Id, actor.SessionId, actor.SiteId,
            (current, _) => ValueTask.FromResult(current), cancellationToken, fenceLifecycle: false));
    }

    public ValueTask SettleFailureAsync(ApprovedClaim claim, AuthoringApprovalStatus terminal, CancellationToken cancellationToken = default)
    {
        Require(terminal is AuthoringApprovalStatus.Failed or AuthoringApprovalStatus.RecoveryRequired, "approval_failure_terminal_required");
        return store.SettleAsync(claim, terminal, null, cancellationToken);
    }

    public async ValueTask CompleteAsync(ApprovedClaim claim, AuthoringLifecycleReceipt result, CancellationToken cancellationToken = default)
    {
        Require((claim.Operation == AuthoringApprovalOperation.Migration
                ? result.State == AuthoringLifecycleState.Running
                : result.State == AuthoringLifecycleState.Removed) && result.FailureCode is null &&
            result.ExtensionId == claim.Scope.ExtensionId && result.PackageSha256 == claim.ResultPackageIdentity &&
            result.ScopeDigest == claim.Digest && result.Generation > claim.ExpectedLifecycleReceipt.Generation &&
            result.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(result) &&
            await receipts.GetLatestAsync(result.ExtensionId, cancellationToken) == result, "approval_result_not_durable");
        await store.SettleAsync(claim, AuthoringApprovalStatus.Completed, result.ReceiptSha256, cancellationToken);
    }

    private async ValueTask<AuthoringApprovalDecision> ChangeAsync(string id,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask<AuthoringApprovalDecision>> change,
        CancellationToken token, AuthoringApprovalStatus expected)
    {
        var actor = CurrentActor();
        AuthoringApprovalDecision result = await store.ChangeAsync(id, actor.Id, actor.SessionId, actor.SiteId, change, token);
        Require(result.Status == expected, "approval_expired_or_invalid");
        return result;
    }

    private async ValueTask ConsumeProofAsync(AuthoringApprovalDecision current, string proof, CancellationToken token)
    {
        Require(await administrators.ValidateAndConsumeAdminStepUpProofTokenAsync(current.Actor.PrincipalId,
            current.Actor.SessionId, "admin-sensitive", proof, token), "approval_recent_identity_proof_required");
    }

    private (long Id, string SessionId, string SiteId) CurrentActor()
    {
        HttpContext? context = contexts.HttpContext;
        Require(context?.User.Identity?.IsAuthenticated == true && context.User.IsAdminPrincipal(), "approval_authenticated_admin_required");
        Require(context!.User.TryGetAdminPrincipalId(out long id), "approval_admin_id_missing");
        string? sessionId = context.User.GetAdminSessionId();
        string? siteId = configuration["AuthoringExtensions:SiteId"];
        Require(IsField(sessionId, 64) && IsField(siteId, 256), "approval_session_or_configured_site_missing");
        return (id, sessionId!, siteId!);
    }

    private async ValueTask<(long Records, long Bytes)> ValidateMigrationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan,
        AuthoringLifecycleReceipt expected, CancellationToken token)
    {
        Require(oldPackage.Trust.ValidUntil > DateTimeOffset.UtcNow && newPackage.Trust.ValidUntil > DateTimeOffset.UtcNow,
            "approval_package_trust_expired");
        await ValidateReceiptAsync(oldPackage, expected, token);
        AuthoringStateSnapshot source = await state.ReadAsync(oldPackage, plan.From, token);
        AuthoringStateSnapshot target = await state.ReadAsync(newPackage, plan.To, token);
        Require(source.Revision == plan.ExpectedFromRevision && target.Revision == plan.ExpectedToRevision &&
            source.ContentSha256 == plan.SourceContentSha256, "approval_plan_state_drift");
        _ = Transform(source, plan, token);
        return (source.Entries.Length + target.Entries.Length, ValueBytes(source) + ValueBytes(target));
    }

    private async ValueTask ValidateDeletionAsync(VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expected, CancellationToken token)
    {
        Require(expected.State == AuthoringLifecycleState.RetainedData, "approval_deletion_requires_retained_data");
        ValidateOwner(package, measurement.Scope);
        await ValidateReceiptAsync(package, expected, token);
        Require(await state.MeasureAsync(package, measurement.Scope, token) == measurement, "approval_deletion_measurement_drift");
    }

    private async ValueTask ValidateReceiptAsync(VerifiedAuthoringPackage package, AuthoringLifecycleReceipt expected, CancellationToken token)
    {
        Require(package.Trust.Status == AuthoringPackageTrustStatus.Trusted && package.Trust.ValidUntil > DateTimeOffset.UtcNow &&
            expected.ExtensionId == package.Contract.Manifest.Id && expected.PackageSha256 == package.PackageIdentity &&
            expected.Version == package.Contract.Manifest.Version && expected.StateSchemaVersion == package.Contract.Manifest.StateSchemaVersion &&
            expected.DataSchemaVersion == package.Contract.Manifest.DataSchemaVersion &&
            expected.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(expected) &&
            await receipts.GetLatestAsync(expected.ExtensionId, token) == expected, "approval_lifecycle_identity_or_generation_mismatch");
    }

    private static void Match(AuthoringApprovalDecision decision, AuthoringApprovalOperation operation, string digest, AuthoringLifecycleReceipt expected) =>
        Require(decision.Operation == operation && decision.Digest == digest && decision.ExpectedLifecycleReceipt == expected,
            "approval_exact_operation_plan_or_receipt_mismatch");

    private static string MigrationDigest(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration plan, AuthoringLifecycleReceipt expected, long records, long bytes) => Digest(new
        {
            Kind = "authoring-migration-approval-v1", OldPackage = oldPackage.PackageIdentity, NewPackage = newPackage.PackageIdentity,
            Plan = plan, Receipt = expected, Records = records, Bytes = bytes, Retention = RetainBackups
        });

    private static string DeletionDigest(VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement, AuthoringLifecycleReceipt expected) => Digest(new
    {
        Kind = "authoring-deletion-approval-v1", Package = package.PackageIdentity, Measurement = measurement,
        Receipt = expected, Retention = PurgeBackups
    });

    private static AuthoringApprovalDecision Decision(AuthoringApprovalActor actor, AuthoringApprovalOperation operation,
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringStateScope scope,
        AuthoringFencedStateMigration? plan, AuthoringStateMeasurement? measurement, long records, long bytes,
        string retention, string digest, AuthoringLifecycleReceipt receipt) =>
        new(1, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), operation, AuthoringApprovalStatus.Pending,
            0, actor, oldPackage.PackageIdentity, newPackage.PackageIdentity, scope, plan, measurement,
            records, bytes, retention, digest, receipt, DateTimeOffset.UtcNow.AddMinutes(5), null);

    private static AuthoringExtensionApprovalPreview Preview(AuthoringApprovalDecision decision) =>
        new(1, decision.OperationContext, decision.DecisionId, decision.Operation, decision.Status, decision.Scope, decision.FrozenPlan?.To,
            decision.Records, decision.Bytes, decision.Retention, decision.Digest, decision.FrozenPlan,
            decision.Measurement, decision.ExpectedLifecycleReceipt, decision.ExpiresAt);
}
