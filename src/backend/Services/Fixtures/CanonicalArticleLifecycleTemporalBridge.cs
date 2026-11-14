using System.Text.Json;

using FsusBlog.Server.Infrastructure.Testing;

namespace FsusBlog.Server.Services.Fixtures;

/// <summary>
/// Consumes an already independently verified Node temporal artifact and delegates to the
/// formal lifecycle port. Exact producer/run/context bindings and observed business time
/// are required; this adapter never advances clocks or synthesizes database history.
/// </summary>
public sealed class CanonicalArticleLifecycleTemporalBridge
{
    private readonly ResolvedTemporalRoleContext _roles;
    private readonly string _contextDigest;
    private readonly ICanonicalArticleLifecycleFixturePort _port;
    private readonly TimeProvider _businessClock;

    public CanonicalArticleLifecycleTemporalBridge(
        string resolvedRolesJson,
        string expectedArtifactDigest,
        string expectedTemporalContextDigest,
        string expectedProducerId,
        ICanonicalArticleLifecycleFixturePort port,
        TimeProvider businessClock)
    {
        ArgumentNullException.ThrowIfNull(port);
        ArgumentNullException.ThrowIfNull(businessClock);
        _roles = ResolvedTemporalRoleContext.Parse(resolvedRolesJson, expectedArtifactDigest);
        using JsonDocument document = JsonDocument.Parse(resolvedRolesJson);
        string? contextDigest = document.RootElement.GetProperty("contextIdentity").GetProperty("contextDigest").GetString();
        if (string.IsNullOrWhiteSpace(expectedProducerId) || _roles.ProducerId != expectedProducerId
            || expectedTemporalContextDigest is not { Length: 71 }
            || !expectedTemporalContextDigest.StartsWith("sha256:", StringComparison.Ordinal)
            || expectedTemporalContextDigest.AsSpan(7).IndexOfAnyExcept("0123456789abcdef") >= 0
            || contextDigest != expectedTemporalContextDigest)
        {
            throw new CanonicalArticleLifecycleValidationException("temporal_role_binding_mismatch");
        }
        _contextDigest = expectedTemporalContextDigest;
        _port = port;
        _businessClock = businessClock;
    }

    /// <summary>Schedule using exact resolved roles, preserving the caller's full writer request.</summary>
    public Task<CanonicalArticleLifecycleResult> ExecuteScheduledAsync(
        CanonicalArticleLifecycleRequest request,
        string operationRoleId,
        string dueRoleId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Plan);
        RequireBindingAndTime(request.Binding, operationRoleId);
        if (request.Plan.Variant is not (CanonicalArticleLifecycleVariants.Scheduled
            or CanonicalArticleLifecycleVariants.PublishedScheduledUpdate))
        {
            throw new CanonicalArticleLifecycleValidationException("temporal_role_variant_not_scheduled");
        }
        DateTime dueAt = _roles.RequireInstant(dueRoleId).UtcDateTime;
        if (dueAt <= _roles.RequireInstant(operationRoleId).UtcDateTime)
        {
            throw new CanonicalArticleLifecycleValidationException("scheduled_at_must_be_future");
        }
        if (request.Plan.ScheduledPublishAt is DateTime supplied
            && (supplied.Kind != DateTimeKind.Utc || supplied != dueAt))
        {
            throw new CanonicalArticleLifecycleValidationException("scheduled_role_plan_mismatch");
        }
        cancellationToken.ThrowIfCancellationRequested();
        return _port.ExecuteAsync(request with
        {
            Plan = request.Plan with
            {
                ScheduledPublishAt = dueAt
            }
        }, cancellationToken);
    }

    /// <summary>Publish only at a caller-observed resolved instant; the port owns due checks and real transactions.</summary>
    public Task<CanonicalArticleLifecycleResult> PublishScheduledAsync(
        CanonicalArticleLifecycleFixtureBinding binding,
        CanonicalArticleLifecycleReceipt scheduledReceipt,
        string operationRoleId,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(scheduledReceipt);
        RequireBindingAndTime(binding, operationRoleId);
        cancellationToken.ThrowIfCancellationRequested();
        return _port.PublishScheduledAsync(binding, scheduledReceipt, cancellationToken);
    }

    private void RequireBindingAndTime(CanonicalArticleLifecycleFixtureBinding binding, string operationRoleId)
    {
        ArgumentNullException.ThrowIfNull(binding);
        binding.Validate();
        if (binding.RunId != _roles.SchedulerRunId || binding.TemporalContextDigest != _contextDigest)
        {
            throw new CanonicalArticleLifecycleValidationException("temporal_role_binding_mismatch");
        }
        DateTimeOffset observed = _businessClock.GetUtcNow();
        if (observed.Offset != TimeSpan.Zero || observed != _roles.RequireInstant(operationRoleId))
        {
            throw new CanonicalArticleLifecycleValidationException("temporal_role_clock_mismatch");
        }
    }
}
