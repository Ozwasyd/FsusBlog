using System.Collections.Immutable;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringCommandCategory
{
    Edit = 0,
    Format = 1,
    Insert = 2,
    Navigate = 3,
    Validate = 4,
    ImportExport = 5
}

public enum AuthoringCommandSurface
{
    Toolbar = 0,
    CommandPalette = 1,
    SlashMenu = 2,
    SelectionMenu = 3
}

public enum AuthoringCommandContextFact
{
    HasSelection = 0,
    IsDocumentWritable = 1,
    IsSourceMode = 2,
    IsOnline = 3,
    IsExtensionEnabled = 4
}

public enum AuthoringCommandContextOperator
{
    IsTrue = 0,
    IsFalse = 1
}

public enum AuthoringShortcutModifier
{
    Control = 0,
    Alt = 1,
    Shift = 2,
    Meta = 3
}

public sealed record AuthoringCommandLocalization(
    string LabelReference,
    string DescriptionReference,
    ImmutableArray<string> KeywordReferences);

public sealed record AuthoringCommandContextCondition(
    AuthoringCommandContextFact Fact,
    AuthoringCommandContextOperator Operator);

public sealed record AuthoringShortcutRequest(
    ImmutableArray<AuthoringShortcutModifier> Modifiers,
    string Key);

public sealed record AuthoringCommandContribution(
    string CommandId,
    string ExtensionId,
    string ExtensionVersion,
    string ContributionId,
    string PackageSha256,
    string ContentSha256,
    string RuntimeIdentity,
    AuthoringExecutionClass ExecutionClass,
    AuthoringCommandLocalization Localization,
    AuthoringCommandCategory Category,
    ImmutableArray<AuthoringCommandContextCondition> When,
    ImmutableArray<AuthoringCapability> RequiredCapabilities,
    string InputSchemaReference,
    string ResultSchemaReference,
    ImmutableArray<AuthoringCommandSurface> PreferredSurfaces,
    AuthoringShortcutRequest? Shortcut);

public sealed record AuthoringShortcutDecision(
    bool Accepted,
    string? CanonicalShortcut,
    string? StableReason);

public sealed record AuthoringCommandState(
    string CommandId,
    long Generation,
    bool Enabled,
    bool Pending,
    string? DisabledReason,
    string? ErrorCode);

public sealed record AuthoringCommandContextSnapshot(
    long LifecycleGeneration,
    ImmutableDictionary<AuthoringCommandContextFact, bool> Facts,
    ImmutableHashSet<AuthoringCapability> GrantedCapabilities,
    bool Pending,
    string? ErrorCode);

public sealed record AuthoringCommandAvailability(
    bool Visible,
    AuthoringCommandState State);

public sealed record AuthoringCommandProjection(
    AuthoringCommandSurface Surface,
    AuthoringCommandContribution Contribution,
    AuthoringCommandState State,
    AuthoringShortcutDecision Shortcut);

public sealed record AuthoringCommandExecutionContext(
    string RuntimeIdentity,
    string DocumentId,
    long DocumentEpoch,
    long SourceRevision,
    string SelectionIdentity,
    string RequestId,
    long LifecycleGeneration,
    DateTimeOffset Deadline,
    ImmutableHashSet<AuthoringCapability> GrantedCapabilities,
    ImmutableArray<byte> Input);

public sealed record AuthoringCommandExecutionResponse(
    string RuntimeIdentity,
    string RequestId,
    long LifecycleGeneration,
    string ResultSchemaReference,
    ImmutableArray<byte> Result,
    AuthoringMutationPlan? MutationPlan);

public interface IAuthoringCommandExecutionPort
{
    AuthoringExecutionClass ExecutionClass
    {
        get;
    }

    ValueTask<AuthoringCommandExecutionResponse> ExecuteAsync(
        AuthoringCommandContribution command,
        AuthoringCommandExecutionContext context,
        CancellationToken cancellationToken);
}

public sealed class AuthoringCommandRegistry
{
    public const int MaximumCommands = 1000;

    private readonly ImmutableDictionary<string, AuthoringCommandContribution> _commands;
    private readonly ImmutableHashSet<string> _reservedCommandIds;
    private readonly ImmutableHashSet<string> _reservedShortcuts;

