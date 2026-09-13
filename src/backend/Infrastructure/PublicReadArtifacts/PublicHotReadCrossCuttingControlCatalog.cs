namespace FsusBlog.Server.Infrastructure.PublicReadArtifacts;

internal enum PublicHotReadControlCoverage : byte
{
    GlobalBeforeBranch = 0,
    EarlyReplayed = 1,
    EndpointOnlyNotApplicable = 2
}

internal enum PublicHotReadPipelineStageClassification : byte
{
    Infrastructure = 0,
    BranchMechanic = 1,
    EndpointFunctional = 2,
    CrossCuttingControl = 3
}

internal readonly record struct PublicHotReadPipelineStageDescriptor(
    string StageId,
    PublicHotReadPipelineStageClassification Classification,
    string? ControlId);

internal sealed record PublicHotReadCrossCuttingControl(
    string ControlId,
    PublicHotReadControlCoverage Coverage,
    string? GlobalStageId = null,
    string? EarlyStageId = null,
    string? EndpointStageId = null,
    string? DoubleExecutionGuardId = null,
    string? NotApplicableEvidenceId = null,
    bool ReplayAfterWriter = false);

internal static class PublicHotReadCrossCuttingControlCatalog
{
    internal const string CredentialFreeEvidence = "credential-free-anonymous-public-artifact";
    internal const string SafeMethodEvidence = "safe-method-anonymous-public-artifact";
    internal const string SameOriginEvidence = "same-origin-anonymous-public-artifact";

    private static readonly PublicHotReadCrossCuttingControl[] s_controls =
    [
        Global("release-and-security-headers", "security-headers"),
        Global("deployment-request-tracking", "deployment-request-tracking"),
        Global("shield-exception-binary-boundary", "core-middlewares"),
        Global("observability-correlation", "observability-correlation"),
        MissPathReplayed("public-read-rate-limit", "public-hot-read-rate-limiter", "rate-limiter", "rate-limit-evaluated"),
        Replayed("request-audit-context", "public-hot-read-request-audit-context", "request-audit-context", "request-audit-context-evaluated"),
        EndpointOnly("cors", "cors", SameOriginEvidence),
        EndpointOnly("antiforgery", "antiforgery", SafeMethodEvidence),
        EndpointOnly("csrf-origin-guard", "csrf-origin-guard", SafeMethodEvidence),
        EndpointOnly("anonymous-gateway-header-guard", "anonymous-gateway-header-guard", CredentialFreeEvidence),
        EndpointOnly("authentication", "authentication", CredentialFreeEvidence),
        EndpointOnly("banned-user", "banned-user", CredentialFreeEvidence),
        EndpointOnly("authorization", "authorization", CredentialFreeEvidence)
    ];

    private static readonly string[] s_requiredControlIds =
    [
        "release-and-security-headers",
        "deployment-request-tracking",
        "shield-exception-binary-boundary",
        "observability-correlation",
        "public-read-rate-limit",
        "request-audit-context",
        "cors",
        "antiforgery",
        "csrf-origin-guard",
        "anonymous-gateway-header-guard",
        "authentication",
        "banned-user",
        "authorization"
    ];

    private static readonly HashSet<string> s_allowedNotApplicableEvidence = new(StringComparer.Ordinal)
    {
        CredentialFreeEvidence,
        SafeMethodEvidence,
        SameOriginEvidence
    };

    internal static IReadOnlyList<PublicHotReadCrossCuttingControl> All => s_controls;

    internal static void ValidateOrThrow(
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> applicationStages,
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> endpointStages)
        => ValidateOrThrow(
            applicationStages,
            endpointStages,
            s_controls,
            PublicHotReadRouteSecurityCatalog.All,
            PublicHotReadEarlyEndpointCatalog.All);

