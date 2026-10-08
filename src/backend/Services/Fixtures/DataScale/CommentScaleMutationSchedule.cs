using System.Text.Json.Serialization;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Testing;
using FsusBlog.Server.Services.Fixtures;

namespace FsusBlog.Server.Services.Fixtures.DataScale;

/// <summary>
/// One reference-only request in the existing scenario. PreviousStateRole names
/// the exact initial or preceding same-comment owner observation, never a generated
/// version/event counter. Command provenance and all referenced facts await admission.
/// </summary>
public sealed record CommentScaleMutationRequest(
    string Role,
    string CommentRole,
    string PreviousStateRole,
    string OccurredAtRole,
    string ActorEvidenceDigest,
    string SecurityEvidenceDigest,
    string PolicyDigest,
    string CommandSourceCommit,
    string CommandContractDigest,
    CommentScaleMutationIntent Intent);

/// <summary>Closed references to the six actual formal commands; no command is constructed.</summary>
[JsonPolymorphic(TypeDiscriminatorPropertyName = "operation")]
[JsonDerivedType(typeof(CommentScaleEditIntent), "edit")]
[JsonDerivedType(typeof(CommentScaleSoftDeleteIntent), "soft-delete")]
[JsonDerivedType(typeof(CommentScaleModerateIntent), "moderate")]
[JsonDerivedType(typeof(CommentScaleReportIntent), "report")]
[JsonDerivedType(typeof(CommentScaleAppealIntent), "appeal")]
[JsonDerivedType(typeof(CommentScaleReviewAppealIntent), "review-appeal")]
public abstract record CommentScaleMutationIntent
{
    /// <summary>Existing production port type, not a callable or admitted command.</summary>
    [JsonIgnore]
    public abstract Type ProductionCommandType
    {
        get;
    }
}

/// <summary>Generated content reference; edit normalization remains with production.</summary>
public sealed record CommentScaleEditIntent(string ContentRole, CommentScaleArtifactReference ContentArtifact)
    : CommentScaleMutationIntent
{
    [JsonIgnore]
    public override Type ProductionCommandType => typeof(CommentFixtureEdit);
}

/// <summary>Deletion request without a synthesized revision, status or event.</summary>
public sealed record CommentScaleSoftDeleteIntent : CommentScaleMutationIntent
{
    [JsonIgnore]
    public override Type ProductionCommandType => typeof(CommentFixtureSoftDelete);
}

/// <summary>Desired status and live admin/claim fact roles; no ban, token or rowversion slot.</summary>
public sealed record CommentScaleModerateIntent(
    CommentModerationStatus Status, string AdminActorRole, string? ReasonRole, string ClaimFactsRole)
    : CommentScaleMutationIntent
{
    [JsonIgnore]
    public override Type ProductionCommandType => typeof(CommentFixtureModerate);
}

/// <summary>Account report facts; no scoped credential or one-new-report assertion.</summary>
public sealed record CommentScaleReportIntent(string ReporterActorRole, string ReasonCodeRole, string? DetailRole)
    : CommentScaleMutationIntent
{
    [JsonIgnore]
    public override Type ProductionCommandType => typeof(CommentFixtureReport);
}

/// <summary>Reason and real target-decision facts; no moderation ordinal or native ID.</summary>
public sealed record CommentScaleAppealIntent(string ReasonRole, string TargetDecisionFactsRole)
    : CommentScaleMutationIntent
{
    [JsonIgnore]
    public override Type ProductionCommandType => typeof(CommentFixtureAppeal);
}

/// <summary>Earlier same-comment appeal plus original reviewer/decision/reason/target facts.</summary>
public sealed record CommentScaleReviewAppealIntent(
    string AppealRole, string ReviewerActorRole, string DecisionRole, string ReasonRole, string TargetDecisionFactsRole)
    : CommentScaleMutationIntent
{
    [JsonIgnore]
    public override Type ProductionCommandType => typeof(CommentFixtureReviewAppeal);
}

