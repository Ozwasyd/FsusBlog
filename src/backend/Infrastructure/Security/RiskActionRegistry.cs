using FsusBlog.Shared.Contracts.Security;

using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.Security;

/// <summary>
/// Defines stable action identifiers shared by endpoint metadata, policy lookup, and audit telemetry.
/// </summary>
public static class RiskActionNames
{
    public const string PublicRead = "public.read";
    public const string CommentCreate = "comment.create";
    public const string CommentReply = "comment.reply";
    public const string AuthLogin = "auth.login";
    public const string AuthPasskeyBegin = "auth.passkey.begin";
    public const string AuthPasskeyComplete = "auth.passkey.complete";
    public const string RecoveryKeyVerify = "recovery-key.verify";
    public const string NotificationSubscribe = "notification.subscribe";
    public const string AdminSecurityWrite = "admin.security.write";
    public const string AdminCommentBatch = "admin.comment.batch";
}

/// <summary>
/// Describes one registered risk-controlled operation and its route-key requirements.
/// </summary>
public sealed record RiskAction
{
    /// <summary>
    /// Creates a normalized risk-action definition.
    /// </summary>
    /// <param name="name">Stable action identifier used for policy lookup.</param>
    /// <param name="description">Operator-facing description of the protected operation.</param>
    /// <param name="owner">Subsystem responsible for the action.</param>
    /// <param name="requiresRouteKey">Whether each endpoint must supply an explicit route key.</param>
    /// <param name="defaultRouteKey">Fallback route key for actions that do not require endpoint-specific metadata.</param>
    public RiskAction(
        string name,
        string description,
        string owner,
        bool requiresRouteKey,
        string? defaultRouteKey = null)
    {
        Name = NormalizeRequired(name, nameof(name));
        Description = NormalizeRequired(description, nameof(description));
        Owner = NormalizeRequired(owner, nameof(owner));
        RequiresRouteKey = requiresRouteKey;
        DefaultRouteKey = NormalizeOptional(defaultRouteKey);
        if (!RequiresRouteKey && string.IsNullOrWhiteSpace(DefaultRouteKey))
        {
            throw new ArgumentException("Risk action without a required routeKey must define a default routeKey.", nameof(defaultRouteKey));
        }
    }

    /// <summary>
    /// Gets the normalized action identifier.
    /// </summary>
    public string Name
    {
        get;
    }

    /// <summary>
    /// Gets the operator-facing description of the action.
    /// </summary>
    public string Description
    {
        get;
    }

    /// <summary>
    /// Gets the subsystem that owns the action contract.
    /// </summary>
    public string Owner
    {
        get;
    }

    /// <summary>
    /// Gets whether endpoint registration must provide a route-specific key.
    /// </summary>
    public bool RequiresRouteKey
    {
        get;
    }

    /// <summary>
    /// Gets the normalized fallback route key when endpoint-specific metadata is optional.
    /// </summary>
    public string? DefaultRouteKey
    {
        get;
    }

    private static string NormalizeRequired(string value, string name)
    {
        string normalized = (value ?? string.Empty).Trim();
        if (normalized.Length == 0)
        {
            throw new ArgumentException("Value is required.", name);
        }

        return normalized;
    }

    private static string? NormalizeOptional(string? value)
    {
        string normalized = (value ?? string.Empty).Trim();
        return normalized.Length == 0 ? null : normalized;
    }
}

/// <summary>
/// Carries the resolved risk action and route identity on an endpoint.
/// </summary>
/// <param name="ActionName">Registered action identifier.</param>
/// <param name="RouteKey">Policy route key associated with the endpoint.</param>
public sealed record RiskActionEndpointMetadata(string ActionName, string RouteKey)
{
    public const string HttpContextItemKey = "__fsus_risk_action_metadata";
}

/// <summary>
/// Describes a protected endpoint that is missing required risk-action metadata.
/// </summary>
/// <param name="EndpointDisplayName">Display name used to locate the endpoint.</param>
/// <param name="Reason">Machine-readable audit reason.</param>
public sealed record RiskActionEndpointAuditFinding(string EndpointDisplayName, string Reason);

