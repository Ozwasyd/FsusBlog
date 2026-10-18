using System.Collections.ObjectModel;

using FsusBlog.Server.Infrastructure.Memory.Accounting;
using FsusBlog.Server.Infrastructure.Memory.Capabilities;
using FsusBlog.Server.Infrastructure.Memory.Contracts;
using FsusBlog.Server.Infrastructure.Memory.Pressure;

namespace FsusBlog.Server.Infrastructure.Memory.Control;

public enum MemoryGovernorState
{
    UnmetPrerequisite, Normal, Pressure, Critical, Recovering, Infeasible, Faulted
}

public enum MemoryGovernorReason
{
    MissingPolicy, BaselineUnqualified, RevisionMismatch, InvalidInput, MissingPressure,
    StalePressure, DomainChanged, ClockDiscontinuity, LedgerFault, ControllerFault,
    ProtectedCommitments, LowHeadroom, SustainedServicePressure, RecoveryWindow, BoundedGrowth, Stable
}

public enum MemoryGovernorDegradation
{
    StopSpeculationAndRefills, RequestUnheldReconstructibleCopies, ReduceOptionalResidency,
    RequireBoundedSpillAdmission, ReduceExpensiveWork
}

public sealed record MemoryGovernorExternalConstraint(string CapacityIdentity, MemoryQualification Qualification,
    MemoryPressureObservation Usage, MemoryPressureObservation Limit);

// FEEDBACK: OS retention overlaps allocator relinquishment. It is not extra reclaimed
// capacity. Only the existing physical owner may report actual relinquishment.
public sealed record MemoryGovernorReclaimFeedback(ulong DecisionSequence, string CapacityIdentity,
    long Requested, long AllocatorRelinquished, long OsRetained, long Pending, long Blocked);

public sealed record MemoryGovernorServicePressure(ulong DomainRevision, MemoryQualification Qualification,
    DateTimeOffset SampledAt, bool SustainedSwapActivity, bool SustainedStalls, bool ServiceDegraded);

public sealed record MemoryGovernorInput(string CandidateCommit, ulong DomainRevision, DateTimeOffset Now,
    long Timestamp, long TimestampFrequency, MemoryAccountingSnapshot Accounting,
    IReadOnlyList<MemoryGovernorExternalConstraint> ExternalConstraints,
    IReadOnlyDictionary<string, long> ProtectedAndInFlight,
    IReadOnlyList<MemoryGovernorReclaimFeedback> Feedback,
    MemoryGovernorServicePressure? ServicePressure, bool ControllerFaulted);

public sealed record MemoryGovernorDecision(ulong Sequence, string CandidateCommit, ulong PolicyRevision, ulong AccountingRevision, ulong DomainRevision,
    DateTimeOffset SampledAt, long Timestamp, long TimestampFrequency, MemoryGovernorState State,
    MemoryGovernorReason Reason, bool OverTarget, bool AllowGrowth, bool AllowPromotion, DateTimeOffset? RecoverySince, long? RecoveryTimestamp,
    IReadOnlyDictionary<string, long> Targets, IReadOnlyDictionary<string, long> EffectiveHardCaps,
    IReadOnlyDictionary<string, long> ReclaimRequested, IReadOnlyDictionary<string, TimeSpan> SourceAges,
    IReadOnlyList<MemoryGovernorReclaimFeedback> Feedback, IReadOnlyList<MemoryGovernorDegradation> Degradation);

