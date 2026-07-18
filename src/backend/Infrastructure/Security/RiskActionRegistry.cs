using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;

namespace FsusBlog.Server.Infrastructure.Security;

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

public sealed record RiskAction
{
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

    public string Name
    {
        get;
    }

    public string Description
    {
        get;
    }

    public string Owner
    {
        get;
    }

    public bool RequiresRouteKey
    {
        get;
    }

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

public sealed record RiskActionEndpointMetadata(string ActionName, string RouteKey)
{
    public const string HttpContextItemKey = "__fsus_risk_action_metadata";
}

public sealed record RiskActionEndpointAuditFinding(string EndpointDisplayName, string Reason);

public sealed class RiskActionRegistry
{
    private readonly Dictionary<string, RiskAction> _actions;

    private RiskActionRegistry(Dictionary<string, RiskAction> actions)
    {
        _actions = actions;
    }

    public static RiskActionRegistry Default { get; } = Create(DefaultActions());

    public IReadOnlyCollection<RiskAction> Actions => _actions.Values;

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

    public bool TryGet(string actionName, out RiskAction action)
        => _actions.TryGetValue((actionName ?? string.Empty).Trim(), out action!);

    public RiskAction GetRequired(string actionName)
        => TryGet(actionName, out RiskAction? action)
            ? action
            : throw new InvalidOperationException($"Unknown RiskAction: {actionName}");

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

    public bool TryGetEndpointMetadata(Endpoint? endpoint, out RiskActionEndpointMetadata metadata)
    {
        metadata = endpoint?.Metadata.GetMetadata<RiskActionEndpointMetadata>()!;
        return metadata is not null;
    }

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

public static class RiskActionEndpointMetadataExtensions
{
    public static TBuilder WithRiskAction<TBuilder>(this TBuilder builder, string actionName, string? routeKey = null)
        where TBuilder : IEndpointConventionBuilder
    {
        builder.WithMetadata(RiskActionRegistry.Default.CreateMetadata(actionName, routeKey));
        return builder;
    }
}
