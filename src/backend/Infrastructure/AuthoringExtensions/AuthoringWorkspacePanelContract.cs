using System.Collections.Immutable;
using System.Diagnostics.CodeAnalysis;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public enum AuthoringWorkspacePanelRole
{
    ReadOnlySummary = 0, HostCommandList = 1
}
public enum AuthoringWorkspacePanelViewport
{
    Desktop = 0, Compact = 1, Mobile = 2
}
public enum AuthoringWorkspacePanelMobilePolicy
{
    Unsupported = 0, RequireHostDrawer = 1
}
public enum AuthoringWorkspacePanelVisibility
{
    Visible = 0, Hidden = 1, Collapsed = 2, Offscreen = 3
}
public enum AuthoringWorkspacePanelLifecyclePolicy
{
    ReleaseOnHideCancelOnIdentityChange = 0
}
public enum AuthoringWorkspacePanelNodeKind
{
    Text = 0, Pair = 1, Status = 2, CommandReference = 3
}
public enum AuthoringWorkspacePanelTone
{
    Information = 0, Warning = 1, Error = 2
}
public enum AuthoringWorkspacePanelAdmissionStatus
{
    Admitted = 0, Disabled = 1, PermissionRequired = 2, Hidden = 3,
    UnsupportedPlatform = 4, UnsupportedViewport = 5, HostDrawerRequired = 6,
    SizeUnavailable = 7, EditorWidthUnavailable = 8, ActiveLimit = 9,
    ResourceLimit = 10, UnsupportedRole = 11
}

/// <summary>Host logical layout units, never CSS or persisted workspace geometry authority.</summary>
public sealed record AuthoringWorkspacePanelSize(int Inline, int Block);
public sealed record AuthoringWorkspacePanelResources(long ModelBytes, int Observers, int Timers, int NetworkRequests, int Workers, int Processes);
public sealed record AuthoringWorkspacePanelDeclaration(
    int SchemaVersion, string PanelId, string ExtensionId, string ExtensionVersion,
    string PackageSha256, string ContentSha256, string ContractIdentity, string ContributionId,
    string SlotId, AuthoringWorkspacePanelRole Role, AuthoringWorkspacePanelSize MinimumSize,
    AuthoringWorkspacePanelSize MaximumSize, AuthoringWorkspacePanelSize PreferredSize,
    string ReadModelSchema, ImmutableArray<string> CommandIds, ImmutableArray<AuthoringHostPlatform> Platforms,
    ImmutableArray<AuthoringWorkspacePanelViewport> Viewports, int MaximumNodes,
    AuthoringWorkspacePanelResources Budget, AuthoringWorkspacePanelLifecyclePolicy LifecyclePolicy, string DeclarationSha256);
public sealed record AuthoringWorkspacePanelBinding(
    string RuntimeIdentity, string WorkspaceId, string WorkspaceSnapshotSha256, string GroupId,
    string TabId, string DocumentId, long DocumentEpoch, long SourceRevision, long LifecycleGeneration, string RequestId);

/// <summary>Closed read-only values. Command IDs are host references, never callbacks or mutation payloads.</summary>
public sealed record AuthoringWorkspacePanelNode(
    string Id, AuthoringWorkspacePanelNodeKind Kind, string Text, string? Value, string? CommandId, AuthoringWorkspacePanelTone? Tone);
public sealed record AuthoringWorkspacePanelModel(
    int SchemaVersion, string PanelId, string DeclarationSha256, string ReadModelSchema,
    AuthoringWorkspacePanelBinding Binding, ImmutableArray<AuthoringWorkspacePanelNode> Nodes, string ModelSha256);

/// <summary>Host-supplied slot facts; this component invents no default or core slots.</summary>
public sealed record AuthoringWorkspacePanelSlot(
    string Id, AuthoringWorkspacePanelSize AvailableSize, ImmutableArray<AuthoringWorkspacePanelRole> Roles,
    ImmutableArray<AuthoringHostPlatform> Platforms, ImmutableArray<AuthoringWorkspacePanelViewport> Viewports,
    AuthoringWorkspacePanelMobilePolicy MobilePolicy, int ActivePanels, int MaximumActivePanels);

