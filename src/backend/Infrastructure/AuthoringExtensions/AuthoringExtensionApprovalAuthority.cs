using System.Collections.Immutable;
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
    IAdminPrincipalService administrators,
    IAuthoringExtensionApprovalScopeAuthority? scopeAuthority = null,
    IAuthoringExtensionApprovalExecutionResultSource? executionResults = null) : IAuthoringExtensionApprovalAuthority
{
    private static readonly object s_issuer = new();
    private const string RetainBackups = "retain-exact-source-and-destination-backups";
    private const string PurgeBackups = "purge-current-and-retained-backups";

    /// <summary>Opaque server-issued capability, bound to the durable claim revision.</summary>
    public sealed class ApprovedClaim
    {
        private readonly AuthoringApprovalDecision _decision;

        internal ApprovedClaim(object issuer, AuthoringApprovalDecision decision,
            VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage)
        {
            Require(ReferenceEquals(issuer, s_issuer) && decision.Status == AuthoringApprovalStatus.Claimed,
                "approval_server_issuer_required");
            _decision = decision;
            OldPackage = oldPackage;
            NewPackage = newPackage;
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

        public ImmutableArray<AuthoringExecutionTarget> OrderedOldTargets => _decision.OrderedOldTargets;
        public ImmutableArray<AuthoringExecutionTarget> OrderedNewTargets => _decision.OrderedNewTargets;
        internal string ResultPackageIdentity => _decision.NewPackageIdentity;
        internal string ResultPackageSha256 => _decision.NewPackageSha256;
        internal string ResultVersion => _decision.NewPackageVersion;
        internal int ResultStateSchemaVersion => _decision.NewStateSchemaVersion;
        internal int ResultDataSchemaVersion => _decision.NewDataSchemaVersion;
        internal string ScopeAuthorizationSha256 => _decision.ScopeAuthorizationSha256;
        internal AuthoringApprovalActor Actor => _decision.Actor;
        internal VerifiedAuthoringPackage OldPackage
        {
            get;
        }
        internal VerifiedAuthoringPackage NewPackage
        {
            get;
        }

        internal bool Matches(AuthoringApprovalDecision decision) =>
            decision.DecisionId == DecisionId && decision.Digest == Digest &&
            decision.Actor == _decision.Actor && decision.Operation == Operation &&
            decision.ExpectedLifecycleReceipt == ExpectedLifecycleReceipt &&
            decision.Revision >= _decision.Revision;
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> PrepareMigrationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration plan, ImmutableArray<AuthoringExecutionTarget> orderedOldTargets,
        ImmutableArray<AuthoringExecutionTarget> orderedNewTargets, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, plan);
        ImmutableArray<AuthoringExecutionTarget> oldTargets = AuthoringExtensionApprovalContract.FreezeTargets(oldPackage, orderedOldTargets);
        ImmutableArray<AuthoringExecutionTarget> newTargets = AuthoringExtensionApprovalContract.FreezeTargets(newPackage, orderedNewTargets);
        await using var transaction = await store.BeginAsync(actor.Id, actor.SessionId, actor.SiteId, cancellationToken);
        await ValidateReceiptAsync(oldPackage, expectedLifecycleReceipt, cancellationToken);
        Require(frozen.From.SiteId == actor.SiteId, "approval_site_mismatch");
        await using IAuthoringExtensionStateObservation observedState = await ObserveMigrationAsync(oldPackage, newPackage, frozen, cancellationToken);
        await observedState.VerifyCurrentAsync(cancellationToken);
        await using IAuthoringExtensionApprovalScope access = await AcquireScopeAsync(AuthoringApprovalOperation.Migration, frozen.From, frozen.To, observedState, cancellationToken);
        (long records, long bytes) = MigrationCounts(observedState);
        string digest = MigrationDigest(oldPackage, newPackage, frozen, oldTargets, newTargets, expectedLifecycleReceipt, records, bytes, access.AuthorizationSha256);
        AuthoringApprovalDecision result = await store.CreateAsync(transaction,
            Decision(transaction.Actor, AuthoringApprovalOperation.Migration, oldPackage, newPackage, frozen.From,
                frozen, null, records, bytes, RetainBackups, digest, expectedLifecycleReceipt, oldTargets, newTargets, access.AuthorizationSha256),
            async token =>
            {
                await access.VerifyCurrentAsync(token);
                await observedState.VerifyCurrentAsync(token);
            }, cancellationToken);
        return Preview(result);
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> PrepareDeletionAsync(
        VerifiedAuthoringPackage package, AuthoringStateScope scope, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        Require(scope.SiteId == actor.SiteId, "approval_site_mismatch");
        await using var transaction = await store.BeginAsync(actor.Id, actor.SessionId, actor.SiteId, cancellationToken);
        await ValidateReceiptAsync(package, expectedLifecycleReceipt, cancellationToken);
        Require(expectedLifecycleReceipt.State == AuthoringLifecycleState.RetainedData, "approval_deletion_requires_retained_data");
        ValidateOwner(package, scope);
        AuthoringStateMeasurement measurement = await state.MeasureAsync(package, scope, cancellationToken);
        await using IAuthoringExtensionStateObservation observedState = await ObserveDeletionAsync(package, measurement, expectedLifecycleReceipt, cancellationToken);
        await observedState.VerifyCurrentAsync(cancellationToken);
        await using IAuthoringExtensionApprovalScope access = await AcquireScopeAsync(AuthoringApprovalOperation.Deletion, scope, null, observedState, cancellationToken);
        string digest = DeletionDigest(package, measurement, expectedLifecycleReceipt, access.AuthorizationSha256);
        AuthoringApprovalDecision result = await store.CreateAsync(transaction,
            Decision(transaction.Actor, AuthoringApprovalOperation.Deletion, package, package, scope,
                null, measurement, measurement.Records, measurement.Bytes, PurgeBackups, digest, expectedLifecycleReceipt, [], [], access.AuthorizationSha256),
            async token =>
            {
                await access.VerifyCurrentAsync(token);
                await observedState.VerifyCurrentAsync(token);
            }, cancellationToken);
        return Preview(result);
    }

    /// <summary>Called only after an explicit exact preview confirmation; MFA proves identity, not consent.</summary>
    public async ValueTask<AuthoringExtensionApprovalPreview> ConfirmMigrationAsync(
        string decisionId, VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration frozenPlan, ImmutableArray<AuthoringExecutionTarget> orderedOldTargets,
        ImmutableArray<AuthoringExecutionTarget> orderedNewTargets, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        string displayedDigest, string stepUpProof, CancellationToken cancellationToken = default)
    {
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, frozenPlan);
        ImmutableArray<AuthoringExecutionTarget> oldTargets = AuthoringExtensionApprovalContract.FreezeTargets(oldPackage, orderedOldTargets);
        ImmutableArray<AuthoringExecutionTarget> newTargets = AuthoringExtensionApprovalContract.FreezeTargets(newPackage, orderedNewTargets);
        (long records, long bytes) = (0L, 0L);
        return Preview(await ChangeAsync(decisionId, async (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Pending, "approval_not_pending");
            Match(current, AuthoringApprovalOperation.Migration,
                MigrationDigest(oldPackage, newPackage, frozen, oldTargets, newTargets, expectedLifecycleReceipt, records, bytes, current.ScopeAuthorizationSha256), expectedLifecycleReceipt);
            Require(current.Digest == displayedDigest, "approval_display_digest_mismatch");
            await ConsumeProofAsync(current, stepUpProof, token);
            return current with
            {
                Status = AuthoringApprovalStatus.Approved
            };
        }, cancellationToken, AuthoringApprovalStatus.Approved,
            async (_, token) =>
            {
                IAuthoringExtensionStateObservation observation = await ObserveMigrationAsync(oldPackage, newPackage, frozen, token);
                try
                {
                    await observation.VerifyCurrentAsync(token);
                    token.ThrowIfCancellationRequested();
                    (records, bytes) = MigrationCounts(observation);
                    return observation;
                }
                catch
                {
                    await observation.DisposeAsync();
                    throw;
                }
            },
            (_, token) => ValidateReceiptAsync(oldPackage, expectedLifecycleReceipt, token)));
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> ConfirmDeletionAsync(
        string decisionId, VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, string displayedDigest, string stepUpProof,
        CancellationToken cancellationToken = default) =>
        Preview(await ChangeAsync(decisionId, async (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Pending, "approval_not_pending");
            Match(current, AuthoringApprovalOperation.Deletion, DeletionDigest(package, measurement, expectedLifecycleReceipt, current.ScopeAuthorizationSha256), expectedLifecycleReceipt);
            Require(current.Digest == displayedDigest, "approval_display_digest_mismatch");
            await ConsumeProofAsync(current, stepUpProof, token);
            return current with
            {
                Status = AuthoringApprovalStatus.Approved
            };
        }, cancellationToken, AuthoringApprovalStatus.Approved,
            (_, token) => ObserveDeletionAsync(package, measurement, expectedLifecycleReceipt, token),
            (_, token) => ValidateReceiptAsync(package, expectedLifecycleReceipt, token)));

    public async ValueTask<ApprovedClaim> ClaimMigrationAsync(
        string decisionId, VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration frozenPlan, ImmutableArray<AuthoringExecutionTarget> orderedOldTargets,
        ImmutableArray<AuthoringExecutionTarget> orderedNewTargets, AuthoringLifecycleReceipt expectedLifecycleReceipt,
        CancellationToken cancellationToken = default)
    {
        AuthoringFencedStateMigration frozen = FreezePlan(oldPackage, newPackage, frozenPlan);
        ImmutableArray<AuthoringExecutionTarget> oldTargets = AuthoringExtensionApprovalContract.FreezeTargets(oldPackage, orderedOldTargets);
        ImmutableArray<AuthoringExecutionTarget> newTargets = AuthoringExtensionApprovalContract.FreezeTargets(newPackage, orderedNewTargets);
        (long records, long bytes) = (0L, 0L);
        AuthoringApprovalDecision decision = await ChangeAsync(decisionId, (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Approved, "approval_not_approved_or_replayed");
            Match(current, AuthoringApprovalOperation.Migration,
                MigrationDigest(oldPackage, newPackage, frozen, oldTargets, newTargets, expectedLifecycleReceipt, records, bytes, current.ScopeAuthorizationSha256), expectedLifecycleReceipt);
            return ValueTask.FromResult(current with
            {
                Status = AuthoringApprovalStatus.Claimed
            });
        }, cancellationToken, AuthoringApprovalStatus.Claimed,
            async (_, token) =>
            {
                IAuthoringExtensionStateObservation observation = await ObserveMigrationAsync(oldPackage, newPackage, frozen, token);
                try
                {
                    await observation.VerifyCurrentAsync(token);
                    token.ThrowIfCancellationRequested();
                    (records, bytes) = MigrationCounts(observation);
                    return observation;
                }
                catch
                {
                    await observation.DisposeAsync();
                    throw;
                }
            },
            (_, token) => ValidateReceiptAsync(oldPackage, expectedLifecycleReceipt, token));
        return new(s_issuer, decision, oldPackage, newPackage);
    }

    public async ValueTask<ApprovedClaim> ClaimDeletionAsync(
        string decisionId, VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expectedLifecycleReceipt, CancellationToken cancellationToken = default)
    {
        AuthoringApprovalDecision decision = await ChangeAsync(decisionId, (current, token) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Approved, "approval_not_approved_or_replayed");
            Match(current, AuthoringApprovalOperation.Deletion, DeletionDigest(package, measurement, expectedLifecycleReceipt, current.ScopeAuthorizationSha256), expectedLifecycleReceipt);
            return ValueTask.FromResult(current with
            {
                Status = AuthoringApprovalStatus.Claimed
            });
        }, cancellationToken, AuthoringApprovalStatus.Claimed,
            (_, token) => ObserveDeletionAsync(package, measurement, expectedLifecycleReceipt, token),
            (_, token) => ValidateReceiptAsync(package, expectedLifecycleReceipt, token));
        return new(s_issuer, decision, package, package);
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> DenyAsync(string decisionId, CancellationToken cancellationToken = default) =>
        Preview(await ChangeAsync(decisionId, (current, _) =>
        {
            Require(current.Status == AuthoringApprovalStatus.Pending, "approval_not_pending");
            return ValueTask.FromResult(current with
            {
                Status = AuthoringApprovalStatus.Denied
            });
        }, cancellationToken, AuthoringApprovalStatus.Denied));

    public async ValueTask<AuthoringExtensionApprovalPreview> RevokeAsync(string decisionId, CancellationToken cancellationToken = default) =>
        Preview(await ChangeAsync(decisionId, (current, _) =>
        {
            Require(current.Status is AuthoringApprovalStatus.Pending or AuthoringApprovalStatus.Approved, "approval_not_revocable");
            return ValueTask.FromResult(current with
            {
                Status = AuthoringApprovalStatus.Revoked
            });
        }, cancellationToken, AuthoringApprovalStatus.Revoked));

    /// <summary>After restart, mark a stranded durable claim for recovery without granting a second claim.</summary>
    public async ValueTask<AuthoringExtensionApprovalPreview> MarkInterruptedAsync(string decisionId, CancellationToken cancellationToken = default)
    {
        AuthoringApprovalDecision result = await AccessDecisionAsync(decisionId,
            (current, _) =>
            {
                Require(current.Status == AuthoringApprovalStatus.Claimed, "approval_not_interrupted_claim");
                return ValueTask.FromResult(current with
                {
                    Status = AuthoringApprovalStatus.RecoveryRequired
                });
            }, cancellationToken, fenceLifecycle: false);
        return Preview(result);
    }

    public async ValueTask<AuthoringExtensionApprovalPreview> ReadAsync(string decisionId, CancellationToken cancellationToken = default)
    {
        return Preview(await AccessDecisionAsync(decisionId,
            (current, _) => ValueTask.FromResult(current), cancellationToken, fenceLifecycle: false));
    }

    public ValueTask SettleFailureAsync(ApprovedClaim claim, AuthoringApprovalStatus terminal, CancellationToken cancellationToken = default)
    {
        Require(terminal is AuthoringApprovalStatus.Failed or AuthoringApprovalStatus.RecoveryRequired, "approval_failure_terminal_required");
        return SettleFailureCoreAsync(claim, terminal, cancellationToken);
    }

    private async ValueTask SettleFailureCoreAsync(ApprovedClaim claim, AuthoringApprovalStatus terminal, CancellationToken token)
    {
        await using var transaction = await store.BeginFailureAsync(claim, token);
        await store.SettleAsync(transaction, claim, terminal, null, null, null, token);
    }

    public async ValueTask CompleteAsync(ApprovedClaim claim,
        AuthoringExtensionApprovalExecutionResult executionResult, AuthoringLifecycleReceipt result,
        CancellationToken cancellationToken = default)
    {
        var actor = CurrentActor();
        Require(actor.Id == claim.Actor.PrincipalId && actor.SessionId == claim.Actor.SessionId && actor.SiteId == claim.Actor.SiteId,
            "approval_completion_actor_mismatch");
        await using var transaction = await store.BeginAsync(actor.Id, actor.SessionId, actor.SiteId, cancellationToken);
        Require(await receipts.GetLatestAsync(result.ExtensionId, cancellationToken) == result, "approval_result_not_durable");
        AuthoringExtensionApprovalExecutionResult frozen = AuthoringExtensionApprovalContract.FreezeResult(claim, executionResult);
        Require(result.SchemaVersion == 1 && result.PackageSha256 == claim.ResultPackageSha256 &&
            result.Version == claim.ResultVersion && result.StateSchemaVersion == claim.ResultStateSchemaVersion &&
            result.DataSchemaVersion == claim.ResultDataSchemaVersion, "approval_result_package_metadata_mismatch");
        Require((claim.Operation == AuthoringApprovalOperation.Migration
                ? result.State == AuthoringLifecycleState.Running : result.State == AuthoringLifecycleState.Removed) &&
            result.FailureCode is null && result.ExtensionId == claim.Scope.ExtensionId &&
            result.ScopeDigest == frozen.ContentSha256 && result.Generation == frozen.LifecycleGeneration &&
            result.Sequence == result.Generation && result.Generation > claim.ExpectedLifecycleReceipt.Generation &&
            result.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(result),
            "approval_result_execution_binding_mismatch");
        // Neither an independent state reread nor a Running receipt closes the TOCTOU window.
        // The canonical owner must hold original state exclusion (and native generation custody
        // for migration) through the final SQL CAS. Original Read/Measure APIs own separate
        // transactions; they cannot manufacture that lifetime. No permissive adapter is supplied.
        Require(executionResults is not null, "approval_execution_result_authority_unavailable");
        await using IAuthoringExtensionApprovalExecutionResultScope held =
            await executionResults!.AcquireAsync(transaction.Connection, transaction.Transaction, claim, result.Generation, cancellationToken);
        await held.VerifyCurrentAsync(cancellationToken);
        await using IAuthoringExtensionApprovalScope access = await AcquireScopeAsync(claim.Operation, claim.Scope,
            claim.FrozenPlan?.To, held.StateCustody, cancellationToken);
        Require(access.AuthorizationSha256 == claim.ScopeAuthorizationSha256, "approval_scope_authority_drift");
        await held.VerifyCurrentAsync(cancellationToken);
        await held.StateCustody.VerifyCurrentAsync(cancellationToken);
        AuthoringStateObservation canonical = held.StateCustody.State;
        AuthoringExtensionApprovalExecutionResult observed = AuthoringExtensionApprovalContract.FreezeResult(claim, held.Result);
        Require(Digest(observed) == Digest(frozen), "approval_execution_observation_mismatch");
        if (claim.Operation == AuthoringApprovalOperation.Migration)
        {
            Require(canonical.Phase == AuthoringStateMigrationPhase.Completed &&
                Digest(canonical.From.Snapshot) == Digest(held.SettledSourceSnapshot) &&
                Digest(canonical.To?.Snapshot) == Digest(held.SettledDestinationSnapshot), "approval_result_state_custody_mismatch");
            AuthoringExtensionApprovalContract.ValidateSettledMigration(claim, frozen.AppliedSnapshot!, canonical.From.Snapshot,
                canonical.To?.Snapshot, cancellationToken);
        }
        else
        {
            Require(canonical.To is null && canonical.Phase is null && canonical.From.Measurement == held.DeletedMeasurement &&
                held.DeletedMeasurement == frozen.DeletionResult, "approval_deletion_result_drift");
        }
        await held.VerifyCurrentAsync(cancellationToken);
        await store.SettleAsync(transaction, claim, AuthoringApprovalStatus.Completed, result, frozen.ContentSha256,
            async token =>
            {
                await access.VerifyCurrentAsync(token);
                await held.VerifyCurrentAsync(token);
                await held.StateCustody.VerifyCurrentAsync(token);
            }, cancellationToken);
    }

    private async ValueTask<IAuthoringExtensionApprovalScope> AcquireScopeAsync(AuthoringApprovalOperation operation,
        AuthoringStateScope scope, AuthoringStateScope? destination, IAuthoringExtensionStateObservation stateCustody,
        CancellationToken token)
    {
        Require(scopeAuthority is not null, "approval_exact_scope_authority_unavailable");
        await stateCustody.VerifyCurrentAsync(token);
        string[] exact = (destination is null ? new[] { scope } : new[] { scope, destination })
            .Select(ScopeId).Distinct(StringComparer.Ordinal).Order(StringComparer.Ordinal).ToArray();
        Require(stateCustody.AcquiredScopeIds.SequenceEqual(exact), "approval_state_custody_scope_mismatch");
        IAuthoringExtensionApprovalScope held = await scopeAuthority!.AcquireWithStateCustodyAsync(
            contexts.HttpContext!, operation, scope, destination, stateCustody, token);
        try
        {
            Require(IsDigest(held.AuthorizationSha256), "approval_scope_authorization_invalid");
            await held.VerifyCurrentAsync(token);
            return held;
        }
        catch
        {
            await held.DisposeAsync();
            throw;
        }
    }

    private async ValueTask<AuthoringApprovalDecision> AccessDecisionAsync(string id,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask<AuthoringApprovalDecision>> change,
        CancellationToken token, bool fenceLifecycle = true,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask<IAuthoringExtensionStateObservation>>? observeState = null,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask>? beforeCustody = null)
    {
        var actor = CurrentActor();
        await using var transaction = await store.BeginAsync(actor.Id, actor.SessionId, actor.SiteId, token);
        AuthoringApprovalDecision observed = await store.ObserveAsync(transaction, id, token);
        Require(observed.Actor == transaction.Actor, "approval_actor_site_or_permission_drift");
        if (beforeCustody is not null)
        {
            await beforeCustody(observed, token);
        }
        if (observeState is null)
        {
            // Audit/history, denial, revocation and recovery marking grant no execution. They
            // use only pinned actor + protected decision and never take provenance before state.
            return await store.ChangeAsync(transaction, observed, change, _ => ValueTask.CompletedTask, token, fenceLifecycle);
        }
        await using IAuthoringExtensionStateObservation observedState = await observeState(observed, token);
        await observedState.VerifyCurrentAsync(token);
        await using IAuthoringExtensionApprovalScope access = await AcquireScopeAsync(
            observed.Operation, observed.Scope, observed.FrozenPlan?.To, observedState, token);
        Require(access.AuthorizationSha256 == observed.ScopeAuthorizationSha256, "approval_scope_authority_drift");
        return await store.ChangeAsync(transaction, observed, change,
            async cancellation =>
            {
                await access.VerifyCurrentAsync(cancellation);
                await observedState.VerifyCurrentAsync(cancellation);
            }, token, fenceLifecycle);
    }

    private async ValueTask<AuthoringApprovalDecision> ChangeAsync(string id,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask<AuthoringApprovalDecision>> change,
        CancellationToken token, AuthoringApprovalStatus expected,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask<IAuthoringExtensionStateObservation>>? observeState = null,
        Func<AuthoringApprovalDecision, CancellationToken, ValueTask>? beforeCustody = null)
    {
        AuthoringApprovalDecision result = await AccessDecisionAsync(id, change, token, observeState: observeState, beforeCustody: beforeCustody);
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

    private async ValueTask<IAuthoringExtensionStateObservation> ObserveMigrationAsync(
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringFencedStateMigration plan,
        CancellationToken token)
    {
        Require(oldPackage.Trust.ValidUntil > DateTimeOffset.UtcNow && newPackage.Trust.ValidUntil > DateTimeOffset.UtcNow,
            "approval_package_trust_expired");
        Require(state is IAuthoringExtensionStateObservationStore, "approval_state_observation_authority_unavailable");
        return await ((IAuthoringExtensionStateObservationStore)state).ObserveInitialAsync(oldPackage, newPackage, plan, token);
    }

    private static (long Records, long Bytes) MigrationCounts(IAuthoringExtensionStateObservation observation)
    {
        AuthoringStateSnapshot source = observation.State.From.Snapshot;
        AuthoringStateSnapshot target = observation.State.To!.Snapshot;
        return (source.Entries.Length + target.Entries.Length, ValueBytes(source) + ValueBytes(target));
    }

    private async ValueTask<IAuthoringExtensionStateObservation> ObserveDeletionAsync(VerifiedAuthoringPackage package,
        AuthoringStateMeasurement measurement, AuthoringLifecycleReceipt expected, CancellationToken token)
    {
        Require(expected.State == AuthoringLifecycleState.RetainedData, "approval_deletion_requires_retained_data");
        ValidateOwner(package, measurement.Scope);
        Require(state is IAuthoringExtensionStateObservationStore, "approval_state_observation_authority_unavailable");
        return await ((IAuthoringExtensionStateObservationStore)state).ObserveDeletionAsync(package, measurement, token);
    }

    private async ValueTask ValidateReceiptAsync(VerifiedAuthoringPackage package, AuthoringLifecycleReceipt expected, CancellationToken token)
    {
        Require(package.Trust.Status == AuthoringPackageTrustStatus.Trusted && package.Trust.ValidUntil > DateTimeOffset.UtcNow &&
            expected.ExtensionId == package.Contract.Manifest.Id && expected.PackageSha256 == package.Contract.Manifest.PackageSha256 &&
            expected.Version == package.Contract.Manifest.Version && expected.StateSchemaVersion == package.Contract.Manifest.StateSchemaVersion &&
            expected.DataSchemaVersion == package.Contract.Manifest.DataSchemaVersion &&
            expected.ReceiptSha256 == AuthoringExtensionLifecycleCoordinator.ComputeReceiptSha256(expected) &&
            await receipts.GetLatestAsync(expected.ExtensionId, token) == expected, "approval_lifecycle_identity_or_generation_mismatch");
    }

    private static void Match(AuthoringApprovalDecision decision, AuthoringApprovalOperation operation, string digest, AuthoringLifecycleReceipt expected) =>
        Require(decision.Operation == operation && decision.Digest == digest && decision.ExpectedLifecycleReceipt == expected,
            "approval_exact_operation_plan_or_receipt_mismatch");

    private static string MigrationDigest(VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage,
        AuthoringFencedStateMigration plan, ImmutableArray<AuthoringExecutionTarget> oldTargets,
        ImmutableArray<AuthoringExecutionTarget> newTargets, AuthoringLifecycleReceipt expected,
        long records, long bytes, string scopeAuthorization) => Digest(new
        {
            Kind = "authoring-migration-approval-v2",
            OldPackage = oldPackage.PackageIdentity,
            NewPackage = newPackage.PackageIdentity,
            OldPayloadSha256 = oldPackage.Contract.Manifest.PackageSha256,
            NewPayloadSha256 = newPackage.Contract.Manifest.PackageSha256,
            OldContentSha256 = oldPackage.Contract.Manifest.ContentSha256,
            NewContentSha256 = newPackage.Contract.Manifest.ContentSha256,
            Plan = plan,
            OrderedOldTargets = oldTargets,
            OrderedNewTargets = newTargets,
            Receipt = expected,
            Records = records,
            Bytes = bytes,
            Retention = RetainBackups,
            ScopeAuthorization = scopeAuthorization
        });

    private static string DeletionDigest(VerifiedAuthoringPackage package, AuthoringStateMeasurement measurement,
        AuthoringLifecycleReceipt expected, string scopeAuthorization) => Digest(new
        {
            Kind = "authoring-deletion-approval-v2",
            Package = package.PackageIdentity,
            PayloadSha256 = package.Contract.Manifest.PackageSha256,
            ContentSha256 = package.Contract.Manifest.ContentSha256,
            Measurement = measurement,
            Receipt = expected,
            Retention = PurgeBackups,
            ScopeAuthorization = scopeAuthorization
        });

    private static AuthoringApprovalDecision Decision(AuthoringApprovalActor actor, AuthoringApprovalOperation operation,
        VerifiedAuthoringPackage oldPackage, VerifiedAuthoringPackage newPackage, AuthoringStateScope scope,
        AuthoringFencedStateMigration? plan, AuthoringStateMeasurement? measurement, long records, long bytes,
        string retention, string digest, AuthoringLifecycleReceipt receipt,
        ImmutableArray<AuthoringExecutionTarget> oldTargets, ImmutableArray<AuthoringExecutionTarget> newTargets,
        string scopeAuthorization) =>
        new(2, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(32)), operation, AuthoringApprovalStatus.Pending,
            0, actor, oldPackage.PackageIdentity, newPackage.PackageIdentity, scope, plan, measurement,
            records, bytes, retention, digest, receipt, DateTimeOffset.UtcNow.AddMinutes(5), null,
            oldTargets, newTargets, oldPackage.Contract.Manifest.PackageSha256, newPackage.Contract.Manifest.PackageSha256,
            null, scopeAuthorization, oldPackage.Contract.Manifest.Version, newPackage.Contract.Manifest.Version,
            oldPackage.Contract.Manifest.StateSchemaVersion, newPackage.Contract.Manifest.StateSchemaVersion,
            oldPackage.Contract.Manifest.DataSchemaVersion, newPackage.Contract.Manifest.DataSchemaVersion);

    private static AuthoringExtensionApprovalPreview Preview(AuthoringApprovalDecision decision) =>
        new(2, decision.OperationContext, decision.DecisionId, decision.Operation, decision.Status, decision.Scope, decision.FrozenPlan?.To,
            decision.Records, decision.Bytes, decision.Retention, decision.Digest, decision.FrozenPlan,
            decision.Measurement, decision.ExpectedLifecycleReceipt, decision.ExpiresAt, decision.OrderedOldTargets, decision.OrderedNewTargets);
}