/// <summary>
/// Structural schedule inspection only. Actual command validation, normalized text,
/// status/version/event outcomes, pending appeals, leases and credential custody
/// belong to the original commands and their observations, not this inspector.
/// </summary>
public static class CommentScaleMutationScheduleContract
{
    internal static void Inspect(
        CommentScaleScenario scenario, ResolvedTemporalRoleContext temporal, List<string> errors)
    {
        // A production command added/removed/renamed cannot silently escape this
        // closed reference model. This checks the actual original polymorphic roster.
        JsonDerivedTypeAttribute[] production = typeof(CommentFixtureMutationCommand)
            .GetCustomAttributes(typeof(JsonDerivedTypeAttribute), false)
            .Cast<JsonDerivedTypeAttribute>().ToArray();
        JsonDerivedTypeAttribute[] intents = typeof(CommentScaleMutationIntent)
            .GetCustomAttributes(typeof(JsonDerivedTypeAttribute), false)
            .Cast<JsonDerivedTypeAttribute>().ToArray();
        var supported = new Dictionary<Type, Type>
        {
            [typeof(CommentFixtureEdit)] = typeof(CommentScaleEditIntent),
            [typeof(CommentFixtureSoftDelete)] = typeof(CommentScaleSoftDeleteIntent),
            [typeof(CommentFixtureModerate)] = typeof(CommentScaleModerateIntent),
            [typeof(CommentFixtureReport)] = typeof(CommentScaleReportIntent),
            [typeof(CommentFixtureAppeal)] = typeof(CommentScaleAppealIntent),
            [typeof(CommentFixtureReviewAppeal)] = typeof(CommentScaleReviewAppealIntent)
        };
        Require(production.Length == supported.Count && intents.Length == supported.Count
            && new HashSet<Type>(production.Select(item => item.DerivedType)).SetEquals(supported.Keys)
            && production.All(item => supported.TryGetValue(item.DerivedType, out Type? intentType)
                && intents.Count(candidate => candidate.DerivedType == intentType
                    && Equals(candidate.TypeDiscriminator, item.TypeDiscriminator)) == 1),
            "mutation_command_model_drift", errors);

        if (scenario.Mutations is null)
        {
            errors.Add("mutation_schedule_missing");
            return;
        }
        var targets = new Dictionary<string, CommentScaleCommentRequest>(StringComparer.Ordinal);
        foreach (CommentScaleCommentRequest comment in scenario.Comments)
        {
            if (comment is not null && comment.Role is not null)
            {
                targets.TryAdd(comment.Role, comment);
            }
        }
        var roles = new HashSet<string>(targets.Keys, StringComparer.Ordinal);
        var previousByTarget = targets.Keys.ToDictionary(role => role, role => role, StringComparer.Ordinal);
        var appeals = new Dictionary<string, string>(StringComparer.Ordinal);
        DateTimeOffset? previousInstant = null;
        foreach (CommentScaleMutationRequest step in scenario.Mutations)
        {
            if (step is null)
            {
                errors.Add("mutation_step_missing");
                continue;
            }
            Require(IsRole(step.Role) && roles.Add(step.Role), "mutation_role", errors);
            bool knownTarget = step.CommentRole is not null && targets.ContainsKey(step.CommentRole);
            Require(knownTarget, "mutation_target", errors);
            Require(IsRole(step.PreviousStateRole) && knownTarget
                && previousByTarget[step.CommentRole!] == step.PreviousStateRole, "mutation_predecessor", errors);
            Require(CommentScalePlanContract.IsDigest(step.ActorEvidenceDigest)
                && CommentScalePlanContract.IsDigest(step.SecurityEvidenceDigest)
                && CommentScalePlanContract.IsDigest(step.PolicyDigest), "mutation_evidence", errors);
            Require(CommentScalePlanContract.IsCommit(step.CommandSourceCommit)
                && CommentScalePlanContract.IsDigest(step.CommandContractDigest), "mutation_authority", errors);
            DateTimeOffset? instant = Instant(step.OccurredAtRole, temporal, errors);
            DateTimeOffset? created = knownTarget
                ? Instant(targets[step.CommentRole!].CreatedAtRole, temporal, errors) : null;
            Require(instant.HasValue && created.HasValue && instant >= created
                && (!previousInstant.HasValue || previousInstant <= instant), "mutation_time_order", errors);
            if (instant.HasValue)
            {
                previousInstant = instant;
            }
            InspectIntent(step, appeals, errors);
            if (knownTarget && IsRole(step.Role))
            {
                previousByTarget[step.CommentRole!] = step.Role;
                if (step.Intent is CommentScaleAppealIntent)
                {
                    appeals.TryAdd(step.Role, step.CommentRole!);
                }
            }
        }
    }

    private static void InspectIntent(
        CommentScaleMutationRequest step, IReadOnlyDictionary<string, string> appeals, List<string> errors)
    {
        bool valid = step.Intent switch
        {
            CommentScaleEditIntent edit => IsRole(edit.ContentRole) && edit.ContentArtifact is not null
                && edit.ContentArtifact.Schema == "fsusblog.generated-content-shape.v1"
                && CommentScalePlanContract.IsDigest(edit.ContentArtifact.ContentDigest),
            CommentScaleSoftDeleteIntent => true,
            CommentScaleModerateIntent moderate => Enum.IsDefined(moderate.Status)
                && IsRole(moderate.AdminActorRole) && OptionalRole(moderate.ReasonRole) && IsRole(moderate.ClaimFactsRole),
            CommentScaleReportIntent report => IsRole(report.ReporterActorRole)
                && IsRole(report.ReasonCodeRole) && OptionalRole(report.DetailRole),
            CommentScaleAppealIntent appeal => IsRole(appeal.ReasonRole) && IsRole(appeal.TargetDecisionFactsRole),
            CommentScaleReviewAppealIntent review => IsRole(review.AppealRole) && IsRole(review.ReviewerActorRole)
                && IsRole(review.DecisionRole) && IsRole(review.ReasonRole) && IsRole(review.TargetDecisionFactsRole),
            _ => false
        };
        Require(step.Intent is not null, "mutation_intent", errors);
        Require(valid, "mutation_payload", errors);
        if (step.Intent is CommentScaleReviewAppealIntent reviewIntent)
        {
            Require(reviewIntent.AppealRole is not null
                && appeals.TryGetValue(reviewIntent.AppealRole, out string? target)
                && target == step.CommentRole, "mutation_appeal_reference", errors);
        }
    }

    private static DateTimeOffset? Instant(
        string role, ResolvedTemporalRoleContext temporal, List<string> errors)
    {
        if (IsRole(role))
        {
            try
            {
                return temporal.RequireInstant(role);
            }
            catch (InvalidOperationException)
            {
                errors.Add("temporal_role_missing");
                return null;
            }
        }
        errors.Add("temporal_role_invalid");
        return null;
    }

    private static bool IsRole(string role) => CommentScalePlanContract.IsRole(role);

    private static bool OptionalRole(string? role) => role is null || IsRole(role);

    private static void Require(bool condition, string error, List<string> errors)
    {
        if (!condition)
        {
            errors.Add(error);
        }
    }
}
