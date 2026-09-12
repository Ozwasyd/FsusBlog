using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

public sealed class AuthoringWorkerCommandExecutionPort(
    IAuthoringActiveRuntimeCatalog runtimes,
    AuthoringExtensionWorkerSandbox worker,
    AuthoringExtensionBudgetSupervisor supervisor,
    IAuthoringRuntimeResourceLedger ledger) : IAuthoringCommandExecutionPort
{
    public AuthoringExecutionClass ExecutionClass => AuthoringExecutionClass.IsolatedWorkerWasm;

    public async ValueTask<AuthoringCommandExecutionResponse> ExecuteAsync(
        AuthoringCommandContribution command,
        AuthoringCommandExecutionContext context,
        CancellationToken cancellationToken)
    {
        ActiveAuthoringRuntime active = runtimes.Require(context.RuntimeIdentity);
        EnsureBinding(active, command);
        string policyDigest = Digest(string.Join('\n',
            command.CommandId,
            command.InputSchemaReference,
            command.ResultSchemaReference,
            string.Join(',', command.RequiredCapabilities.Order())));
        var request = new AuthoringWorkerRequest(
            1,
            context.RuntimeIdentity,
            command.ExtensionId,
            command.ExtensionVersion,
            command.PackageSha256,
            command.ContributionId,
            context.DocumentId,
            context.DocumentEpoch,
            context.SourceRevision,
            context.RequestId,
            command.InputSchemaReference,
            command.ResultSchemaReference,
            policyDigest,
            context.Deadline,
            [.. context.Input]);
        ledger.RecordBrokeredUsage(context.RuntimeIdentity, 0, 0, 0);
        AuthoringBudgetResult<AuthoringWorkerExecutionResult> supervised = await supervisor.ExecuteAsync(
            CreateBudgetIdentity(command, context, policyDigest),
            CreateBudget(active.Package),
            new WorkerOperation(worker, active, request, context.LifecycleGeneration),
            cancellationToken);
        if (supervised.Status != AuthoringBudgetStatus.Completed ||
            supervised.Value?.Status != AuthoringWorkerResultStatus.Completed ||
            supervised.Value.Response is null)
        {
            throw new AuthoringExtensionContractException(
                $"Authoring worker command failed closed: {supervised.StableReason}.");
        }

        AuthoringWorkerResponse response = supervised.Value.Response;
        return CreateResponse(command, context, response.Payload);
    }

    private sealed class WorkerOperation(
        AuthoringExtensionWorkerSandbox worker,
        ActiveAuthoringRuntime active,
        AuthoringWorkerRequest request,
        long lifecycleGeneration) : IAuthoringBudgetedRuntimeOperation<AuthoringWorkerExecutionResult>
    {
        public ValueTask<AuthoringWorkerExecutionResult> ExecuteAsync(CancellationToken cancellationToken) =>
            worker.ExecuteAsync(active.Package, active.Target, request, lifecycleGeneration, cancellationToken);
    }

    internal static void EnsureBinding(ActiveAuthoringRuntime active, AuthoringCommandContribution command)
    {
        if (!string.Equals(active.Target.RuntimeIdentity, command.RuntimeIdentity, StringComparison.Ordinal) ||
            !string.Equals(active.Target.ExtensionId, command.ExtensionId, StringComparison.Ordinal) ||
            !string.Equals(active.Target.ExtensionVersion, command.ExtensionVersion, StringComparison.Ordinal) ||
            !string.Equals(active.Target.PackageSha256, command.PackageSha256, StringComparison.Ordinal) ||
            !string.Equals(active.Target.ContributionId, command.ContributionId, StringComparison.Ordinal) ||
            active.Target.ExecutionClass != command.ExecutionClass)
        {
            throw new AuthoringExtensionContractException("Command runtime binding is stale or identity-drifted.");
        }
    }

    internal static AuthoringBudgetIdentity CreateBudgetIdentity(
        AuthoringCommandContribution command,
        AuthoringCommandExecutionContext context,
        string policyDigest) => new(
            context.RuntimeIdentity,
            command.ExtensionId,
            command.ExtensionVersion,
            command.PackageSha256,
            command.ContributionId,
            context.DocumentId,
            context.RequestId,
            context.LifecycleGeneration,
            policyDigest);

    internal static AuthoringResourceBudget CreateBudget(VerifiedAuthoringPackage package) =>
        AuthoringExtensionBudgetSupervisor.FromManifest(package.Contract.Manifest.Limits);

    internal static AuthoringCommandExecutionResponse CreateResponse(
        AuthoringCommandContribution command,
        AuthoringCommandExecutionContext context,
        ImmutableArray<byte> result) => new(
            context.RuntimeIdentity,
            context.RequestId,
            context.LifecycleGeneration,
            command.ResultSchemaReference,
            [.. result],
            AuthoringCommandMutationCodec.Decode(command.ResultSchemaReference, result));

    internal static string Digest(string value) =>
        Convert.ToHexStringLower(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
}

public sealed class AuthoringServiceCommandExecutionPort(
    IAuthoringActiveRuntimeCatalog runtimes,
    IAuthoringCapabilityGrantCatalog grants,
    AuthoringExtensionServiceBroker service,
    AuthoringExtensionBudgetSupervisor supervisor,
    IAuthoringRuntimeResourceLedger ledger) : IAuthoringCommandExecutionPort
{
    public AuthoringExecutionClass ExecutionClass => AuthoringExecutionClass.OutOfProcessService;

    public async ValueTask<AuthoringCommandExecutionResponse> ExecuteAsync(
        AuthoringCommandContribution command,
        AuthoringCommandExecutionContext context,
        CancellationToken cancellationToken)
    {
        ActiveAuthoringRuntime active = runtimes.Require(context.RuntimeIdentity);
        AuthoringWorkerCommandExecutionPort.EnsureBinding(active, command);
        ImmutableArray<AuthoringCapabilityGrant> activeGrants = await grants.FindActiveExactAsync(
            command.ExtensionId,
            command.ExtensionVersion,
            command.ContributionId,
            command.RuntimeIdentity,
            command.ExecutionClass,
            context.DocumentId,
            cancellationToken);
        ImmutableArray<string> grantIds =
        [
            .. activeGrants
                .Where(grant => context.GrantedCapabilities.Contains(grant.Capability))
                .Select(static grant => grant.GrantId)
                .Distinct(StringComparer.Ordinal)
                .Order(StringComparer.Ordinal)
        ];
        string policyDigest = AuthoringWorkerCommandExecutionPort.Digest(string.Join('\n',
            command.CommandId,
            command.InputSchemaReference,
            command.ResultSchemaReference,
            string.Join(',', grantIds)));
        var request = new AuthoringServiceRequest(
            1,
            context.RuntimeIdentity,
            command.ExtensionId,
            command.ExtensionVersion,
            command.PackageSha256,
            command.ContributionId,
            context.DocumentId,
            context.DocumentEpoch,
            context.SourceRevision,
            context.RequestId,
            context.Deadline,
            grantIds,
            [.. context.Input]);
        ledger.RecordBrokeredUsage(context.RuntimeIdentity, 0, 0, 0);
        AuthoringBudgetResult<AuthoringServiceExecutionResult> supervised = await supervisor.ExecuteAsync(
            AuthoringWorkerCommandExecutionPort.CreateBudgetIdentity(command, context, policyDigest),
            AuthoringWorkerCommandExecutionPort.CreateBudget(active.Package),
            new ServiceOperation(service, active, request, context.LifecycleGeneration),
            cancellationToken);
        if (supervised.Status != AuthoringBudgetStatus.Completed ||
            supervised.Value?.Status != AuthoringServiceResultStatus.Completed ||
            supervised.Value.Response is null)
        {
            throw new AuthoringExtensionContractException(
                $"Authoring service command failed closed: {supervised.StableReason}.");
        }

        return AuthoringWorkerCommandExecutionPort.CreateResponse(
            command,
            context,
            supervised.Value.Response.Payload);
    }

    private sealed class ServiceOperation(
        AuthoringExtensionServiceBroker service,
        ActiveAuthoringRuntime active,
        AuthoringServiceRequest request,
        long lifecycleGeneration) : IAuthoringBudgetedRuntimeOperation<AuthoringServiceExecutionResult>
    {
        public ValueTask<AuthoringServiceExecutionResult> ExecuteAsync(CancellationToken cancellationToken) =>
            service.ExecuteAsync(active.Package, active.Target, request, lifecycleGeneration, cancellationToken);
    }
}

internal static class AuthoringCommandMutationCodec
{
    private static readonly JsonSerializerOptions s_json = new()
    {
        MaxDepth = 16,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        PropertyNameCaseInsensitive = false,
        ReadCommentHandling = JsonCommentHandling.Disallow,
        UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow
    };

    public static AuthoringMutationPlan? Decode(
        string resultSchemaReference,
        ImmutableArray<byte> result)
    {
        if (!string.Equals(resultSchemaReference, "authoring-command-mutation/v1", StringComparison.Ordinal))
        {
            return null;
        }

        try
        {
            using JsonDocument document = JsonDocument.Parse(result.ToArray(), new JsonDocumentOptions
            {
                CommentHandling = JsonCommentHandling.Disallow,
                MaxDepth = 16
            });
            RejectDuplicateProperties(document.RootElement);
            return JsonSerializer.Deserialize<AuthoringMutationPlan>(result.AsSpan(), s_json) ??
                throw new AuthoringExtensionContractException("Command mutation result is empty.");
        }
        catch (JsonException)
        {
            throw new AuthoringExtensionContractException("Command mutation result is not closed JSON.");
        }
    }

    private static void RejectDuplicateProperties(JsonElement element)
    {
        if (element.ValueKind == JsonValueKind.Object)
        {
            var names = new HashSet<string>(StringComparer.Ordinal);
            foreach (JsonProperty property in element.EnumerateObject())
            {
                if (!names.Add(property.Name))
                {
                    throw new AuthoringExtensionContractException(
                        "Command mutation result contains a duplicate property.");
                }

                RejectDuplicateProperties(property.Value);
            }
        }
        else if (element.ValueKind == JsonValueKind.Array)
        {
            foreach (JsonElement item in element.EnumerateArray())
            {
                RejectDuplicateProperties(item);
            }
        }
    }
}