/// <summary>
/// Validates risk-action definitions and resolves metadata for endpoint and policy consumers.
/// </summary>
public sealed class RiskActionRegistry
{
    private readonly Dictionary<string, RiskAction> _actions;

    private RiskActionRegistry(Dictionary<string, RiskAction> actions)
    {
        _actions = actions;
    }

    /// <summary>
    /// Gets the validated registry containing the platform's built-in risk actions.
    /// </summary>
    public static RiskActionRegistry Default { get; } = Create(DefaultActions());

    /// <summary>
    /// Identifies challenge policies completed by an action-specific handoff instead
    /// of the generic challenge executor and host registry.
    /// </summary>
    public static bool UsesSpecializedStepUp(string actionName, SecurityChallengeKind kind)
        => string.Equals(actionName, RiskActionNames.AdminSecurityWrite, StringComparison.Ordinal)
            && kind == SecurityChallengeKind.AdminPasskeyStepUpV1;

    /// <summary>
    /// Gets the registered action definitions.
    /// </summary>
    public IReadOnlyCollection<RiskAction> Actions => _actions.Values;

    /// <summary>
    /// Creates a registry after rejecting duplicate names and empty action sets.
    /// </summary>
    /// <param name="actions">Action definitions to validate and register.</param>
    /// <returns>A registry indexed with ordinal action-name semantics.</returns>
    public static RiskActionRegistry Create(IEnumerable<RiskAction> actions)
    {
        var registered = new Dictionary<string, RiskAction>(StringComparer.Ordinal);
        foreach (RiskAction action in actions)
        {
            if (!registered.TryAdd(action.Name, action))
            {
                throw new InvalidOperationException($"Duplicate RiskAction registration: {action.Name}");
            }
        }

        if (registered.Count == 0)
        {
            throw new InvalidOperationException("RiskActionRegistry requires at least one action.");
        }

        return new RiskActionRegistry(registered);
    }

    /// <summary>
    /// Attempts to resolve a normalized action name.
    /// </summary>
    /// <param name="actionName">Action identifier to resolve.</param>
    /// <param name="action">Receives the registered definition when found.</param>
    /// <returns><see langword="true"/> when the action exists; otherwise <see langword="false"/>.</returns>
    public bool TryGet(string actionName, out RiskAction action)
        => _actions.TryGetValue((actionName ?? string.Empty).Trim(), out action!);

    /// <summary>
    /// Resolves an action or rejects an unknown identifier.
    /// </summary>
    /// <param name="actionName">Action identifier to resolve.</param>
    /// <returns>The registered action definition.</returns>
    public RiskAction GetRequired(string actionName)
        => TryGet(actionName, out RiskAction? action)
            ? action
            : throw new InvalidOperationException($"Unknown RiskAction: {actionName}");

    /// <summary>
    /// Creates endpoint metadata using an explicit route key or the action's configured fallback.
    /// </summary>
    /// <param name="actionName">Registered action identifier.</param>
    /// <param name="routeKey">Optional endpoint-specific route key.</param>
    /// <returns>Validated endpoint metadata containing a non-empty route key.</returns>
    public RiskActionEndpointMetadata CreateMetadata(string actionName, string? routeKey = null)
    {
        RiskAction action = GetRequired(actionName);
        string resolvedRouteKey = string.IsNullOrWhiteSpace(routeKey)
            ? action.DefaultRouteKey ?? string.Empty
            : routeKey.Trim();
        if (resolvedRouteKey.Length == 0)
        {
            throw new InvalidOperationException($"RiskAction {action.Name} requires routeKey metadata.");
        }

        return new RiskActionEndpointMetadata(action.Name, resolvedRouteKey);
    }

