using System.Collections.ObjectModel;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Control;

namespace FsusBlog.Server.Infrastructure.Memory.Capabilities;

/// <summary>
/// Input-bound control-plane lifecycle over the one immutable policy roster. It has
/// no DI/startup registration, timer, configuration reader, driver factory or readiness route.
/// </summary>
public sealed class MemoryCapabilityController
{
    private readonly object _gate = new();
    private readonly MemoryReservationCoordinator _ledger;
    private readonly TimeProvider _clock;
    private readonly string _candidateCommit;
    private readonly Dictionary<string, CapabilityRuntime> _runtime = new(StringComparer.Ordinal);
    private MemoryCapabilityPolicyPlan _plan;
    private int _running;

    public MemoryCapabilityController(MemoryCapabilityPolicyPlan plan, MemoryReservationCoordinator ledger,
        IEnumerable<MemoryCapabilityBackendBinding> bindings, TimeProvider clock, string candidateCommit)
    {
        ArgumentNullException.ThrowIfNull(plan);
        ArgumentNullException.ThrowIfNull(ledger);
        ArgumentNullException.ThrowIfNull(bindings);
        ArgumentNullException.ThrowIfNull(clock);
        if (!MemoryGovernorPolicy.ValidDigest(candidateCommit, 40) || clock.TimestampFrequency <= 0)
        {
            throw new ArgumentException("Controller requires exact candidate and clock provenance.");
        }
        _plan = plan;
        _ledger = ledger;
        _clock = clock;
        _candidateCommit = candidateCommit;
        foreach (MemoryCapabilityBackendBinding binding in bindings.Take(plan.DependencyOrder.Count + 1))
        {
            if (_runtime.Count == plan.DependencyOrder.Count || !ValidPath(binding.EffectivePath))
            {
                throw new ArgumentException("Invalid or oversized backend binding roster.", nameof(bindings));
            }
            _ = plan.Requested(binding.CapabilityId);
            ArgumentNullException.ThrowIfNull(binding.Probe);
            ArgumentNullException.ThrowIfNull(binding.ProbeCharges);
            MemoryResourceCharge[] charges = binding.ProbeCharges.Take(ledger.Topology.DomainCount + 1).ToArray();
            if (charges.Length == 0 || charges.Length > ledger.Topology.DomainCount || charges.Any(charge => charge.Amount <= 0
                || ledger.Topology.Unit(charge.Domain) != charge.Unit))
            {
                throw new ArgumentException("Probe vectors must match the finite common resource topology.", nameof(bindings));
            }
            _runtime.Add(binding.CapabilityId, new(binding with
            {
                ProbeCharges = Array.AsReadOnly(charges)
            },
                Status(binding.CapabilityId, plan.Requested(binding.CapabilityId) == MemoryCapabilityMode.Disabled
                    ? MemoryOnlineState.Disabled : MemoryOnlineState.Offline,
                    plan.Requested(binding.CapabilityId) == MemoryCapabilityMode.Disabled ? MemoryCapabilityControlReason.Disabled : MemoryCapabilityControlReason.Unknown)));
        }
        if (_runtime.Count != plan.DependencyOrder.Count)
        {
            throw new ArgumentException("Every registered capability needs exactly one binding.", nameof(bindings));
        }
    }

    public IReadOnlyDictionary<string, MemoryCapabilityStatus> Snapshot()
    {
        lock (_gate)
        {
            RefreshDrained();
            return new ReadOnlyDictionary<string, MemoryCapabilityStatus>(_runtime.ToDictionary(
                item => item.Key, item => VisibleStatus(item.Value), StringComparer.Ordinal));
        }
    }