/// <summary>Actual post-zoom dimensions, remaining editor width for the proposed set, and observed host usage.</summary>
public sealed record AuthoringWorkspacePanelHostFacts(
    int SchemaVersion, AuthoringHostPlatform Platform, AuthoringWorkspacePanelViewport Viewport,
    AuthoringWorkspacePanelSize ViewportSize, int ZoomPercent, int EditorInline, int MinimumEditorInline,
    ImmutableArray<AuthoringWorkspacePanelSlot> Slots, ImmutableArray<string> CoreSlotIds,
    ImmutableArray<string> AllowedCommandIds, int ActivePanels, int MaximumActivePanels,
    AuthoringWorkspacePanelResources UsedResources, AuthoringWorkspacePanelResources MaximumResources, string HostFactsSha256);

/// <summary>Trusted host inputs are separate from plugin declaration/model payloads; they create no permission.</summary>
public sealed record AuthoringWorkspacePanelCandidate(
    VerifiedAuthoringExtensionContract Contract, AuthoringWorkspacePanelDeclaration Declaration,
    AuthoringWorkspacePanelModel Model, AuthoringWorkspacePanelBinding ExpectedBinding,
    bool ExtensionEnabled, bool HasReadPermission, AuthoringWorkspacePanelVisibility Visibility,
    AuthoringWorkspacePanelResources ObservedResources);

/// <summary>Content binding, not proof of host currentness, rendering, cleanup, or authorization.</summary>
public sealed record AuthoringWorkspacePanelAdmission(
    int SchemaVersion, string PanelId, string SlotId, AuthoringWorkspacePanelAdmissionStatus Status,
    string DeclarationSha256, string ModelSha256, string HostFactsSha256, string BindingSha256, string AdmissionSha256);

public static class AuthoringWorkspacePanelContract
{
    public const int CurrentVersion = 1;
    public const string ModelSchema = "fsusblog.authoring-workspace-panel-model.v1";
    public const int MaximumPanels = 1000;
    public const int MaximumNodes = 256;
    public const int MaximumTotalNodes = 4096;
    public const int MaximumPayloadBytes = 1024 * 1024;
    public const int MaximumTotalTextBytes = 16 * 1024 * 1024;
    private static readonly UTF8Encoding s_utf8 = new(false, true);
    private static readonly JsonSerializerOptions s_json = new()
    {
        MaxDepth = 16,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
        RespectRequiredConstructorParameters = true
    };

    public static AuthoringWorkspacePanelDeclaration ParseDeclaration(ReadOnlySpan<byte> json) => Snapshot(Parse<AuthoringWorkspacePanelDeclaration>(json));
    public static AuthoringWorkspacePanelModel ParseModel(ReadOnlySpan<byte> json) => Snapshot(Parse<AuthoringWorkspacePanelModel>(json));
    public static string ComputeDeclarationDigest(AuthoringWorkspacePanelDeclaration declaration) =>
        Digest("fsusblog.workspace-panel.declaration.v1", Snapshot(declaration) with
        {
            DeclarationSha256 = string.Empty
        });
    public static string ComputeModelDigest(AuthoringWorkspacePanelModel model) =>
        Digest("fsusblog.workspace-panel.model.v1", Snapshot(model) with
        {
            ModelSha256 = string.Empty
        });
    public static string ComputeHostDigest(AuthoringWorkspacePanelHostFacts host) =>
        Digest("fsusblog.workspace-panel.host-facts.v1", Snapshot(host) with
        {
            HostFactsSha256 = string.Empty
        });