    internal static void ValidateOrThrow(
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> applicationStages,
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> endpointStages,
        IReadOnlyList<PublicHotReadCrossCuttingControl> controls,
        IReadOnlyList<PublicHotReadRoutePolicy> routePolicies,
        IReadOnlyList<Endpoint> syntheticEndpoints)
    {
        ArgumentNullException.ThrowIfNull(applicationStages);
        ArgumentNullException.ThrowIfNull(endpointStages);
        ArgumentNullException.ThrowIfNull(controls);
        ArgumentNullException.ThrowIfNull(routePolicies);
        ArgumentNullException.ThrowIfNull(syntheticEndpoints);

        PublicHotReadRouteSecurityCatalog.ValidateOrThrow(routePolicies);
        PublicHotReadEarlyEndpointCatalog.ValidateOrThrow(routePolicies, syntheticEndpoints);

        string[] actualControlIds = controls
            .Select(static control => control.ControlId)
            .OrderBy(static id => id, StringComparer.Ordinal)
            .ToArray();
        string[] requiredControlIds = s_requiredControlIds
            .OrderBy(static id => id, StringComparer.Ordinal)
            .ToArray();
        if (!actualControlIds.SequenceEqual(requiredControlIds, StringComparer.Ordinal))
        {
            throw new InvalidOperationException("public hot-read cross-cutting control catalog is incomplete");
        }

        EnsureUnique(applicationStages, "application");
        EnsureUnique(endpointStages, "endpoint");
        ValidateStageClassifications(applicationStages, endpointStages, controls);
        int classifierIndex = IndexOfExactlyOnce(applicationStages, "public-hot-read-classifier", "application");
        int writerIndex = IndexOfExactlyOnce(applicationStages, "public-hot-read-fast-path", "application");
        int restoreIndex = IndexOfExactlyOnce(applicationStages, "public-hot-read-fallback-restore", "application");
        int endpointPipelineIndex = IndexOfExactlyOnce(applicationStages, "endpoint-pipeline", "application");

        foreach (PublicHotReadCrossCuttingControl control in controls)
        {
            if (string.IsNullOrWhiteSpace(control.ControlId))
            {
                throw new InvalidOperationException("public hot-read cross-cutting control id is empty");
            }

            switch (control.Coverage)
            {
                case PublicHotReadControlCoverage.GlobalBeforeBranch:
                    {
                        int globalIndex = IndexOfExactlyOnce(
                            applicationStages,
                            Require(control.GlobalStageId, control, nameof(control.GlobalStageId)),
                            "application");
                        if (globalIndex >= classifierIndex
                            || control.EarlyStageId is not null
                            || control.EndpointStageId is not null
                            || control.DoubleExecutionGuardId is not null
                            || control.NotApplicableEvidenceId is not null)
                        {
                            throw Invalid(control, "global control must run exactly once before the early branch");
                        }
                        break;
                    }
                case PublicHotReadControlCoverage.EarlyReplayed:
                    {
                        int earlyIndex = IndexOfExactlyOnce(
                            applicationStages,
                            Require(control.EarlyStageId, control, nameof(control.EarlyStageId)),
                            "application");
                        _ = IndexOfExactlyOnce(
                            endpointStages,
                            Require(control.EndpointStageId, control, nameof(control.EndpointStageId)),
                            "endpoint");
                        bool placementValid = control.ReplayAfterWriter
                            ? earlyIndex > writerIndex && earlyIndex < restoreIndex
                            : earlyIndex > classifierIndex && earlyIndex < writerIndex;
                        if (!placementValid
                            || string.IsNullOrWhiteSpace(control.DoubleExecutionGuardId)
                            || control.GlobalStageId is not null
                            || control.NotApplicableEvidenceId is not null)
                        {
                            throw Invalid(
                                control,
                                control.ReplayAfterWriter
                                    ? "miss-path replayed control must sit after L0 and before fallback restore, with a double-execution guard"
                                    : "replayed control must have early/canonical stages and a double-execution guard");
                        }
                        break;
                    }
                case PublicHotReadControlCoverage.EndpointOnlyNotApplicable:
                    _ = IndexOfExactlyOnce(
                        endpointStages,
                        Require(control.EndpointStageId, control, nameof(control.EndpointStageId)),
                        "endpoint");
                    if (control.GlobalStageId is not null
                        || control.EarlyStageId is not null
                        || control.DoubleExecutionGuardId is not null
                        || !s_allowedNotApplicableEvidence.Contains(control.NotApplicableEvidenceId ?? string.Empty))
                    {
                        throw Invalid(control, "endpoint-only control requires explicit fast-path non-applicability evidence");
                    }
                    ValidateNotApplicableEvidence(control, routePolicies);
                    break;
                default:
                    throw Invalid(control, "unknown coverage mode");
            }
        }

        if (classifierIndex >= writerIndex
            || writerIndex >= restoreIndex
            || restoreIndex >= endpointPipelineIndex)
        {
            throw new InvalidOperationException("public hot-read branch order is invalid");
        }

        string? duplicateGuard = controls
            .Where(static control => control.Coverage == PublicHotReadControlCoverage.EarlyReplayed)
            .GroupBy(static control => control.DoubleExecutionGuardId, StringComparer.Ordinal)
            .FirstOrDefault(static group => group.Count() != 1)
            ?.Key;
        if (duplicateGuard is not null)
        {
            throw new InvalidOperationException(
                $"public hot-read replay guard must be unique: {duplicateGuard}");
        }

        ValidateExecutableRouteConstraints(routePolicies);
    }