    public AuthoringCommandRegistry(
        ImmutableArray<AuthoringCommandContribution> commands,
        ImmutableHashSet<string> coreCommandIds,
        ImmutableHashSet<string> coreOrUserShortcuts)
    {
        if (commands.IsDefault || commands.Length > MaximumCommands)
        {
            throw new AuthoringExtensionContractException("Command contribution count is outside its bound.");
        }

        _reservedCommandIds = coreCommandIds.WithComparer(StringComparer.Ordinal);
        _reservedShortcuts = coreOrUserShortcuts.WithComparer(StringComparer.OrdinalIgnoreCase);
        var builder = ImmutableDictionary.CreateBuilder<string, AuthoringCommandContribution>(StringComparer.Ordinal);
        foreach (AuthoringCommandContribution command in commands)
        {
            Validate(command);
            if (_reservedCommandIds.Contains(command.CommandId) || !builder.TryAdd(command.CommandId, command))
            {
                throw new AuthoringExtensionContractException("Command ID conflicts with core or another contribution.");
            }
        }

        _commands = builder.ToImmutable();
    }

    public AuthoringCommandContribution Get(string commandId) =>
        _commands.GetValueOrDefault(commandId) ??
        throw new AuthoringExtensionContractException("Command contribution is not registered.");

    public ImmutableArray<AuthoringCommandContribution> Search(string query, int maximumResults)
    {
        if (query is null || maximumResults is < 1 or > 100 || query.Length > 256)
        {
            throw new AuthoringExtensionContractException("Command search request is outside its bound.");
        }

        return
        [
            .. _commands.Values
                .Where(command => command.CommandId.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    command.Localization.LabelReference.Contains(query, StringComparison.OrdinalIgnoreCase) ||
                    command.Localization.KeywordReferences.Any(keyword => keyword.Contains(query, StringComparison.OrdinalIgnoreCase)))
                .OrderBy(static command => command.CommandId, StringComparer.Ordinal)
                .Take(maximumResults)
        ];
    }

    public ImmutableDictionary<AuthoringCommandCategory, ImmutableArray<AuthoringCommandContribution>> GroupByCategory() =>
        _commands.Values
            .GroupBy(static command => command.Category)
            .ToImmutableDictionary(
                static group => group.Key,
                static group => group.OrderBy(static command => command.CommandId, StringComparer.Ordinal).ToImmutableArray());

    public AuthoringShortcutDecision ResolveShortcut(AuthoringCommandContribution command)
    {
        if (!Equals(Get(command.CommandId), command))
        {
            throw new AuthoringExtensionContractException("Shortcut request identity drifted from the registered command.");
        }

        if (command.Shortcut is null)
        {
            return new AuthoringShortcutDecision(false, null, "shortcut-not-requested");
        }

        string canonical = string.Join('+',
            command.Shortcut.Modifiers.OrderBy(static modifier => modifier).Select(static modifier => modifier.ToString()).Append(command.Shortcut.Key));
        return _reservedShortcuts.Contains(canonical)
            ? new AuthoringShortcutDecision(false, null, "shortcut-conflicts-with-core-or-user")
            : new AuthoringShortcutDecision(true, canonical, null);
    }

    public ImmutableArray<AuthoringCommandProjection> Project(
        string commandId,
        AuthoringCommandState state)
    {
        AuthoringCommandContribution command = Get(commandId);
        if (!string.Equals(state.CommandId, commandId, StringComparison.Ordinal))
        {
            throw new AuthoringExtensionContractException("Command state identity does not match its contribution.");
        }

        AuthoringShortcutDecision shortcut = ResolveShortcut(command);
        return
        [
            .. command.PreferredSurfaces.Select(surface =>
                new AuthoringCommandProjection(surface, command, state, shortcut))
        ];
    }

    public AuthoringCommandAvailability Evaluate(
        string commandId,
        AuthoringCommandContextSnapshot context)
    {
        AuthoringCommandContribution command = Get(commandId);
        if (context.LifecycleGeneration < 1 || context.Facts is null || context.GrantedCapabilities is null ||
            context.Facts.Keys.Any(static fact => !Enum.IsDefined(fact)) ||
            context.GrantedCapabilities.Any(static capability => !Enum.IsDefined(capability)) ||
            (context.ErrorCode is not null &&
                (string.IsNullOrWhiteSpace(context.ErrorCode) || context.ErrorCode.Length > 128)))
        {
            throw new AuthoringExtensionContractException("Command context is unknown, unbounded, or not lifecycle-bound.");
        }

        bool extensionEnabled = context.Facts.GetValueOrDefault(AuthoringCommandContextFact.IsExtensionEnabled);
        bool visible = command.When.All(condition =>
        {
            bool value = context.Facts.GetValueOrDefault(condition.Fact);
            return condition.Operator == AuthoringCommandContextOperator.IsTrue ? value : !value;
        });
        string? disabledReason = !extensionEnabled
            ? "extension-not-enabled"
            : !visible
                ? "command-context-not-satisfied"
                : command.RequiredCapabilities.Any(capability => !context.GrantedCapabilities.Contains(capability))
                    ? "command-permission-insufficient"
                    : context.Pending
                        ? "command-pending"
                        : context.ErrorCode is not null
                            ? "command-error"
                            : null;
        return new AuthoringCommandAvailability(
            visible,
            new AuthoringCommandState(
                command.CommandId,
                context.LifecycleGeneration,
                disabledReason is null,
                context.Pending,
                disabledReason,
                context.ErrorCode));
    }