    /// <summary>Validates the whole bounded set first, then consumes proposed capacity in ordinal panel order.</summary>
    public static ImmutableArray<AuthoringWorkspacePanelAdmission> AdmitSet(
        ImmutableArray<AuthoringWorkspacePanelCandidate> candidates, AuthoringWorkspacePanelHostFacts host)
    {
        Require(!candidates.IsDefault && candidates.Length <= MaximumPanels, "panel_set_bound");
        AuthoringWorkspacePanelHostFacts facts = Snapshot(host);
        Require(IsDigest(facts.HostFactsSha256) && facts.HostFactsSha256 == ComputeHostDigest(facts), "panel_host_digest");
        long textBytes = 0;
        int totalNodes = 0;
        foreach (AuthoringWorkspacePanelCandidate candidate in candidates)
        {
            Require(candidate?.Model is not null && !candidate.Model.Nodes.IsDefault && candidate.Model.Nodes.Length <= MaximumNodes, "panel_model_nodes");
            totalNodes += candidate.Model.Nodes.Length;
            Require(totalNodes <= MaximumTotalNodes, "panel_total_node_bound");
            foreach (AuthoringWorkspacePanelNode node in candidate.Model.Nodes)
            {
                Require(node is not null, "panel_node_missing");
                textBytes += TextBytes(node.Text);
                if (node.Value is not null)
                    textBytes += TextBytes(node.Value);
                Require(textBytes <= MaximumTotalTextBytes, "panel_total_text_bound");
            }
        }
        var prepared = new List<AuthoringWorkspacePanelCandidate>();
        var panels = new HashSet<string>(StringComparer.Ordinal);
        var contributions = new HashSet<(string Extension, string Contribution)>();
        var contracts = new Dictionary<VerifiedAuthoringExtensionContract, VerifiedAuthoringExtensionContract>(ReferenceEqualityComparer.Instance);
        foreach (AuthoringWorkspacePanelCandidate candidate in candidates)
        {
            Require(candidate.Contract?.Manifest is not null, "panel_contract_missing");
            if (!contracts.TryGetValue(candidate.Contract, out VerifiedAuthoringExtensionContract? verified))
            {
                AuthoringExtensionManifest manifest = candidate.Contract.Manifest;
                Require(!manifest.SupportedPlatforms.IsDefaultOrEmpty, "panel_contract_platform");
                verified = AuthoringExtensionContractValidator.Verify(manifest, manifest.SupportedPlatforms[0]);
                Require(verified.ContractIdentity == candidate.Contract.ContractIdentity && verified.RegistryIdentity == candidate.Contract.RegistryIdentity, "panel_contract_identity");
                contracts.Add(candidate.Contract, verified);
            }
            AuthoringWorkspacePanelDeclaration declaration = Snapshot(candidate.Declaration);
            AuthoringWorkspacePanelModel model = Snapshot(candidate.Model);
            ValidateBinding(candidate.ExpectedBinding);
            Require(Enum.IsDefined(candidate.Visibility), "panel_visibility");
            ValidateResources(candidate.ObservedResources);
            Require(panels.Add(declaration.PanelId) && contributions.Add((declaration.ExtensionId, declaration.ContributionId)), "panel_duplicate_registration");
            Require(IsDigest(declaration.DeclarationSha256) && declaration.DeclarationSha256 == ComputeDeclarationDigest(declaration), "panel_declaration_digest");
            Require(IsDigest(model.ModelSha256) && model.ModelSha256 == ComputeModelDigest(model), "panel_model_digest");
            Require(declaration.ExtensionId == verified.Manifest.Id && declaration.ExtensionVersion == verified.Manifest.Version &&
                declaration.PackageSha256 == verified.Manifest.PackageSha256 && declaration.ContentSha256 == verified.Manifest.ContentSha256 &&
                declaration.ContractIdentity == verified.ContractIdentity, "panel_package_binding");
            Require(verified.Manifest.Contributions.SingleOrDefault(item => item.Id == declaration.ContributionId)?.Kind == AuthoringContributionKind.WorkspacePanel, "panel_contribution_kind");
            Require(declaration.Platforms.All(verified.Manifest.SupportedPlatforms.Contains), "panel_platform_declaration");
            Require(declaration.Budget.ModelBytes <= verified.Manifest.Limits.MaximumResponseBytes && declaration.Budget.ModelBytes <= verified.Manifest.Limits.MemoryBytes, "panel_manifest_budget");
            Require(model.PanelId == declaration.PanelId && model.DeclarationSha256 == declaration.DeclarationSha256 && model.Binding == candidate.ExpectedBinding, "panel_instance_binding");
            Require(!facts.CoreSlotIds.Contains(declaration.SlotId, StringComparer.Ordinal) && facts.Slots.Any(slot => slot.Id == declaration.SlotId), "panel_slot_not_registered_or_core");
            Require(declaration.CommandIds.All(id => facts.AllowedCommandIds.Contains(id, StringComparer.Ordinal)) &&
                model.Nodes.Where(node => node.CommandId is not null).All(node => declaration.CommandIds.Contains(node.CommandId!, StringComparer.Ordinal)), "panel_command_not_registered");
            long nodeBytes = model.Nodes.IsEmpty ? 0 : JsonSerializer.SerializeToUtf8Bytes(model.Nodes, s_json).LongLength;
            Require(model.Nodes.Length <= declaration.MaximumNodes && nodeBytes <= declaration.Budget.ModelBytes &&
                nodeBytes <= candidate.ObservedResources.ModelBytes && Fits(candidate.ObservedResources, declaration.Budget), "panel_model_or_resource_bound");
            if (candidate.Visibility != AuthoringWorkspacePanelVisibility.Visible)
                Require(model.Nodes.IsEmpty && candidate.ObservedResources == ZeroResources(), "panel_hidden_resources_not_released");
            prepared.Add(candidate with
            {
                Contract = verified,
                Declaration = declaration,
                Model = model
            });
        }
        int active = facts.ActivePanels;
        var slotCounts = facts.Slots.ToDictionary(slot => slot.Id, slot => slot.ActivePanels, StringComparer.Ordinal);
        AuthoringWorkspacePanelResources used = facts.UsedResources;
        var results = ImmutableArray.CreateBuilder<AuthoringWorkspacePanelAdmission>();
        foreach (AuthoringWorkspacePanelCandidate candidate in prepared.OrderBy(item => item.Declaration.PanelId, StringComparer.Ordinal))
        {
            AuthoringWorkspacePanelDeclaration declaration = candidate.Declaration;
            AuthoringWorkspacePanelSlot slot = facts.Slots.Single(item => item.Id == declaration.SlotId);
            AuthoringWorkspacePanelAdmissionStatus status = Status(candidate, facts, slot, active, slotCounts[slot.Id], used);
            if (status == AuthoringWorkspacePanelAdmissionStatus.Admitted)
            {
                active++;
                slotCounts[slot.Id]++;
                used = Add(used, candidate.ObservedResources);
            }
            var result = new AuthoringWorkspacePanelAdmission(CurrentVersion, declaration.PanelId, declaration.SlotId, status,
                declaration.DeclarationSha256, candidate.Model.ModelSha256, facts.HostFactsSha256,
                Digest("fsusblog.workspace-panel.binding.v1", candidate.ExpectedBinding), string.Empty);
            results.Add(result with
            {
                AdmissionSha256 = Digest("fsusblog.workspace-panel.admission.v1", result)
            });
        }
        return results.ToImmutable();
    }