    /// <summary>
    /// Attempts to read risk-action metadata from an endpoint.
    /// </summary>
    /// <param name="endpoint">Endpoint whose metadata collection is inspected.</param>
    /// <param name="metadata">Receives the resolved metadata when present.</param>
    /// <returns><see langword="true"/> when metadata is attached; otherwise <see langword="false"/>.</returns>
    public bool TryGetEndpointMetadata(Endpoint? endpoint, out RiskActionEndpointMetadata metadata)
    {
        metadata = endpoint?.Metadata.GetMetadata<RiskActionEndpointMetadata>()!;
        return metadata is not null;
    }

    /// <summary>
    /// Audits protected endpoints and reports those without risk-action metadata.
    /// </summary>
    /// <param name="endpoints">Endpoints included in the audit.</param>
    /// <param name="isProtectedEndpoint">Predicate that identifies endpoints requiring metadata.</param>
    /// <returns>Findings for protected endpoints whose metadata is missing.</returns>
    public IReadOnlyList<RiskActionEndpointAuditFinding> FindMissingActionMetadata(
        IEnumerable<Endpoint> endpoints,
        Func<Endpoint, bool> isProtectedEndpoint)
    {
        var findings = new List<RiskActionEndpointAuditFinding>();
        foreach (Endpoint endpoint in endpoints)
        {
            if (!isProtectedEndpoint(endpoint)
                || endpoint.Metadata.GetMetadata<RiskActionEndpointMetadata>() is not null)
            {
                continue;
            }

            findings.Add(new RiskActionEndpointAuditFinding(
                string.IsNullOrWhiteSpace(endpoint.DisplayName) ? "(unnamed endpoint)" : endpoint.DisplayName!,
                "missing-risk-action"));
        }

        return findings;
    }

    private static IReadOnlyList<RiskAction> DefaultActions()
        =>
        [
            new(RiskActionNames.PublicRead, "Public read path", "public-read", requiresRouteKey: true),
            new(RiskActionNames.CommentCreate, "Create root comment", "comments", requiresRouteKey: false, defaultRouteKey: "comment.create"),
            new(RiskActionNames.CommentReply, "Create comment reply", "comments", requiresRouteKey: false, defaultRouteKey: "comment.reply"),
            new(RiskActionNames.AuthLogin, "Password login", "auth", requiresRouteKey: false, defaultRouteKey: "auth.login"),
            new(RiskActionNames.AuthPasskeyBegin, "Passkey assertion begin", "auth", requiresRouteKey: false, defaultRouteKey: "auth.passkey.begin"),
            new(RiskActionNames.AuthPasskeyComplete, "Passkey assertion complete", "auth", requiresRouteKey: false, defaultRouteKey: "auth.passkey.complete"),
            new(RiskActionNames.RecoveryKeyVerify, "Recovery key verification", "auth", requiresRouteKey: false, defaultRouteKey: "recovery-key.verify"),
            new(RiskActionNames.NotificationSubscribe, "Notification stream subscribe", "notification-stream", requiresRouteKey: false, defaultRouteKey: "notification.subscribe"),
            new(RiskActionNames.AdminSecurityWrite, "Admin security policy write", "admin-security", requiresRouteKey: false, defaultRouteKey: "admin.security.write"),
            new(RiskActionNames.AdminCommentBatch, "Admin comment batch moderation", "admin-comment", requiresRouteKey: false, defaultRouteKey: "admin.comment.batch")
        ];
}

/// <summary>
/// Provides endpoint-convention helpers for attaching validated risk-action metadata.
/// </summary>
public static class RiskActionEndpointMetadataExtensions
{
    /// <summary>
    /// Attaches registry-validated risk-action metadata to an endpoint builder.
    /// </summary>
    /// <typeparam name="TBuilder">Endpoint convention builder type.</typeparam>
    /// <param name="builder">Builder receiving the metadata.</param>
    /// <param name="actionName">Registered action identifier.</param>
    /// <param name="routeKey">Optional route-specific policy key.</param>
    /// <returns>The original builder for fluent endpoint configuration.</returns>
    public static TBuilder WithRiskAction<TBuilder>(this TBuilder builder, string actionName, string? routeKey = null)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(RiskActionRegistry.Default.CreateMetadata(actionName, routeKey));
        return builder;
    }
}