    public ImmutableArray<AuthoringCommandContribution> SelectForLifecycle(AuthoringLifecycleReceipt receipt)
    {
        if (receipt is null || string.IsNullOrWhiteSpace(receipt.ExtensionId) || receipt.Generation < 1)
        {
            throw new AuthoringExtensionContractException("Command lifecycle receipt is missing or invalid.");
        }

        if (receipt.State != AuthoringLifecycleState.Running)
        {
            return [];
        }

        return
        [
            .. _commands.Values
                .Where(command => string.Equals(command.ExtensionId, receipt.ExtensionId, StringComparison.Ordinal) &&
                    string.Equals(command.ExtensionVersion, receipt.Version, StringComparison.Ordinal) &&
                    string.Equals(command.PackageSha256, receipt.PackageSha256, StringComparison.Ordinal))
                .OrderBy(static command => command.CommandId, StringComparer.Ordinal)
        ];
    }

    private static void Validate(AuthoringCommandContribution command)
    {
        if (command is null ||
            !IsBoundedReference(command.CommandId, 256) ||
            !IsBoundedReference(command.ExtensionId, 128) ||
            !IsBoundedReference(command.ExtensionVersion, 64) ||
            !command.CommandId.StartsWith(command.ExtensionId + ".", StringComparison.Ordinal) ||
            command.CommandId.StartsWith("fsusblog.core.", StringComparison.Ordinal) ||
            !IsBoundedReference(command.ContributionId, 256) ||
            !IsDigest(command.PackageSha256) || !IsDigest(command.ContentSha256) || !IsDigest(command.RuntimeIdentity) ||
            command.ExecutionClass == AuthoringExecutionClass.TrustedHostAdapter ||
            !Enum.IsDefined(command.ExecutionClass) ||
            !Enum.IsDefined(command.Category) ||
            command.When.IsDefault || command.When.Length > 16 ||
            command.When.Distinct().Count() != command.When.Length ||
            command.When.Any(static condition =>
                condition is null || !Enum.IsDefined(condition.Fact) || !Enum.IsDefined(condition.Operator)) ||
            command.RequiredCapabilities.IsDefault ||
            command.RequiredCapabilities.Distinct().Count() != command.RequiredCapabilities.Length ||
            command.RequiredCapabilities.Any(static capability => !Enum.IsDefined(capability)) ||
            command.Localization is null ||
            !IsBoundedReference(command.Localization.LabelReference, 256) ||
            !IsBoundedReference(command.Localization.DescriptionReference, 256) ||
            command.Localization.KeywordReferences.IsDefault || command.Localization.KeywordReferences.Length > 32 ||
            command.Localization.KeywordReferences.Distinct(StringComparer.Ordinal).Count() !=
                command.Localization.KeywordReferences.Length ||
            command.Localization.KeywordReferences.Any(static reference => !IsBoundedReference(reference, 256)) ||
            !IsBoundedReference(command.InputSchemaReference, 256) ||
            !IsBoundedReference(command.ResultSchemaReference, 256) ||
            command.PreferredSurfaces.IsDefaultOrEmpty ||
            command.PreferredSurfaces.Distinct().Count() != command.PreferredSurfaces.Length ||
            command.PreferredSurfaces.Any(static surface => !Enum.IsDefined(surface)))
        {
            throw new AuthoringExtensionContractException("Command metadata is unknown, broad, duplicated, or not closed.");
        }

        if (command.Shortcut is not null &&
            (command.Shortcut.Modifiers.IsDefaultOrEmpty ||
            command.Shortcut.Modifiers.Distinct().Count() != command.Shortcut.Modifiers.Length ||
            command.Shortcut.Modifiers.Any(static modifier => !Enum.IsDefined(modifier)) ||
            command.Shortcut.Key is null || command.Shortcut.Key.Length != 1 || !char.IsLetterOrDigit(command.Shortcut.Key[0])))
        {
            throw new AuthoringExtensionContractException("Shortcut request is not a closed key chord.");
        }
    }