    private static AuthoringWorkspacePanelAdmissionStatus Status(AuthoringWorkspacePanelCandidate candidate,
        AuthoringWorkspacePanelHostFacts host, AuthoringWorkspacePanelSlot slot, int active, int slotActive, AuthoringWorkspacePanelResources used)
    {
        AuthoringWorkspacePanelDeclaration declaration = candidate.Declaration;
        if (!candidate.ExtensionEnabled)
            return AuthoringWorkspacePanelAdmissionStatus.Disabled;
        if (!candidate.HasReadPermission)
            return AuthoringWorkspacePanelAdmissionStatus.PermissionRequired;
        if (candidate.Visibility != AuthoringWorkspacePanelVisibility.Visible)
            return AuthoringWorkspacePanelAdmissionStatus.Hidden;
        if (!declaration.Platforms.Contains(host.Platform) || !slot.Platforms.Contains(host.Platform))
            return AuthoringWorkspacePanelAdmissionStatus.UnsupportedPlatform;
        if (!declaration.Viewports.Contains(host.Viewport) || !slot.Viewports.Contains(host.Viewport))
            return AuthoringWorkspacePanelAdmissionStatus.UnsupportedViewport;
        if (!slot.Roles.Contains(declaration.Role))
            return AuthoringWorkspacePanelAdmissionStatus.UnsupportedRole;
        if (host.Viewport == AuthoringWorkspacePanelViewport.Mobile)
            return slot.MobilePolicy == AuthoringWorkspacePanelMobilePolicy.RequireHostDrawer ? AuthoringWorkspacePanelAdmissionStatus.HostDrawerRequired : AuthoringWorkspacePanelAdmissionStatus.UnsupportedViewport;
        if (!Fits(declaration.PreferredSize, slot.AvailableSize))
            return AuthoringWorkspacePanelAdmissionStatus.SizeUnavailable;
        if (host.EditorInline < host.MinimumEditorInline)
            return AuthoringWorkspacePanelAdmissionStatus.EditorWidthUnavailable;
        if (active >= host.MaximumActivePanels || slotActive >= slot.MaximumActivePanels)
            return AuthoringWorkspacePanelAdmissionStatus.ActiveLimit;
        if (!Fits(declaration.Budget, host.MaximumResources) || !Fits(Add(used, candidate.ObservedResources), host.MaximumResources))
            return AuthoringWorkspacePanelAdmissionStatus.ResourceLimit;
        return AuthoringWorkspacePanelAdmissionStatus.Admitted;
    }