/// <summary>
/// Pure input-bound control decisions. The existing operation owner consumes these at
/// operation boundaries; this class registers no service, timer, reclaimer or publisher.
/// </summary>
public static class MemoryGovernor
{
    public static MemoryGovernorDecision Evaluate(MemoryGovernorPolicy? policy,
        MemoryGovernorDecision? previous, MemoryGovernorInput input)
    {
        ArgumentNullException.ThrowIfNull(input);
        ArgumentNullException.ThrowIfNull(input.Accounting);
        if (previous?.Sequence == ulong.MaxValue)
        {
            throw new ArgumentOutOfRangeException(nameof(previous), "Decision sequence cannot wrap.");
        }
        ulong sequence = (previous?.Sequence ?? 0) + 1;
        var effective = new Dictionary<string, long>(StringComparer.Ordinal);
        var targets = new Dictionary<string, long>(StringComparer.Ordinal);
        var ages = new Dictionary<string, TimeSpan>(StringComparer.Ordinal);
        var reclaim = new Dictionary<string, long>(StringComparer.Ordinal);
        long? recoveryTimestamp = null;
        // The finite roster comes from the canonical ledger, never from an RSS denominator.
        foreach ((string key, long cap) in input.Accounting.HardCaps)
        {
            if (cap < 0 || !input.Accounting.Used.TryGetValue(key, out long used) || used < 0)
            {
                throw new ArgumentException("Canonical accounting snapshot is malformed.", nameof(input));
            }
            long lastBound = previous?.EffectiveHardCaps.GetValueOrDefault(key, cap) ?? cap;
            long enforced = input.Accounting.EnforcedHardCaps.GetValueOrDefault(key, cap);
            if (enforced < 0 || enforced > cap)
            {
                throw new ArgumentException("Canonical enforced bound is malformed.", nameof(input));
            }
            effective.Add(key, Math.Min(enforced, lastBound));
            if ((policy is null || policy.Resources.ContainsKey(key)) && previous?.Targets.TryGetValue(key, out long target) == true)
            {
                targets.Add(key, Math.Min(target, effective[key]));
            }
        }
        var retained = new Dictionary<string, long>(effective, StringComparer.Ordinal);
        MemoryGovernorDecision Freeze(MemoryGovernorReason reason, MemoryGovernorState state = MemoryGovernorState.UnmetPrerequisite)
        {
            foreach ((string key, long bound) in retained)
            {
                effective[key] = Math.Min(bound, effective[key]);
                if (targets.TryGetValue(key, out long target))
                {
                    targets[key] = Math.Min(target, effective[key]);
                }
            }
            return Result(state, reason, false, null, []);
        }
        MemoryGovernorDecision Result(MemoryGovernorState state, MemoryGovernorReason reason,
            bool grow, DateTimeOffset? recovery, IReadOnlyList<MemoryGovernorReclaimFeedback> feedback)
            => new(sequence, input.CandidateCommit, policy?.Revision ?? previous?.PolicyRevision ?? 0, input.Accounting.PolicyRevision, input.DomainRevision,
                input.Now, input.Timestamp, input.TimestampFrequency, state, reason,
                input.Accounting.OverTarget || effective.Any(item => input.Accounting.Used[item.Key] > item.Value)
                    || targets.Any(item => input.Accounting.Used[item.Key] > item.Value), grow, grow && state == MemoryGovernorState.Normal,
                recovery, recoveryTimestamp, ReadOnly(targets), ReadOnly(effective), ReadOnly(reclaim),
                new ReadOnlyDictionary<string, TimeSpan>(ages), feedback,
                state == MemoryGovernorState.Normal ? Array.Empty<MemoryGovernorDegradation>()
                    : Array.AsReadOnly(Enum.GetValues<MemoryGovernorDegradation>()));
        if (policy is null)
        {
            return Freeze(MemoryGovernorReason.MissingPolicy);
        }
        if (policy.Baseline.Qualification != MemoryQualification.Qualified || policy.Baseline.FrozenAt > input.Now)
        {
            return Freeze(MemoryGovernorReason.BaselineUnqualified);
        }
        if (input.CandidateCommit != policy.Baseline.CandidateCommit || input.Accounting.PolicyRevision != policy.AccountingRevision
            || previous is not null && previous.PolicyRevision > policy.Revision)
        {
            return Freeze(MemoryGovernorReason.RevisionMismatch);
        }
        if (input.ExternalConstraints is null || input.ProtectedAndInFlight is null || input.Feedback is null
            || input.DomainRevision == 0 || input.TimestampFrequency <= 0
            || input.ExternalConstraints.Count > policy.Resources.Count || input.ProtectedAndInFlight.Count > policy.Resources.Count
            || input.Feedback.Count > policy.Resources.Count)
        {
            return Freeze(MemoryGovernorReason.InvalidInput);
        }
        if (previous is not null && (input.Now < previous.SampledAt || input.Timestamp <= previous.Timestamp
                || input.TimestampFrequency != previous.TimestampFrequency))
        {
            return Freeze(MemoryGovernorReason.ClockDiscontinuity);
        }
        if (input.Accounting.Faulted)
        {
            return Freeze(MemoryGovernorReason.LedgerFault, MemoryGovernorState.Faulted);
        }
        if (input.ControllerFaulted)
        {
            return Freeze(MemoryGovernorReason.ControllerFault, MemoryGovernorState.Faulted);
        }
        var constraints = new Dictionary<string, MemoryGovernorExternalConstraint>(StringComparer.Ordinal);
        foreach (MemoryGovernorExternalConstraint constraint in input.ExternalConstraints)
        {
            if (!policy.Resources.TryGetValue(constraint.CapacityIdentity, out MemoryGovernorResourcePlan? plan)
                || !plan.Policy.RequiresExternalConstraint || !constraints.TryAdd(constraint.CapacityIdentity, constraint))
            {
                return Freeze(MemoryGovernorReason.InvalidInput);
            }
        }
        bool pressure = false;
        bool critical = false;
        bool exitStable = true;
        foreach ((string key, MemoryGovernorResourcePlan plan) in policy.Resources)
        {
            if (!input.Accounting.HardCaps.ContainsKey(key))
            {
                return Freeze(MemoryGovernorReason.InvalidInput);
            }
            if (plan.Policy.RequiresExternalConstraint)
            {
                if (!constraints.TryGetValue(key, out MemoryGovernorExternalConstraint? constraint)
                    || constraint.Qualification != MemoryQualification.Qualified
                    || constraint.Usage.State != MemoryObservationState.Available || constraint.Limit.State != MemoryObservationState.Available
                    || constraint.Usage.Metric != MemoryPressureMetric.ScopedExternalUsageBytes
                    || constraint.Limit.Metric != MemoryPressureMetric.ScopedExternalLimitBytes)
                {
                    return Freeze(MemoryGovernorReason.MissingPressure);
                }
                MemoryPressureObservation usage = constraint.Usage;
                MemoryPressureObservation limit = constraint.Limit;
                if (usage.Domain != plan.Policy.Domain || limit.Domain != plan.Policy.Domain
                    || usage.DomainRevision != input.DomainRevision || limit.DomainRevision != input.DomainRevision)
                {
                    return Freeze(MemoryGovernorReason.DomainChanged);
                }
                TimeSpan age = input.Now - (usage.SampledAt < limit.SampledAt ? usage.SampledAt : limit.SampledAt);
                long monotonicAge;
                try
                {
                    monotonicAge = checked(input.Timestamp - Math.Min(usage.Timestamp, limit.Timestamp));
                }
                catch (OverflowException)
                {
                    return Freeze(MemoryGovernorReason.StalePressure);
                }
                UInt128 monotonicNumerator = monotonicAge < 0 ? 0
                    : (UInt128)(ulong)monotonicAge * TimeSpan.TicksPerSecond;
                UInt128 monotonicTicks = monotonicNumerator / (ulong)input.TimestampFrequency;
                TimeSpan monotonicDuration = TimeSpan.FromTicks(monotonicTicks > (ulong)TimeSpan.MaxValue.Ticks
                    ? TimeSpan.MaxValue.Ticks : (long)monotonicTicks);
                age = age > monotonicDuration ? age : monotonicDuration;
                ages.Add(key, age);
                if (usage.SampledAt > input.Now || limit.SampledAt > input.Now || age > policy.MaximumSourceAge
                    || monotonicAge < 0 || monotonicNumerator > (UInt128)(ulong)policy.MaximumSourceAge.Ticks * (ulong)input.TimestampFrequency
                    || usage.Timestamp > input.Timestamp || limit.Timestamp > input.Timestamp
                    || usage.TimestampFrequency != input.TimestampFrequency || limit.TimestampFrequency != input.TimestampFrequency)
                {
                    return Freeze(MemoryGovernorReason.StalePressure);
                }
                long externalLimit = limit.Value!.Value;
                long headroom = externalLimit - usage.Value!.Value;
                long owned = input.Accounting.Used[key];
                long scopedAllowance = owned >= externalLimit ? externalLimit
                    : owned + Math.Min(Math.Max(0, headroom), externalLimit - owned);
                effective[key] = Math.Min(input.Accounting.HardCaps[key], scopedAllowance);
                pressure |= headroom <= plan.Policy.EntryHeadroom;
                critical |= headroom <= plan.Policy.CriticalHeadroom;
                exitStable &= headroom >= plan.Policy.ExitHeadroom;
            }
            else
            {
                effective[key] = input.Accounting.HardCaps[key];
            }
        }
        if (input.ProtectedAndInFlight.Any(item => !policy.Resources.ContainsKey(item.Key)
                || item.Value < 0 || item.Value > input.Accounting.Used[item.Key]))
        {
            return Freeze(MemoryGovernorReason.InvalidInput);
        }
        bool infeasible = input.ProtectedAndInFlight.Any(item => item.Value > effective[item.Key]);
        foreach (string key in policy.Resources.Keys)
        {
            pressure |= input.Accounting.Used[key] > effective[key];
        }
        bool serviceCritical = input.ServicePressure is
        {
            Qualification: MemoryQualification.Qualified,
            SustainedSwapActivity: true, SustainedStalls: true, ServiceDegraded: true
        } service
            && service.DomainRevision == input.DomainRevision && service.SampledAt <= input.Now
            && input.Now - service.SampledAt <= policy.MaximumSourceAge;
        critical |= serviceCritical;
        infeasible |= input.ProtectedAndInFlight.Any(item => item.Value > Math.Min(effective[item.Key],
            critical ? policy.Resources[item.Key].Policy.CriticalTarget
                : pressure ? policy.Resources[item.Key].Policy.PressureTarget : policy.Resources[item.Key].Policy.NormalTarget));
        var feedback = new List<MemoryGovernorReclaimFeedback>(input.Feedback.Count);
        var feedbackKeys = new HashSet<string>(StringComparer.Ordinal);
        foreach (MemoryGovernorReclaimFeedback item in input.Feedback)
        {
            if (previous is null || item.DecisionSequence != previous.Sequence || !feedbackKeys.Add(item.CapacityIdentity)
                || !previous.ReclaimRequested.TryGetValue(item.CapacityIdentity, out long requested)
                || item.Requested != requested || item.AllocatorRelinquished < 0 || item.OsRetained < 0
                || item.Pending < 0 || item.Blocked < 0 || item.OsRetained > item.AllocatorRelinquished
                || item.AllocatorRelinquished > requested || item.Pending > requested - item.AllocatorRelinquished
                || item.Blocked > requested - item.AllocatorRelinquished - item.Pending)
            {
                return Freeze(MemoryGovernorReason.InvalidInput);
            }
            feedback.Add(item);
        }
        MemoryGovernorState state = infeasible ? MemoryGovernorState.Infeasible
            : critical ? MemoryGovernorState.Critical : pressure ? MemoryGovernorState.Pressure : MemoryGovernorState.Normal;
        DateTimeOffset? recoverySince = null;
        if (state == MemoryGovernorState.Normal && previous is not null && previous.State != MemoryGovernorState.Normal)
        {
            recoverySince = exitStable && previous.DomainRevision == input.DomainRevision && previous.PolicyRevision == policy.Revision
                ? previous.RecoverySince ?? input.Now : null;
            recoveryTimestamp = recoverySince is not null ? previous.RecoveryTimestamp ?? input.Timestamp : null;
            long stableElapsed;
            try
            {
                stableElapsed = recoveryTimestamp is null ? 0 : checked(input.Timestamp - recoveryTimestamp.Value);
            }
            catch (OverflowException)
            {
                return Freeze(MemoryGovernorReason.ClockDiscontinuity);
            }
            if (recoveryTimestamp is null || stableElapsed < 0
                || (UInt128)(ulong)stableElapsed * TimeSpan.TicksPerSecond
                    < (UInt128)(ulong)policy.StableRecoveryWindow.Ticks * (ulong)input.TimestampFrequency)
            {
                state = MemoryGovernorState.Recovering;
            }
        }
        long elapsed = 0;
        if (previous is not null)
        {
            try
            {
                elapsed = checked(input.Timestamp - previous.Timestamp);
            }
            catch (OverflowException)
            {
                return Freeze(MemoryGovernorReason.ClockDiscontinuity);
            }
        }
        foreach ((string key, MemoryGovernorResourcePlan plan) in policy.Resources)
        {
            long desired = state switch
            {
                MemoryGovernorState.Critical or MemoryGovernorState.Infeasible => plan.Policy.CriticalTarget,
                MemoryGovernorState.Pressure => plan.Policy.PressureTarget,
                _ => plan.Policy.NormalTarget
            };
            desired = Math.Min(desired, effective[key]);
            if (previous?.Targets.TryGetValue(key, out long previousTarget) == true && desired > previousTarget)
            {
                UInt128 growth = (UInt128)(ulong)elapsed * (ulong)plan.Policy.MaximumGrowthPerSecond / (ulong)input.TimestampFrequency;
                UInt128 ceiling = (ulong)(desired - previousTarget);
                long increment = (long)(growth < ceiling ? growth : ceiling);
                desired = state == MemoryGovernorState.Normal ? previousTarget + increment : previousTarget;
            }
            targets[key] = desired;
            if (plan.Unit == MemoryResourceUnit.Bytes && input.Accounting.Used[key] > desired)
            {
                reclaim[key] = input.Accounting.Used[key] - desired;
            }
        }
        MemoryGovernorReason reason = infeasible ? MemoryGovernorReason.ProtectedCommitments
            : serviceCritical ? MemoryGovernorReason.SustainedServicePressure
            : pressure || critical ? MemoryGovernorReason.LowHeadroom
            : state == MemoryGovernorState.Recovering ? MemoryGovernorReason.RecoveryWindow
            : previous is not null && targets.Any(item => item.Value < policy.Resources[item.Key].Policy.NormalTarget)
                ? MemoryGovernorReason.BoundedGrowth : MemoryGovernorReason.Stable;
        return Result(state, reason, state == MemoryGovernorState.Normal, recoverySince, feedback.AsReadOnly());
    }

    private static IReadOnlyDictionary<string, long> ReadOnly(Dictionary<string, long> values)
        => new ReadOnlyDictionary<string, long>(values);
}