    private static void ValidateNotApplicableEvidence(
        PublicHotReadCrossCuttingControl control,
        IReadOnlyList<PublicHotReadRoutePolicy> routePolicies)
    {
        bool valid = control.NotApplicableEvidenceId switch
        {
            CredentialFreeEvidence => routePolicies.All(static policy => policy.RequiresAnonymousRequest),
            SafeMethodEvidence => routePolicies.All(static policy => policy.RequiresSafeMethod),
            SameOriginEvidence => routePolicies.All(static policy => policy.DefersCorsRequestsToEndpointPipeline),
            _ => false
        };
        if (!valid)
        {
            throw Invalid(control, "route policies do not prove the declared non-applicability evidence");
        }
    }

    private static void ValidateExecutableRouteConstraints(
        IReadOnlyList<PublicHotReadRoutePolicy> routePolicies)
    {
        foreach (PublicHotReadRoutePolicy policy in routePolicies)
        {
            DefaultHttpContext anonymousGet = CreateProbe(policy.ProbePath, HttpMethods.Get);
            if (!PublicHotReadFastPath.TryCreateRequestFeatureForTests(
                    anonymousGet,
                    out PublicHotReadRequestFeature? feature)
                || feature?.RoutePolicyId != policy.PolicyId)
            {
                throw new InvalidOperationException(
                    $"public hot-read route policy probe is not classified: {policy.PolicyId}");
            }

            DefaultHttpContext credentialed = CreateProbe(policy.ProbePath, HttpMethods.Get);
            credentialed.Request.Headers.Authorization = "Bearer startup-probe";
            RequireEndpointFallback(credentialed, policy, CredentialFreeEvidence);

            DefaultHttpContext authenticated = CreateProbe(policy.ProbePath, HttpMethods.Get);
            authenticated.User = new System.Security.Claims.ClaimsPrincipal(
                new System.Security.Claims.ClaimsIdentity(
                    [new System.Security.Claims.Claim("sub", "startup-probe")],
                    "startup-probe"));
            RequireEndpointFallback(authenticated, policy, CredentialFreeEvidence);

            DefaultHttpContext rejectedGatewayHeader = CreateProbe(policy.ProbePath, HttpMethods.Get);
            rejectedGatewayHeader.Request.Headers["X-Fsus-User-Id"] = "startup-probe";
            RequireEndpointFallback(rejectedGatewayHeader, policy, CredentialFreeEvidence);

            RequireEndpointFallback(CreateProbe(policy.ProbePath, HttpMethods.Post), policy, SafeMethodEvidence);

            DefaultHttpContext cors = CreateProbe(policy.ProbePath, HttpMethods.Get);
            cors.Request.Headers.Origin = "https://cross-origin.invalid";
            RequireEndpointFallback(cors, policy, SameOriginEvidence);
        }

        foreach (string path in new[]
        {
            "/api/binary/admin/users",
            "/api/notifications/stream",
            "/api/binary/article/42/related.aeds",
            "/api/binary/comment/policy"
        })
        {
            if (PublicHotReadFastPath.TryCreateRequestFeatureForTests(
                    CreateProbe(path, HttpMethods.Get),
                    out _))
            {
                throw new InvalidOperationException(
                    $"public hot-read non-artifact boundary was classified: {path}");
            }
        }
    }

    private static DefaultHttpContext CreateProbe(string path, string method)
    {
        var context = new DefaultHttpContext();
        context.Request.Path = path;
        context.Request.Method = method;
        return context;
    }

    private static void RequireEndpointFallback(
        DefaultHttpContext context,
        PublicHotReadRoutePolicy policy,
        string evidenceId)
    {
        if (PublicHotReadFastPath.TryCreateRequestFeatureForTests(context, out _))
        {
            throw new InvalidOperationException(
                $"public hot-read executable constraint failed: {policy.PolicyId}:{evidenceId}");
        }
    }

    private static PublicHotReadCrossCuttingControl Global(string controlId, string stageId)
        => new(controlId, PublicHotReadControlCoverage.GlobalBeforeBranch, GlobalStageId: stageId);

    private static PublicHotReadCrossCuttingControl Replayed(
        string controlId,
        string earlyStageId,
        string endpointStageId,
        string guardId)
        => new(
            controlId,
            PublicHotReadControlCoverage.EarlyReplayed,
            EarlyStageId: earlyStageId,
            EndpointStageId: endpointStageId,
            DoubleExecutionGuardId: guardId);

    private static PublicHotReadCrossCuttingControl MissPathReplayed(
        string controlId,
        string earlyStageId,
        string endpointStageId,
        string guardId)
        => new(
            controlId,
            PublicHotReadControlCoverage.EarlyReplayed,
            EarlyStageId: earlyStageId,
            EndpointStageId: endpointStageId,
            DoubleExecutionGuardId: guardId,
            ReplayAfterWriter: true);