    private static AuthoringWorkspacePanelDeclaration Snapshot(AuthoringWorkspacePanelDeclaration declaration)
    {
        Require(declaration is not null && declaration.SchemaVersion == CurrentVersion, "panel_declaration_version");
        Identifier(declaration.PanelId);
        Identifier(declaration.ExtensionId);
        Identifier(declaration.ContributionId);
        Identifier(declaration.SlotId);
        Require(!declaration.PanelId.StartsWith("fsusblog.core.", StringComparison.Ordinal) && !declaration.SlotId.StartsWith("fsusblog.core.", StringComparison.Ordinal), "panel_core_identity");
        Require(IsField(declaration.ExtensionVersion, 64) && IsDigest(declaration.PackageSha256) && IsDigest(declaration.ContentSha256) && IsDigest(declaration.ContractIdentity), "panel_declaration_identity");
        Size(declaration.MinimumSize);
        Size(declaration.MaximumSize);
        Size(declaration.PreferredSize);
        Require(Fits(declaration.MinimumSize, declaration.PreferredSize) && Fits(declaration.PreferredSize, declaration.MaximumSize), "panel_size_order");
        Require(Enum.IsDefined(declaration.Role) && Enum.IsDefined(declaration.LifecyclePolicy) && declaration.ReadModelSchema == ModelSchema && declaration.MaximumNodes is >= 1 and <= MaximumNodes, "panel_declaration_closed");
        Ids(declaration.CommandIds, 64);
        Enums(declaration.Platforms);
        Enums(declaration.Viewports);
        ValidateResources(declaration.Budget);
        Require(declaration.Budget.ModelBytes > 0, "panel_model_budget_required");
        return declaration with
        {
            CommandIds = [.. declaration.CommandIds],
            Platforms = [.. declaration.Platforms],
            Viewports = [.. declaration.Viewports]
        };
    }

    private static AuthoringWorkspacePanelModel Snapshot(AuthoringWorkspacePanelModel model)
    {
        Require(model is not null && model.SchemaVersion == CurrentVersion && model.ReadModelSchema == ModelSchema, "panel_model_version");
        Identifier(model.PanelId);
        Require(IsDigest(model.DeclarationSha256), "panel_model_declaration_identity");
        ValidateBinding(model.Binding);
        Require(!model.Nodes.IsDefault && model.Nodes.Length <= MaximumNodes, "panel_model_nodes");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var commands = new HashSet<string>(StringComparer.Ordinal);
        foreach (AuthoringWorkspacePanelNode node in model.Nodes)
        {
            Require(node is not null, "panel_node_missing");
            Identifier(node.Id);
            Require(ids.Add(node.Id) && Enum.IsDefined(node.Kind), "panel_node_duplicate_or_unknown");
            _ = TextBytes(node.Text);
            if (node.Value is not null)
                _ = TextBytes(node.Value);
            if (node.CommandId is not null)
            {
                Identifier(node.CommandId);
                Require(commands.Add(node.CommandId), "panel_duplicate_command_reference");
            }
            bool closed = node.Kind switch
            {
                AuthoringWorkspacePanelNodeKind.Text => node.Value is null && node.CommandId is null && node.Tone is null,
                AuthoringWorkspacePanelNodeKind.Pair => node.Value is not null && node.CommandId is null && node.Tone is null,
                AuthoringWorkspacePanelNodeKind.Status => node.Value is null && node.CommandId is null && node.Tone is not null && Enum.IsDefined(node.Tone.Value),
                AuthoringWorkspacePanelNodeKind.CommandReference => node.Value is null && node.CommandId is not null && node.Tone is null,
                _ => false
            };
            Require(closed, "panel_node_union");
        }
        return model with
        {
            Nodes = [.. model.Nodes]
        };
    }