    private static bool IsBoundedReference(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && value == value.Trim() &&
        !value.Any(static character => char.IsControl(character));

    private static bool IsDigest(string? value) =>
        value is not null && value.Length == 64 && value.All(static character =>
            character is >= '0' and <= '9' or >= 'a' and <= 'f');
}

public sealed class AuthoringCommandExecutionCoordinator
{
    private readonly ImmutableDictionary<AuthoringExecutionClass, IAuthoringCommandExecutionPort> _ports;
    private readonly IAuthoringDocumentRevisionGate _revisionGate;
    private readonly AuthoringExtensionLifecycleCoordinator _lifecycle;
    private readonly IAuthoringCapabilityGrantCatalog _grants;
    private readonly TimeProvider _timeProvider;

    public AuthoringCommandExecutionCoordinator(
        ImmutableArray<IAuthoringCommandExecutionPort> ports,
        IAuthoringDocumentRevisionGate revisionGate,
        AuthoringExtensionLifecycleCoordinator lifecycle,
        IAuthoringCapabilityGrantCatalog grants,
        TimeProvider? timeProvider = null)
    {
        _ports = BuildPorts(ports);
        _revisionGate = revisionGate;
        _lifecycle = lifecycle;
        _grants = grants;
        _timeProvider = timeProvider ?? TimeProvider.System;
    }

    public async ValueTask<AuthoringCommandExecutionResponse> ExecuteAsync(
        AuthoringCommandContribution command,
        AuthoringCommandExecutionContext context,
        CancellationToken cancellationToken = default)
    {
        if (context.Input.IsDefault || context.Input.Length > 16 * 1024 * 1024 ||
            !string.Equals(context.RuntimeIdentity, command.RuntimeIdentity, StringComparison.Ordinal) ||
            context.DocumentEpoch < 1 || context.SourceRevision < 0 ||
            !IsBoundedContextIdentity(context.DocumentId, 256) ||
            !IsBoundedContextIdentity(context.SelectionIdentity, 1024) ||
            !IsBoundedContextIdentity(context.RequestId, 256) ||
            context.GrantedCapabilities is null ||
            context.GrantedCapabilities.Any(static capability => !Enum.IsDefined(capability)) ||
            !context.GrantedCapabilities.SetEquals(command.RequiredCapabilities) ||
            context.Deadline <= _timeProvider.GetUtcNow() ||
            !_ports.TryGetValue(command.ExecutionClass, out IAuthoringCommandExecutionPort? port))
        {
            throw new AuthoringExtensionContractException("Command execution binding is missing, stale, or unbounded.");
        }

        ImmutableArray<AuthoringCapabilityGrant> exactGrants = await _grants.FindActiveExactAsync(
            command.ExtensionId,
            command.ExtensionVersion,
            command.ContributionId,
            context.RuntimeIdentity,
            command.ExecutionClass,
            context.DocumentId,
            cancellationToken);
        ImmutableHashSet<AuthoringCapability> grantedCapabilities = exactGrants
            .Select(static grant => grant.Capability)
            .ToImmutableHashSet();
        ImmutableHashSet<string> exactGrantIds = exactGrants
            .Select(static grant => grant.GrantId)
            .ToImmutableHashSet(StringComparer.Ordinal);
        if (grantedCapabilities.Count != command.RequiredCapabilities.Length ||
            exactGrantIds.Count != exactGrants.Length ||
            command.RequiredCapabilities.Any(capability => !grantedCapabilities.Contains(capability)) ||
            context.GrantedCapabilities.Any(capability => !grantedCapabilities.Contains(capability)))
        {
            throw new AuthoringExtensionContractException(
                "Command capability scope is missing, revoked, expired, or bound to another document.");
        }

        cancellationToken.ThrowIfCancellationRequested();
        DateTimeOffset admissionTime = _timeProvider.GetUtcNow();
        if (admissionTime >= context.Deadline)
        {
            throw new AuthoringExtensionContractException("Command execution binding is missing, stale, or unbounded.");
        }

        using var deadlineCancellation = new CancellationTokenSource(
            context.Deadline - admissionTime,
            _timeProvider);
        using var executionCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            deadlineCancellation.Token);
        CancellationToken executionToken = executionCancellation.Token;

        if (!await _revisionGate.IsCurrentAsync(
                context.DocumentId,
                context.DocumentEpoch,
                context.SourceRevision,
                executionToken) ||
            !await _lifecycle.AcceptResultAsync(command.ExtensionId, context.LifecycleGeneration, executionToken))
        {
            throw new AuthoringExtensionContractException("Command execution context is stale or disabled.");
        }