    private static PublicHotReadCrossCuttingControl EndpointOnly(
        string controlId,
        string endpointStageId,
        string evidenceId)
        => new(
            controlId,
            PublicHotReadControlCoverage.EndpointOnlyNotApplicable,
            EndpointStageId: endpointStageId,
            NotApplicableEvidenceId: evidenceId);

    private static string Require(
        string? value,
        PublicHotReadCrossCuttingControl control,
        string field)
        => !string.IsNullOrWhiteSpace(value)
            ? value
            : throw Invalid(control, $"{field} is required");

    private static int IndexOfExactlyOnce(
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> stages,
        string stageId,
        string pipeline)
    {
        int index = -1;
        int count = 0;
        for (int candidate = 0; candidate < stages.Count; candidate++)
        {
            if (!string.Equals(stages[candidate].StageId, stageId, StringComparison.Ordinal))
            {
                continue;
            }

            index = candidate;
            count++;
        }

        return count == 1
            ? index
            : throw new InvalidOperationException(
                $"public hot-read control stage must appear exactly once: {pipeline}:{stageId} (count={count})");
    }

    private static void EnsureUnique(
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> stages,
        string pipeline)
    {
        string? duplicate = stages
            .GroupBy(static stage => stage.StageId, StringComparer.Ordinal)
            .FirstOrDefault(static group => group.Count() != 1)
            ?.Key;
        if (duplicate is not null)
        {
            throw new InvalidOperationException(
                $"public hot-read {pipeline} pipeline contains duplicate stage: {duplicate}");
        }
    }

    private static void ValidateStageClassifications(
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> applicationStages,
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> endpointStages,
        IReadOnlyList<PublicHotReadCrossCuttingControl> controls)
    {
        ValidatePipelineStageClassifications(applicationStages, controls, applicationPipeline: true);
        ValidatePipelineStageClassifications(endpointStages, controls, applicationPipeline: false);
    }

    private static void ValidatePipelineStageClassifications(
        IReadOnlyList<PublicHotReadPipelineStageDescriptor> stages,
        IReadOnlyList<PublicHotReadCrossCuttingControl> controls,
        bool applicationPipeline)
    {
        string pipeline = applicationPipeline ? "application" : "endpoint";
        foreach (PublicHotReadPipelineStageDescriptor stage in stages)
        {
            if (string.IsNullOrWhiteSpace(stage.StageId)
                || !Enum.IsDefined(stage.Classification))
            {
                throw new InvalidOperationException(
                    $"public hot-read {pipeline} pipeline stage classification is invalid: {stage.StageId}");
            }

            if (stage.Classification != PublicHotReadPipelineStageClassification.CrossCuttingControl)
            {
                if (stage.ControlId is not null)
                {
                    throw new InvalidOperationException(
                        $"public hot-read non-control stage cannot declare a control id: {pipeline}:{stage.StageId}");
                }

                continue;
            }

            if (string.IsNullOrWhiteSpace(stage.ControlId)
                || !controls.Any(control =>
                    IsCatalogStage(control, stage, applicationPipeline)))
            {
                throw new InvalidOperationException(
                    $"public hot-read cross-cutting stage is not registered in the catalog: {pipeline}:{stage.StageId}:{stage.ControlId}");
            }
        }

        foreach (PublicHotReadCrossCuttingControl control in controls)
        {
            string? stageId = applicationPipeline
                ? control.GlobalStageId ?? control.EarlyStageId
                : control.EndpointStageId;
            if (stageId is null)
            {
                continue;
            }

            PublicHotReadPipelineStageDescriptor stage = stages.SingleOrDefault(candidate =>
                string.Equals(candidate.StageId, stageId, StringComparison.Ordinal));
            if (stage.StageId is null
                || stage.Classification != PublicHotReadPipelineStageClassification.CrossCuttingControl
                || !string.Equals(stage.ControlId, control.ControlId, StringComparison.Ordinal))
            {
                throw Invalid(control, $"{pipeline} stage is not explicitly classified and mapped: {stageId}");
            }
        }
    }

    private static bool IsCatalogStage(
        PublicHotReadCrossCuttingControl control,
        PublicHotReadPipelineStageDescriptor stage,
        bool applicationPipeline)
        => string.Equals(control.ControlId, stage.ControlId, StringComparison.Ordinal)
            && (applicationPipeline
                ? string.Equals(control.GlobalStageId ?? control.EarlyStageId, stage.StageId, StringComparison.Ordinal)
                : string.Equals(control.EndpointStageId, stage.StageId, StringComparison.Ordinal));

    private static InvalidOperationException Invalid(
        PublicHotReadCrossCuttingControl control,
        string detail)
        => new($"public hot-read cross-cutting control invalid: {control.ControlId}: {detail}");
}