    private static AuthoringWorkspacePanelHostFacts Snapshot(AuthoringWorkspacePanelHostFacts host)
    {
        Require(host is not null && host.SchemaVersion == CurrentVersion && Enum.IsDefined(host.Platform) && Enum.IsDefined(host.Viewport), "panel_host_version");
        Size(host.ViewportSize);
        Require(host.ZoomPercent is >= 50 and <= 400 && host.EditorInline is >= 1 and <= 16384 && host.MinimumEditorInline is >= 1 and <= 16384 && host.EditorInline <= host.ViewportSize.Inline, "panel_host_dimensions");
        Require(!host.Slots.IsDefault && host.Slots.Length <= 64 && host.MaximumActivePanels is >= 0 and <= 32 && host.ActivePanels >= 0 && host.ActivePanels <= host.MaximumActivePanels, "panel_host_active_bound");
        Ids(host.CoreSlotIds, 256);
        Ids(host.AllowedCommandIds, 1000);
        ValidateResources(host.UsedResources);
        ValidateResources(host.MaximumResources);
        Require(Fits(host.UsedResources, host.MaximumResources), "panel_host_resource_usage");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        var slots = ImmutableArray.CreateBuilder<AuthoringWorkspacePanelSlot>();
        foreach (AuthoringWorkspacePanelSlot slot in host.Slots)
        {
            Require(slot is not null, "panel_host_slot_missing");
            Identifier(slot.Id);
            Size(slot.AvailableSize);
            Require(ids.Add(slot.Id) && !host.CoreSlotIds.Contains(slot.Id, StringComparer.Ordinal) && !slot.Id.StartsWith("fsusblog.core.", StringComparison.Ordinal), "panel_host_slot_duplicate_or_core");
            Enums(slot.Roles);
            Enums(slot.Platforms);
            Enums(slot.Viewports);
            Require(Enum.IsDefined(slot.MobilePolicy) && Fits(slot.AvailableSize, host.ViewportSize) && slot.MaximumActivePanels is >= 0 and <= 32 && slot.ActivePanels >= 0 && slot.ActivePanels <= slot.MaximumActivePanels, "panel_host_slot_bound");
            slots.Add(slot with
            {
                Roles = [.. slot.Roles],
                Platforms = [.. slot.Platforms],
                Viewports = [.. slot.Viewports]
            });
        }
        Require(host.Slots.Sum(slot => slot.ActivePanels) == host.ActivePanels, "panel_host_count_mismatch");
        return host with
        {
            Slots = slots.ToImmutable(),
            CoreSlotIds = [.. host.CoreSlotIds],
            AllowedCommandIds = [.. host.AllowedCommandIds]
        };
    }