        executionToken.ThrowIfCancellationRequested();
        if (_timeProvider.GetUtcNow() >= context.Deadline)
        {
            throw new AuthoringExtensionContractException("Command execution context is stale or disabled.");
        }

        AuthoringCommandExecutionResponse response = await port.ExecuteAsync(
            command,
            context with
            {
                Input = [.. context.Input]
            },
            executionToken);
        ImmutableArray<AuthoringCapabilityGrant> currentGrants = await _grants.FindActiveExactAsync(
            command.ExtensionId,
            command.ExtensionVersion,
            command.ContributionId,
            context.RuntimeIdentity,
            command.ExecutionClass,
            context.DocumentId,
            executionToken);
        ImmutableHashSet<string> currentGrantIds = currentGrants
            .Select(static grant => grant.GrantId)
            .ToImmutableHashSet(StringComparer.Ordinal);
        bool grantIdentityDrifted = currentGrantIds.Count != currentGrants.Length ||
            !exactGrantIds.SetEquals(currentGrantIds);
        if (!string.Equals(response.RuntimeIdentity, context.RuntimeIdentity, StringComparison.Ordinal) ||
            !string.Equals(response.RequestId, context.RequestId, StringComparison.Ordinal) ||
            response.LifecycleGeneration != context.LifecycleGeneration ||
            !string.Equals(response.ResultSchemaReference, command.ResultSchemaReference, StringComparison.Ordinal) ||
            response.Result.IsDefault || response.Result.Length > 16 * 1024 * 1024 ||
            grantIdentityDrifted ||
            _timeProvider.GetUtcNow() >= context.Deadline ||
            !await _revisionGate.IsCurrentAsync(
                context.DocumentId,
                context.DocumentEpoch,
                context.SourceRevision,
                executionToken) ||
            !await _lifecycle.AcceptResultAsync(command.ExtensionId, context.LifecycleGeneration, executionToken))
        {
            throw new AuthoringExtensionContractException("Command result is stale, drifted, or outside its closed schema.");
        }

        AuthoringCommandExecutionResponse acceptedResponse = response with
        {
            Result = [.. response.Result],
            MutationPlan = response.MutationPlan is null
                ? null
                : response.MutationPlan with
                {
                    Mutations = [.. response.MutationPlan.Mutations]
                }
        };

        executionToken.ThrowIfCancellationRequested();
        if (_timeProvider.GetUtcNow() >= context.Deadline)
        {
            throw new AuthoringExtensionContractException("Command result is stale, drifted, or outside its closed schema.");
        }

        return acceptedResponse;
    }

    private static bool IsBoundedContextIdentity(string? value, int maximumLength) =>
        !string.IsNullOrWhiteSpace(value) && value.Length <= maximumLength && value == value.Trim() &&
        !value.Any(static character => char.IsControl(character));

    private static ImmutableDictionary<AuthoringExecutionClass, IAuthoringCommandExecutionPort> BuildPorts(
        ImmutableArray<IAuthoringCommandExecutionPort> ports)
    {
        if (ports.IsDefaultOrEmpty || ports.Length > 2)
        {
            throw new AuthoringExtensionContractException("Command execution port registry is missing or outside its bound.");
        }

        var builder = ImmutableDictionary.CreateBuilder<AuthoringExecutionClass, IAuthoringCommandExecutionPort>();
        foreach (IAuthoringCommandExecutionPort port in ports)
        {
            if (port is null || !Enum.IsDefined(port.ExecutionClass) ||
                port.ExecutionClass == AuthoringExecutionClass.TrustedHostAdapter ||
                !builder.TryAdd(port.ExecutionClass, port))
            {
                throw new AuthoringExtensionContractException("Command execution port is duplicated, unknown, or host-trusted.");
            }
        }

        return builder.ToImmutable();
    }
}

public sealed class AuthoringCommandTransactionAdapter(AuthoringExtensionRpcAuthority rpcAuthority)
{
    public ValueTask<AuthoringTransactionReceipt> ApplyAsync(
        AuthoringRpcEnvelope envelope,
        AuthoringCommandExecutionResponse response,
        AuthoringMutationApproval approval,
        CancellationToken cancellationToken = default)
    {
        if (response.MutationPlan is null ||
            envelope.Method != AuthoringRpcMethod.MutationRequest ||
            !string.Equals(envelope.RequestId, response.RequestId, StringComparison.Ordinal) ||
            !Equals(envelope.Payload.MutationPlan, response.MutationPlan))
        {
            throw new AuthoringExtensionContractException("Command mutation result is not bound to the canonical transaction request.");
        }

        return rpcAuthority.ApplyMutationAsync(envelope, approval, cancellationToken);
    }
}