    public void ApplyPolicy(MemoryCapabilityPolicyPlan next)
    {
        ArgumentNullException.ThrowIfNull(next);
        var cancellations = new List<CancellationTokenSource>();
        var retire = new List<(string Id, MemoryCapabilityOwner Owner)>();
        lock (_gate)
        {
            if (next.Revision <= _plan.Revision || next.DependencyOrder.Count != _runtime.Count
                || next.DependencyOrder.Any(item => !_runtime.ContainsKey(item.Id))
                || _runtime.Values.Any(item => item.Generation == ulong.MaxValue))
            {
                throw new ArgumentException("A policy revision must advance atomically over the same bounded roster.", nameof(next));
            }
            _plan = next;
            foreach ((string id, CapabilityRuntime cell) in _runtime)
            {
                cell.Generation++;
                cell.Attempts = 0;
                cell.RetryAt = null;
                if (cell.ProbeCancellation is not null)
                {
                    cancellations.Add(cell.ProbeCancellation);
                }
                cell.Status = Status(id, cell.Owner is not null || cell.ProbeTask is not null || cell.Operations != 0
                    ? MemoryOnlineState.Draining
                    : next.Requested(id) == MemoryCapabilityMode.Disabled ? MemoryOnlineState.Disabled : MemoryOnlineState.Offline,
                    next.Requested(id) == MemoryCapabilityMode.Disabled ? MemoryCapabilityControlReason.Disabled : MemoryCapabilityControlReason.Draining);
                if (cell.Owner is not null && cell.Operations == 0)
                {
                    retire.Add((id, cell.Owner));
                }
            }
        }
        foreach (CancellationTokenSource cancellation in cancellations)
        {
            try
            {
                cancellation.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            catch (AggregateException)
            {
            }
        }
        foreach ((string id, MemoryCapabilityOwner owner) in retire)
        {
            Retire(id, owner);
        }
    }

    public async Task<MemoryCapabilityControlResult> ProbeAsync(string id, MemoryCapabilityRuntimeIdentity identity,
        MemoryCapabilityReleaseBinding? release, MemoryCapabilityControlPolicy? policy,
        MemoryGovernorDecision? governor, CancellationToken callerCancellation = default)
    {
        callerCancellation.ThrowIfCancellationRequested();
        if (!ObserveIdentity(id, identity))
        {
            lock (_gate)
            {
                return Result(_runtime[id], MemoryCapabilityControlReason.InvalidIdentity);
            }
        }
        Task<MemoryCapabilityControlResult> task;
        TimeSpan timeout;
        lock (_gate)
        {
            CapabilityRuntime cell = _runtime[id];
            RefreshDrained();
            if (_plan.Requested(id) == MemoryCapabilityMode.Disabled)
            {
                return Result(cell, MemoryCapabilityControlReason.Disabled);
            }
            if (cell.ProbeTask is not null || cell.Owner is not null && cell.Status.OnlineState != MemoryOnlineState.Online)
            {
                return Result(cell, MemoryCapabilityControlReason.Draining);
            }
            DateTimeOffset now = _clock.GetUtcNow();
            if (!ValidPolicy(policy, now))
            {
                return Result(cell, MemoryCapabilityControlReason.UnmetBaseline);
            }
            if (governor is null || governor.CandidateCommit != _candidateCommit || governor.PolicyRevision != policy!.GovernorPolicyRevision || !governor.AllowGrowth
                || governor.State != MemoryGovernorState.Normal || governor.SampledAt > now
                || now - governor.SampledAt > policy.MaximumGovernorAge)
            {
                return Result(cell, MemoryCapabilityControlReason.UnmetGovernor);
            }
            if (identity is null || !MemoryGovernorPolicy.ValidDigest(identity.IdentityDigest, 64) || identity.Epoch.Value == 0)
            {
                return Result(cell, MemoryCapabilityControlReason.InvalidIdentity);
            }
            if (release is null || release.CandidateCommit != _candidateCommit || release.IdentityDigest != identity.IdentityDigest
                || release.Qualification != MemoryQualification.Qualified || release.ValidUntil <= now)
            {
                return Result(cell, MemoryCapabilityControlReason.ReleaseUnqualified);
            }
            if (cell.Status.OnlineState == MemoryOnlineState.Online)
            {
                return Result(cell, MemoryCapabilityControlReason.Ready);
            }
            if (_plan.DependencyOrder.Single(item => item.Id == id).Dependencies.Any(parent =>
                _runtime[parent].Status.OnlineState != MemoryOnlineState.Online))
            {
                return Result(cell, MemoryCapabilityControlReason.DependencyUnavailable);
            }
            if (cell.RetryAt > now)
            {
                return Result(cell, cell.Attempts >= policy.MaximumAttemptsPerWindow
                    ? MemoryCapabilityControlReason.CircuitOpen : MemoryCapabilityControlReason.RetryDeferred);
            }
            if (cell.Attempts >= policy.MaximumAttemptsPerWindow)
            {
                cell.Attempts = 0;
            }
            if (_running >= policy.MaximumConcurrentProbes)
            {
                return Result(cell, MemoryCapabilityControlReason.BudgetRejected);
            }
            MemoryFailure? governed = _ledger.ApplyGovernedBounds(governor.Sequence, governor.AccountingRevision, governor.Targets);
            if (governed is not null)
            {
                return Result(cell, MemoryCapabilityControlReason.UnmetGovernor);
            }
            MemoryOperationResult<MemoryReservation> admitted = _ledger.TryReserveUnderBounds(cell.Binding.ProbeCharges, governor.Targets, governor.AccountingRevision);
            if (!admitted.Succeeded)
            {
                cell.Status = cell.Status with
                {
                    LastAdmission = MemoryAdmission.BudgetRejected
                };
                return Result(cell, MemoryCapabilityControlReason.BudgetRejected);
            }
            CancellationTokenSource cancellation;
            try
            {
                cancellation = new CancellationTokenSource(policy.MaximumProbeDuration, _clock);
            }
            catch (Exception)
            {
                admitted.Value!.Dispose();
                return Result(cell, MemoryCapabilityControlReason.ProbeFault);
            }
            timeout = policy.MaximumProbeDuration;
            cell.Identity = identity;
            cell.Attempts++;
            _running++;
            cell.ProbeCancellation = cancellation;
            cell.GovernorPolicyRevision = policy.GovernorPolicyRevision;
            cell.MaximumGovernorAge = policy.MaximumGovernorAge;
            cell.Status = Status(id, MemoryOnlineState.Qualifying, MemoryCapabilityControlReason.Unknown) with
            {
                ReleaseQualification = MemoryQualification.Qualified
            };
            var context = new MemoryCapabilityProbeContext(id, _plan.Revision, cell.Generation, identity);
            // A non-inline control-plane continuation prevents adapter code under the gate.
            task = Task.Run(() => RunProbeAsync(cell, context, admitted.Value!, policy, release.ValidUntil, cancellation));
            cell.ProbeTask = task;
        }
        // Outer cancellation only abandons this waiter; actual probe resources remain owned.
        try
        {
            return await task.WaitAsync(timeout, _clock, callerCancellation).ConfigureAwait(false);
        }
        catch (TimeoutException)
        {
            CancellationTokenSource? cancellation;
            MemoryCapabilityOwner? retire;
            MemoryCapabilityControlResult result;
            lock (_gate)
            {
                CapabilityRuntime cell = _runtime[id];
                if (cell.Generation != ulong.MaxValue)
                {
                    cell.Generation++;
                }
                cell.Status = cell.Status with
                {
                    OnlineState = MemoryOnlineState.Draining,
                    EffectivePath = null,
                    RuntimeQualification = MemoryQualification.NotVerified,
                    Reason = MemoryCapabilityControlReason.ProbeTimedOut.ToString()
                };
                cancellation = cell.ProbeCancellation;
                retire = cell.Operations == 0 ? cell.Owner : null;
                result = Result(cell, MemoryCapabilityControlReason.ProbeTimedOut, true);
            }
            try
            {
                cancellation?.Cancel();
            }
            catch (ObjectDisposedException)
            {
            }
            catch (AggregateException)
            {
            }
            if (retire is not null)
            {
                Retire(id, retire);
            }
            return result;
        }
    }

    public async Task<IReadOnlyList<MemoryCapabilityControlResult>> TickAsync(
        MemoryCapabilityControlPolicy? policy, MemoryGovernorDecision? governor,
        IReadOnlyDictionary<string, MemoryCapabilityRuntimeIdentity> identities,
        IReadOnlyDictionary<string, MemoryCapabilityReleaseBinding> releases,
        CancellationToken callerCancellation = default)
    {
        ArgumentNullException.ThrowIfNull(identities);
        ArgumentNullException.ThrowIfNull(releases);
        MemoryCapabilityRegistration[] roster;
        lock (_gate)
        {
            roster = _plan.DependencyOrder.ToArray();
        }
        var results = new List<MemoryCapabilityControlResult>(roster.Length);
        foreach (MemoryCapabilityRegistration registration in roster)
        {
            callerCancellation.ThrowIfCancellationRequested();
            if (!identities.TryGetValue(registration.Id, out MemoryCapabilityRuntimeIdentity? identity))
            {
                lock (_gate)
                {
                    results.Add(Result(_runtime[registration.Id], MemoryCapabilityControlReason.InvalidIdentity));
                }
                continue;
            }
            releases.TryGetValue(registration.Id, out MemoryCapabilityReleaseBinding? release);
            results.Add(await ProbeAsync(registration.Id, identity, release, policy, governor, callerCancellation).ConfigureAwait(false));
        }
        return results.AsReadOnly();
    }

    public Task AwaitPendingProbeAsync(string id, CancellationToken callerCancellation = default)
    {
        lock (_gate)
        {
            Task pending = _runtime[id].ProbeTask ?? Task.CompletedTask;
            return pending.WaitAsync(callerCancellation);
        }
    }

    public MemoryCapabilitySelection? Select(string exclusiveGroup,
        IReadOnlyDictionary<string, MemoryCapabilityWorkloadAdmission> admissions)
    {
        lock (_gate)
        {
            RefreshDrained();
            string? id = _plan.SelectQualifiedBackend(exclusiveGroup,
                _runtime.ToDictionary(item => item.Key, item => VisibleStatus(item.Value), StringComparer.Ordinal), admissions);
            return id is null ? null : new(id, _plan.Revision, _runtime[id].Generation);
        }
    }

    public MemoryOperationResult<MemoryCapabilityOperationLease> TryReserveOperation(MemoryCapabilitySelection selection,
        MemoryCapabilityWorkloadAdmission admission, MemoryGovernorDecision? governor, IEnumerable<MemoryResourceCharge> charges)
    {
        lock (_gate)
        {
            if (!_runtime.TryGetValue(selection.CapabilityId, out CapabilityRuntime? cell)
                || selection.PolicyRevision != _plan.Revision || selection.Generation != cell.Generation
                || VisibleStatus(cell).OnlineState != MemoryOnlineState.Online || _plan.Requested(selection.CapabilityId) == MemoryCapabilityMode.Disabled
                || governor is null || governor.CandidateCommit != _candidateCommit || governor.PolicyRevision != cell.GovernorPolicyRevision
                || !governor.AllowGrowth || governor.SampledAt > _clock.GetUtcNow()
                || _clock.GetUtcNow() - governor.SampledAt > cell.MaximumGovernorAge
                || _plan.DependencyOrder.Single(item => item.Id == selection.CapabilityId).Dependencies.Any(parent =>
                    VisibleStatus(_runtime[parent]).OnlineState != MemoryOnlineState.Online)
                || admission.PolicyRevision != _plan.Revision || admission.Qualification != MemoryQualification.Qualified
                || admission.Admission != MemoryAdmission.Admitted || cell.Operations == int.MaxValue)
            {
                return MemoryOperationResult<MemoryCapabilityOperationLease>.Reject(MemoryFailure.TierUnavailable);
            }
            MemoryFailure? governed = _ledger.ApplyGovernedBounds(governor.Sequence, governor.AccountingRevision, governor.Targets);
            if (governed is not null)
            {
                return MemoryOperationResult<MemoryCapabilityOperationLease>.Reject(governed.Value);
            }
            MemoryOperationResult<MemoryReservation> reserved = _ledger.TryReserveUnderBounds(charges, governor.Targets, governor.AccountingRevision);
            cell.Status = cell.Status with
            {
                LastAdmission = reserved.Succeeded ? MemoryAdmission.Admitted
                : reserved.Failure == MemoryFailure.BudgetRejected ? MemoryAdmission.BudgetRejected : MemoryAdmission.Unavailable
            };
            if (!reserved.Succeeded)
            {
                return MemoryOperationResult<MemoryCapabilityOperationLease>.Reject(reserved.Failure!.Value);
            }
            cell.Operations++;
            return MemoryOperationResult<MemoryCapabilityOperationLease>.Success(new(this, selection.CapabilityId, reserved.Value!));
        }
    }

    internal void CompleteOperation(string id, MemoryReservation reservation)
    {
        reservation.Dispose();
        MemoryCapabilityOwner? retire = null;
        lock (_gate)
        {
            CapabilityRuntime cell = _runtime[id];
            cell.Operations--;
            if (cell.Operations == 0 && cell.Status.OnlineState == MemoryOnlineState.Draining)
            {
                retire = cell.Owner;
            }
        }
        if (retire is not null)
        {
            Retire(id, retire);
        }
    }

    private async Task<MemoryCapabilityControlResult> RunProbeAsync(CapabilityRuntime cell,
        MemoryCapabilityProbeContext context, MemoryReservation reservation,
        MemoryCapabilityControlPolicy policy, DateTimeOffset releaseValidUntil, CancellationTokenSource cancellation)
    {
        MemoryCapabilityProbeOutcome outcome;
        try
        {
            outcome = await cell.Binding.Probe(context, cancellation.Token).ConfigureAwait(false);
        }
        catch (OperationCanceledException)
        {
            outcome = new(MemoryDetection.Unknown, MemoryQualification.NotVerified, MemoryCapabilityControlReason.ProbeCancelled, null);
        }
        catch (Exception)
        {
            outcome = new(MemoryDetection.Faulted, MemoryQualification.NotVerified, MemoryCapabilityControlReason.ProbeFault, null);
        }
        outcome ??= new(MemoryDetection.Faulted, MemoryQualification.NotVerified, MemoryCapabilityControlReason.ProbeFault, null);
        MemoryCapabilityOwner? retire;
        MemoryCapabilityControlResult result;
        try
        {
            lock (_gate)
            {
                _running--;
                cell.ProbeTask = null;
                cell.ProbeCancellation = null;
                bool current = context.PolicyRevision == _plan.Revision && context.Generation == cell.Generation
                    && context.Identity == cell.Identity && _plan.Requested(context.CapabilityId) != MemoryCapabilityMode.Disabled;
                bool validOutcome = Enum.IsDefined(outcome.Detection) && Enum.IsDefined(outcome.RuntimeQualification)
                    && Enum.IsDefined(outcome.Reason);
                bool qualified = validOutcome && current && !cancellation.IsCancellationRequested && _clock.GetUtcNow() < releaseValidUntil
                    && !_ledger.Snapshot().Faulted && outcome.Detection == MemoryDetection.Present && outcome.Reason == MemoryCapabilityControlReason.Ready
                    && outcome.RuntimeQualification == MemoryQualification.Qualified && outcome.Owner is not null;
                if (qualified)
                {
                    cell.Owner = outcome.Owner;
                    cell.ValidUntil = releaseValidUntil;
                    cell.Status = cell.Status with
                    {
                        Detection = outcome.Detection,
                        RuntimeQualification = outcome.RuntimeQualification,
                        OnlineState = MemoryOnlineState.Online,
                        EffectivePath = cell.Binding.EffectivePath,
                        Reason = MemoryCapabilityControlReason.Ready.ToString()
                    };
                    cell.Attempts = 0;
                    cell.RetryAt = null;
                    retire = null;
                    result = Result(cell, MemoryCapabilityControlReason.Ready, true);
                }
                else
                {
                    retire = outcome.Owner;
                    cell.Owner = outcome.Owner;
                    MemoryCapabilityControlReason reason = !current ? MemoryCapabilityControlReason.StaleCompletion
                        : cancellation.IsCancellationRequested ? MemoryCapabilityControlReason.ProbeCancelled
                        : !validOutcome || outcome.Reason == MemoryCapabilityControlReason.Ready ? MemoryCapabilityControlReason.RuntimeUnqualified : outcome.Reason;
                    cell.Status = Status(context.CapabilityId, retire is not null ? MemoryOnlineState.Draining
                        : _plan.Requested(context.CapabilityId) == MemoryCapabilityMode.Disabled ? MemoryOnlineState.Disabled
                    : outcome.Detection == MemoryDetection.Faulted ? MemoryOnlineState.Faulted : MemoryOnlineState.Offline,
                        reason) with
                    {
                        Detection = outcome.Detection,
                        ReleaseQualification = current && _clock.GetUtcNow() < releaseValidUntil ? MemoryQualification.Qualified : MemoryQualification.NotVerified,
                        RuntimeQualification = current && validOutcome && !cancellation.IsCancellationRequested && _clock.GetUtcNow() < releaseValidUntil
                            ? outcome.RuntimeQualification : MemoryQualification.NotVerified
                    };
                    cell.RetryAt = _clock.GetUtcNow() + (cell.Attempts >= policy.MaximumAttemptsPerWindow ? policy.CircuitCooldown : policy.RetryCooldown);
                    result = Result(cell, reason, true);
                }
            }
            if (retire is not null)
            {
                Retire(context.CapabilityId, retire);
            }
            return result;
        }
        finally
        {
            cancellation.Dispose();
            reservation.Dispose();
        }
    }

    private bool ObserveIdentity(string id, MemoryCapabilityRuntimeIdentity identity)
    {
        if (identity is null || !MemoryGovernorPolicy.ValidDigest(identity.IdentityDigest, 64) || identity.Epoch.Value == 0)
        {
            return false;
        }
        CancellationTokenSource? cancellation = null;
        MemoryCapabilityOwner? retire = null;
        lock (_gate)
        {
            CapabilityRuntime cell = _runtime[id];
            if (_plan.Requested(id) == MemoryCapabilityMode.Disabled)
            {
                return true;
            }
            bool expired = cell.Status.OnlineState == MemoryOnlineState.Online && cell.ValidUntil <= _clock.GetUtcNow();
            if (cell.Identity != identity || expired)
            {
                if (cell.Generation == ulong.MaxValue)
                {
                    return false;
                }
                cell.Generation++;
                cell.Identity = identity;
                cell.Attempts = 0;
                cell.RetryAt = null;
                cancellation = cell.ProbeCancellation;
                cell.Status = Status(id, cell.Owner is not null || cell.ProbeTask is not null || cell.Operations != 0
                    ? MemoryOnlineState.Draining : MemoryOnlineState.Offline, MemoryCapabilityControlReason.Draining);
                retire = cell.Operations == 0 ? cell.Owner : null;
            }
        }
        try
        {
            cancellation?.Cancel();
        }
        catch (ObjectDisposedException)
        {
        }
        catch (AggregateException)
        {
        }
        if (retire is not null)
        {
            Retire(id, retire);
        }
        return true;
    }

    private MemoryCapabilityStatus VisibleStatus(CapabilityRuntime cell)
        => cell.Status.OnlineState == MemoryOnlineState.Online && cell.ValidUntil <= _clock.GetUtcNow()
            ? cell.Status with
            {
                OnlineState = MemoryOnlineState.Offline,
                RuntimeQualification = MemoryQualification.NotVerified,
                EffectivePath = null,
                Reason = MemoryCapabilityControlReason.RuntimeUnqualified.ToString()
            }
            : cell.Status;

    private void Retire(string id, MemoryCapabilityOwner owner)
    {
        try
        {
            owner.BeginRetirement();
        }
        catch (Exception)
        {
            lock (_gate)
            {
                _runtime[id].Status = _runtime[id].Status with
                {
                    OnlineState = MemoryOnlineState.Faulted,
                    EffectivePath = null,
                    Reason = MemoryCapabilityControlReason.DrainFault.ToString()
                };
            }
        }
    }

    private void RefreshDrained()
    {
        foreach ((string id, CapabilityRuntime cell) in _runtime)
        {
            if (cell.Status.OnlineState == MemoryOnlineState.Draining && cell.Owner is not null
                && (cell.Owner.Drained.IsFaulted || cell.Owner.Drained.IsCanceled))
            {
                _ = cell.Owner.Drained.Exception;
                cell.Status = cell.Status with
                {
                    OnlineState = MemoryOnlineState.Faulted,
                    EffectivePath = null,
                    Reason = MemoryCapabilityControlReason.DrainFault.ToString()
                };
            }
            if (cell.Status.OnlineState == MemoryOnlineState.Draining && cell.ProbeTask is null && cell.Operations == 0
                && (cell.Owner is null || cell.Owner.Drained.IsCompletedSuccessfully))
            {
                cell.Owner = null;
                cell.Status = Status(id, _plan.Requested(id) == MemoryCapabilityMode.Disabled
                    ? MemoryOnlineState.Disabled : MemoryOnlineState.Offline,
                    _plan.Requested(id) == MemoryCapabilityMode.Disabled ? MemoryCapabilityControlReason.Disabled : MemoryCapabilityControlReason.Draining);
            }
        }
    }

    private bool ValidPolicy(MemoryCapabilityControlPolicy? policy, DateTimeOffset now)
        => policy is not null && policy.Baseline is not null && policy.Revision == _plan.Revision && policy.GovernorPolicyRevision > 0
            && policy.Baseline.Qualification == MemoryQualification.Qualified && policy.Baseline.CandidateCommit == _candidateCommit
            && policy.Baseline.FrozenAt <= now && MemoryGovernorPolicy.ValidDigest(policy.Baseline.EvidenceDigest, 64)
            && !string.IsNullOrWhiteSpace(policy.Baseline.EvidenceIdentity) && policy.Baseline.EvidenceIdentity.Length <= 128
            && policy.MaximumConcurrentProbes > 0 && policy.MaximumConcurrentProbes <= _runtime.Count
            && policy.MaximumAttemptsPerWindow > 0 && policy.MaximumProbeDuration > TimeSpan.Zero
            && policy.MaximumProbeDuration <= TimeSpan.FromMilliseconds(uint.MaxValue - 1)
            && policy.MaximumGovernorAge > TimeSpan.Zero && policy.RetryCooldown > TimeSpan.Zero && policy.CircuitCooldown >= policy.RetryCooldown
            && policy.MaximumProbeDuration <= DateTimeOffset.MaxValue - now && policy.CircuitCooldown <= DateTimeOffset.MaxValue - now;

    private MemoryCapabilityStatus Status(string id, MemoryOnlineState state, MemoryCapabilityControlReason reason)
        => new(id, _plan.Revision, _plan.Requested(id), MemoryDetection.Unknown, MemoryQualification.NotVerified,
            MemoryQualification.NotVerified, state, null, MemoryAdmission.NotEvaluated, reason.ToString());

    private static MemoryCapabilityControlResult Result(CapabilityRuntime cell, MemoryCapabilityControlReason reason, bool probeStarted = false)
        => new(cell.Status, reason, cell.Status.Requested != MemoryCapabilityMode.Required
            || cell.Status.OnlineState == MemoryOnlineState.Online, probeStarted);

    private static bool ValidPath(string path) => path.Length is > 0 and <= 128
        && path.All(character => char.IsAsciiLetterOrDigit(character) || character is '.' or '-' or '_');

    private sealed class CapabilityRuntime(MemoryCapabilityBackendBinding binding, MemoryCapabilityStatus status)
    {
        internal MemoryCapabilityBackendBinding Binding { get; } = binding;
        internal MemoryCapabilityStatus Status { get; set; } = status;
        internal ulong Generation { get; set; } = 1;
        internal MemoryCapabilityRuntimeIdentity? Identity
        {
            get; set;
        }
        internal MemoryCapabilityOwner? Owner
        {
            get; set;
        }
        internal ulong GovernorPolicyRevision
        {
            get; set;
        }
        internal TimeSpan MaximumGovernorAge
        {
            get; set;
        }
        internal DateTimeOffset? ValidUntil
        {
            get; set;
        }
        internal int Operations
        {
            get; set;
        }
        internal int Attempts
        {
            get; set;
        }
        internal DateTimeOffset? RetryAt
        {
            get; set;
        }
        internal Task<MemoryCapabilityControlResult>? ProbeTask
        {
            get; set;
        }
        internal CancellationTokenSource? ProbeCancellation
        {
            get; set;
        }
    }

}

public sealed class MemoryCapabilityOperationLease : IDisposable
{
    private readonly MemoryCapabilityController _controller;
    private readonly string _id;
    private MemoryReservation? _reservation;

    internal MemoryCapabilityOperationLease(MemoryCapabilityController controller, string id, MemoryReservation reservation)
    {
        _controller = controller;
        _id = id;
        _reservation = reservation;
    }

    public void Dispose()
    {
        MemoryReservation? reservation = Interlocked.Exchange(ref _reservation, null);
        if (reservation is not null)
        {
            _controller.CompleteOperation(_id, reservation);
        }
    }
}