    private static T Parse<T>(ReadOnlySpan<byte> json)
    {
        Require(!json.IsEmpty && json.Length <= MaximumPayloadBytes, "panel_json_bound");
        try
        {
            using JsonDocument document = JsonDocument.Parse(json.ToArray(), new JsonDocumentOptions { MaxDepth = 16 });
            RejectDuplicates(document.RootElement);
            return document.Deserialize<T>(s_json) ?? throw new AuthoringExtensionContractException("panel_json_missing");
        }
        catch (JsonException)
        {
            throw new AuthoringExtensionContractException("panel_json_not_closed");
        }
    }
    private static void RejectDuplicates(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                Require(names.Add(property.Name), "panel_json_duplicate");
                RejectDuplicates(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
            foreach (JsonElement item in element.EnumerateArray())
                RejectDuplicates(item);
    }
    private static void ValidateBinding(AuthoringWorkspacePanelBinding binding)
    {
        Require(binding is not null && IsDigest(binding.RuntimeIdentity) && IsDigest(binding.WorkspaceSnapshotSha256) && binding.DocumentEpoch >= 1 && binding.SourceRevision >= 0 && binding.LifecycleGeneration >= 1, "panel_binding_identity");
        foreach (string value in new[] { binding.WorkspaceId, binding.GroupId, binding.TabId, binding.DocumentId, binding.RequestId })
            Require(IsField(value, 256), "panel_binding_field");
    }
    private static long TextBytes(string? text)
    {
        Require(text is not null && text.Length is >= 1 and <= 4096 && !text.Any(character => char.IsControl(character) && character is not ('\n' or '\t')) && text.IndexOfAny(['<', '>', '{', '}']) < 0, "panel_plain_text_required");
        string compact = string.Concat(text.Where(character => !char.IsWhiteSpace(character))).ToLowerInvariant();
        Require(!new[] { "javascript:", "data:", "url(", "expression(", "@import", "style=", "position:", "z-index:", "display:", "background:", "color:" }.Any(compact.Contains), "panel_style_or_executable_text");
        try
        {
            return s_utf8.GetByteCount(text);
        }
        catch (EncoderFallbackException)
        {
            throw new AuthoringExtensionContractException("panel_invalid_unicode");
        }
    }
    private static void ValidateResources(AuthoringWorkspacePanelResources resources) => Require(resources is not null && resources.ModelBytes is >= 0 and <= MaximumTotalTextBytes && resources.Observers is >= 0 and <= 64 && resources.Timers is >= 0 and <= 64 && resources.NetworkRequests is >= 0 and <= 16 && resources.Workers is >= 0 and <= 8 && resources.Processes is >= 0 and <= 8, "panel_resource_bound");
    private static AuthoringWorkspacePanelResources ZeroResources() => new(0, 0, 0, 0, 0, 0);
    private static AuthoringWorkspacePanelResources Add(AuthoringWorkspacePanelResources left, AuthoringWorkspacePanelResources right) => new(left.ModelBytes + right.ModelBytes, left.Observers + right.Observers, left.Timers + right.Timers, left.NetworkRequests + right.NetworkRequests, left.Workers + right.Workers, left.Processes + right.Processes);
    private static bool Fits(AuthoringWorkspacePanelResources value, AuthoringWorkspacePanelResources bound) => value.ModelBytes <= bound.ModelBytes && value.Observers <= bound.Observers && value.Timers <= bound.Timers && value.NetworkRequests <= bound.NetworkRequests && value.Workers <= bound.Workers && value.Processes <= bound.Processes;
    private static bool Fits(AuthoringWorkspacePanelSize value, AuthoringWorkspacePanelSize bound) => value.Inline <= bound.Inline && value.Block <= bound.Block;
    private static void Size(AuthoringWorkspacePanelSize size) => Require(size is not null && size.Inline is >= 1 and <= 16384 && size.Block is >= 1 and <= 16384, "panel_size_bound");
    private static bool IsDigest(string? value) => value is { Length: 64 } && value.All(character => character is >= '0' and <= '9' or >= 'a' and <= 'f');
    private static bool IsField(string? value, int length) => !string.IsNullOrWhiteSpace(value) && value.Length <= length && value == value.Trim() && !value.Any(char.IsControl) && ValidUnicode(value);
    private static bool ValidUnicode(string value)
    {
        try
        {
            _ = s_utf8.GetByteCount(value);
            return true;
        }
        catch (EncoderFallbackException)
        {
            return false;
        }
    }
    private static void Identifier(string? value) => Require(IsField(value, 128) && value![0] is >= 'a' and <= 'z' && value.All(character => character is >= 'a' and <= 'z' or >= '0' and <= '9' or '.' or '-' or '_'), "panel_identifier");
    private static void Ids(ImmutableArray<string> values, int maximum)
    {
        Require(!values.IsDefault && values.Length <= maximum && values.Distinct(StringComparer.Ordinal).Count() == values.Length, "panel_id_roster");
        foreach (string value in values)
            Identifier(value);
    }
    private static void Enums<T>(ImmutableArray<T> values) where T : struct, Enum => Require(!values.IsDefaultOrEmpty && values.Length <= Enum.GetValues<T>().Length && values.Distinct().Count() == values.Length && values.All(Enum.IsDefined), "panel_enum_roster");
    private static string Digest<T>(string domain, T value)
    {
        byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(new
        {
            Domain = domain,
            Value = value
        }, s_json);
        Require(bytes.Length <= MaximumPayloadBytes, "panel_typed_payload_bound");
        return Convert.ToHexStringLower(SHA256.HashData(bytes));
    }
    private static void Require([DoesNotReturnIf(false)] bool condition, string code)
    {
        if (!condition)
            throw new AuthoringExtensionContractException(code);
    }
}
