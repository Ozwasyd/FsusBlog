using System.Collections.Immutable;
using System.Security.Cryptography;
using System.Text.Json;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>Content-free binding of one broker result to its original RPC context; not an approval.</summary>
public sealed record AuthoringRpcBrokerReceipt(
    AuthoringRpcEnvelope Context,
    string ProposalDigest,
    AuthoringServiceIoReceipt IoReceipt,
    string ReceiptDigest);

/// <summary>The authorized value is separate from its content-free receipt.</summary>
public sealed record AuthoringRpcBrokerResult(
    ImmutableArray<byte> Payload,
    AuthoringRpcBrokerReceipt Receipt);

// There is one RPC request-id owner and one actual IO broker. This handler
// neither issues grants nor accepts a caller-supplied destination/root grant.
internal sealed class AuthoringExtensionRpcIoBrokerHandler(
    AuthoringCapabilityGrantAuthority grants,
    IAuthoringDocumentRevisionGate revisionGate,
    TimeProvider timeProvider,
    AuthoringExecutionResolver? resolver,
    AuthoringExtensionServiceIoBroker? broker,
    HashSet<string> requestIds,
    Lock requestGate)
{
    internal async ValueTask<AuthoringRpcBrokerResult> ExecuteAsync(
        VerifiedAuthoringPackage package,
        AuthoringHostPlatform platform,
        AuthoringRpcEnvelope envelope,
        CancellationToken cancellationToken)
    {
        ArgumentNullException.ThrowIfNull(package);
        CheckBoundary(envelope, cancellationToken);
        if (resolver is null || broker is null)
        {
            throw new AuthoringExtensionContractException("Broker RPC requires the original resolver and IO broker.");
        }
        AuthoringCapability capability = Capability(envelope);
        VerifiedAuthoringExtensionContract contract = AuthoringExtensionContractValidator.Verify(package.Contract.Manifest, platform);
        if (contract.ContractIdentity != package.Contract.ContractIdentity ||
            contract.RegistryIdentity != package.Contract.RegistryIdentity ||
            !contract.Manifest.Contributions.Any(contribution => contribution.Id == envelope.ContributionId &&
                contribution.ExecutionClass == envelope.ExecutionClass && contribution.Capabilities.Contains(capability)))
        {
            throw new AuthoringExtensionContractException("Broker RPC capability is not declared by the exact verified package.");
        }
        package = package with
        {
            Contract = contract
        };
        AuthoringResourceLimits limits = contract.Manifest.Limits;
        ValidateProposal(envelope, limits);
        // Capture the complete proposal before the first await, including a
        // defensive byte copy even when ImmutableArray wraps caller storage.
        if (envelope.Payload.FileBroker is { } file && !file.ProposedBytes.IsDefault)
        {
            envelope = envelope with
            {
                Payload = envelope.Payload with
                {
                    FileBroker = file with
                    {
                        ProposedBytes = [.. file.ProposedBytes]
                    }
                }
            };
        }
        byte[] metadata = SerializeRequest(envelope, limits.MaximumObjectDepth);
        if (metadata.Length > limits.MaximumRequestBytes)
        {
            throw new AuthoringExtensionContractException("Broker RPC exceeds the declared request budget.");
        }
        string proposalDigest = Convert.ToHexStringLower(SHA256.HashData(metadata));
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        TimeSpan remaining = envelope.Deadline - timeProvider.GetUtcNow();
        if (remaining <= TimeSpan.Zero)
        {
            throw new AuthoringExtensionContractException("Broker RPC deadline has expired.");
        }
        deadline.CancelAfter(remaining < limits.WallClock ? remaining : limits.WallClock);
        CancellationToken token = deadline.Token;
        AuthoringServiceIoReceipt? staged = null;
        try
        {
            await RequireCurrentAsync(package, platform, envelope, capability, token);
            AuthoringServiceIoResult io;
            string approvedIoDigest;
            IAuthoringCapabilityBrokerGrantReadScope? effectScope = null;
            IAuthoringInstalledPackageReadScope? entryScope = null;
            Exception? effectFailure = null;
            try
            {
                // This same-store broker scope explicitly supports an async
                // lifetime. No package or second grant acquisition occurs while
                // it is held; revocation/replacement cannot race the IO.
                // Prepare the original non-thread-bound package lifetime first.
                // It remains held through actual IO settlement; a default
                // synchronous scope is refused rather than carried across IO.
                entryScope = await resolver.AcquireBrokerReadScopeAsync(package, token);
                await RequireAdmissionAfterPreparationAsync(envelope, capability, token);
                effectScope = grants.AcquireBrokerReadScope(envelope.GrantDigest, envelope, capability);
                ValidateApprovedScope(effectScope, envelope);
                approvedIoDigest = ScopeDigest(effectScope);
                using var grantDeadline = CancellationTokenSource.CreateLinkedTokenSource(token);
                DateTimeOffset authorityExpiry = effectScope.Grant.ExpiresAt < entryScope.ActivePackage.Trust.ValidUntil
                    ? effectScope.Grant.ExpiresAt : entryScope.ActivePackage.Trust.ValidUntil;
                TimeSpan grantRemaining = authorityExpiry - timeProvider.GetUtcNow();
                if (grantRemaining <= TimeSpan.Zero)
                {
                    throw new AuthoringExtensionContractException("Approved IO grant has expired before dispatch.");
                }
                // A second linked deadline can only shorten the original
                // operation timer; it never resets the declared wall budget.
                grantDeadline.CancelAfter(grantRemaining);
                CancellationToken effectToken = grantDeadline.Token;
                CheckBoundary(envelope, token);
                if (entryScope.ActivePackage.Trust.ValidUntil <= timeProvider.GetUtcNow())
                {
                    throw new AuthoringExtensionContractException("Broker RPC package trust expired before dispatch.");
                }
                lock (requestGate)
                {
                    CheckBoundary(envelope, token);
                    if (!requestIds.Add(envelope.RequestId))
                    {
                        throw new AuthoringExtensionContractException("Duplicate broker RPC request is rejected.");
                    }
                }
                ValueTask<AuthoringServiceIoResult> pending = BeginIo(envelope, effectScope, limits, capability, effectToken);
                // Both original lifetimes stay owned until the actual promise
                // has settled. Dispose cannot strand an unobserved IO effect.
                io = await pending;
                if (capability == AuthoringCapability.FileSystemRootProposeWrite)
                {
                    staged = io.Receipt;
                }
                CheckBoundary(envelope, effectToken);
            }
            catch (Exception failure)
            {
                effectFailure = failure;
                throw;
            }
            finally
            {
                AuthoringTerminalReadScopes.Release(effectFailure, effectScope, entryScope);
                if (effectFailure is not null)
                {
                    try
                    {
                        if (effectFailure.Data["AuthoringTerminalReadScopeCleanupFailures"] is not null)
                        {
                            effectFailure.Data["AuthoringBrokerEntryScopeCleanupUnverified"] = true;
                        }
                    }
                    catch
                    {
                        // A secondary diagnostic must not replace the IO cause.
                    }
                }
            }
            CheckBoundary(envelope, token);
            await RequireCurrentAsync(package, platform, envelope, capability, token);
            IAuthoringInstalledPackageReadScope? packageScope = null;
            IAuthoringCapabilityBrokerGrantReadScope? returnScope = null;
            Exception? publicationFailure = null;
            try
            {
                // Reprepare independently in the same package→grant order.
                // After the last admission await, publication does not yield.
                packageScope = await resolver.AcquireBrokerReadScopeAsync(package, token);
                await RequireAdmissionAfterPreparationAsync(envelope, capability, token);
                returnScope = grants.AcquireBrokerReadScope(envelope.GrantDigest, envelope, capability);
                ValidateApprovedScope(returnScope, envelope);
                if (ScopeDigest(returnScope) != approvedIoDigest)
                {
                    throw new AuthoringExtensionContractException("Approved IO scope changed before publication.");
                }
                CheckBoundary(envelope, token);
                if (packageScope.ActivePackage.Trust.ValidUntil <= timeProvider.GetUtcNow() ||
                    returnScope.Grant.ExpiresAt <= timeProvider.GetUtcNow())
                {
                    throw new AuthoringExtensionContractException("Broker RPC authority expired before publication.");
                }
                AuthoringRpcEnvelope context = envelope with
                {
                    Payload = new AuthoringRpcPayload(BrokerGrantId: envelope.GrantDigest, StateValue: [])
                };
                var receipt = new AuthoringRpcBrokerReceipt(context, proposalDigest, io.Receipt, string.Empty);
                receipt = receipt with
                {
                    ReceiptDigest = Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(receipt)))
                };
                var result = new AuthoringRpcBrokerResult([.. io.Payload], receipt);
                ValidateResultBinding(envelope, result);
                ValidateResponse(result, limits);
                CheckBoundary(envelope, token);
                return result;
            }
            catch (Exception failure)
            {
                publicationFailure = failure;
                throw;
            }
            finally
            {
                AuthoringTerminalReadScopes.Release(publicationFailure, returnScope, packageScope);
            }
        }
        catch (Exception failure)
        {
            if (staged is not null)
            {
                try
                {
                    await broker.RevokeStagedWriteAsync(staged, cancellationToken);
                }
                catch
                {
                    // Cancellation/cleanup cannot erase the original refusal;
                    // this marker is not evidence of physical removal.
                    try
                    {
                        failure.Data["AuthoringBrokerStagedCleanupUnverified"] = true;
                    }
                    catch
                    {
                        // A diagnostic attachment cannot replace the refusal.
                    }
                }
            }
            throw;
        }
    }

    private ValueTask<AuthoringServiceIoResult> BeginIo(AuthoringRpcEnvelope envelope,
        IAuthoringCapabilityBrokerGrantReadScope scope, AuthoringResourceLimits limits,
        AuthoringCapability capability, CancellationToken token)
    {
        if (envelope.Payload.NetworkBroker is { } network)
        {
            AuthoringNetworkGrant grant = scope.NetworkGrant!;
            return broker!.FetchAsync(grant with
            {
                MaximumBytes = Math.Min(grant.MaximumBytes, Math.Min(limits.MaximumNetworkBytes, limits.MaximumResponseBytes)),
                ExpiresAt = grant.ExpiresAt < envelope.Deadline ? grant.ExpiresAt : envelope.Deadline
            }, envelope.RuntimeIdentity, envelope.Purpose, network.PathAndQuery, token);
        }
        AuthoringFileGrant file = scope.FileGrant!;
        file = file with
        {
            MaximumBytes = Math.Min(file.MaximumBytes, Math.Min(limits.MaximumFileBytes,
                capability == AuthoringCapability.FileSystemRootRead ? limits.MaximumResponseBytes : limits.MaximumRequestBytes)),
            ExpiresAt = file.ExpiresAt < envelope.Deadline ? file.ExpiresAt : envelope.Deadline
        };
        return file.Operation == AuthoringFileGrantOperation.Read
            ? broker!.ReadFileAsync(file, envelope.RuntimeIdentity, envelope.Purpose, token)
            : StageAsync(file, envelope, token);
    }

    private async ValueTask<AuthoringServiceIoResult> StageAsync(AuthoringFileGrant grant,
        AuthoringRpcEnvelope envelope, CancellationToken token) => new(
            await broker!.StageProposedWriteAsync(grant, envelope.RuntimeIdentity, envelope.Purpose,
                envelope.Payload.FileBroker!.ProposedBytes, token), []);

    private async ValueTask RequireAdmissionAfterPreparationAsync(
        AuthoringRpcEnvelope envelope, AuthoringCapability capability, CancellationToken token)
    {
        // Independent package preparation may yield. Recheck the original
        // grant and revision owners before consuming the request id or IO.
        // Resolving the package again while its same-store scope is held would
        // reacquire its mutation gate; use the actual held package instead.
        await grants.RequireAsync(envelope.GrantDigest, envelope, capability, token);
        if (!await revisionGate.IsCurrentAsync(envelope.DocumentId, envelope.DocumentEpoch,
            envelope.SourceRevision, token))
        {
            throw new AuthoringExtensionContractException("Broker RPC document revision is no longer current.");
        }
        CheckBoundary(envelope, token);
    }

    private async ValueTask RequireCurrentAsync(VerifiedAuthoringPackage package, AuthoringHostPlatform platform,
        AuthoringRpcEnvelope envelope, AuthoringCapability capability, CancellationToken token)
    {
        AuthoringExecutionTarget target = await resolver!.ResolveAsync(package, envelope.ContributionId,
            platform, envelope.RuntimeIdentity, token);
        CheckBoundary(envelope, token);
        if (target.Status != AuthoringExecutionResolutionStatus.Ready || target.ExecutionClass != envelope.ExecutionClass ||
            target.ExtensionId != envelope.ExtensionId || target.ExtensionVersion != envelope.ExtensionVersion ||
            target.PackageSha256 != envelope.PackageSha256 || package.Contract.Manifest.ContentSha256 != envelope.ContentSha256 ||
            package.Trust.Status != AuthoringPackageTrustStatus.Trusted || package.Trust.ValidUntil <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Broker RPC package or runtime is not current.");
        }
        await grants.RequireAsync(envelope.GrantDigest, envelope, capability, token);
        if (!await revisionGate.IsCurrentAsync(envelope.DocumentId, envelope.DocumentEpoch, envelope.SourceRevision, token))
        {
            throw new AuthoringExtensionContractException("Broker RPC document revision is stale.");
        }
        CheckBoundary(envelope, token);
    }

    private static AuthoringCapability Capability(AuthoringRpcEnvelope envelope) => envelope.Method switch
    {
        AuthoringRpcMethod.NetworkBrokerRequest => AuthoringCapability.NetworkDestination,
        AuthoringRpcMethod.FileBrokerRequest when envelope.Payload.FileBroker?.Operation == AuthoringFileGrantOperation.Read =>
            AuthoringCapability.FileSystemRootRead,
        AuthoringRpcMethod.FileBrokerRequest when envelope.Payload.FileBroker?.Operation == AuthoringFileGrantOperation.ProposeWrite =>
            AuthoringCapability.FileSystemRootProposeWrite,
        _ => throw new AuthoringExtensionContractException("RPC method does not carry one closed broker proposal.")
    };

    private static void ValidateProposal(AuthoringRpcEnvelope envelope, AuthoringResourceLimits limits)
    {
        if (envelope.Payload.NetworkBroker is { } network)
        {
            if (limits.MaximumNetworkBytes < 1 || network.Host is null || network.Host.Length > 253 || Uri.CheckHostName(network.Host) != UriHostNameType.Dns ||
                network.Port is < 1 or > 65535 || network.PathAndQuery is null || network.PathAndQuery.Length is < 1 or > 2048 ||
                !network.PathAndQuery.StartsWith("/", StringComparison.Ordinal) || network.PathAndQuery.StartsWith("//", StringComparison.Ordinal) ||
                network.PathAndQuery.Contains("://", StringComparison.Ordinal) || network.PathAndQuery.ContainsAny(['\0', '\r', '\n', '\\', '#']))
            {
                throw new AuthoringExtensionContractException("Network proposal is not one bounded host/port/path-and-query.");
            }
        }
        else if (envelope.Payload.FileBroker is { } file)
        {
            if (limits.MaximumFileBytes < 1 || !Enum.IsDefined(file.Operation) || string.IsNullOrWhiteSpace(file.RelativePath) || file.RelativePath.Length > 4096 ||
                file.RelativePath.ContainsAny(['\0', '\r', '\n']) || Path.IsPathFullyQualified(file.RelativePath) ||
                file.Operation == AuthoringFileGrantOperation.Read && !file.ProposedBytes.IsDefault ||
                file.Operation == AuthoringFileGrantOperation.ProposeWrite &&
                    (file.ProposedBytes.IsDefault || file.ProposedBytes.Length > limits.MaximumRequestBytes || file.ProposedBytes.Length > limits.MaximumFileBytes))
            {
                throw new AuthoringExtensionContractException("File proposal is not one closed bounded read or proposed write.");
            }
        }
    }

    private static void ValidateApprovedScope(IAuthoringCapabilityBrokerGrantReadScope scope, AuthoringRpcEnvelope envelope)
    {
        AuthoringCapabilityGrant approval = scope.Grant;
        if (approval.GrantId != envelope.GrantDigest)
        {
            throw new AuthoringExtensionContractException("Broker scope does not belong to the exact opaque RPC grant.");
        }
        bool exact;
        if (envelope.Payload.NetworkBroker is { } proposal)
        {
            AuthoringNetworkGrant? grant = scope.NetworkGrant;
            exact = scope.FileGrant is null && grant is not null && !string.IsNullOrWhiteSpace(approval.Destination) && approval.CanonicalRoot is null &&
                grant.GrantId == approval.GrantId && grant.RuntimeIdentity == approval.RuntimeIdentity && grant.Purpose == approval.Purpose &&
                grant.ExpiresAt == approval.ExpiresAt && grant.Host == proposal.Host && grant.Port == proposal.Port && grant.RequireTls &&
                grant.MaximumBytes is >= 1 and <= 64 * 1024 * 1024;
        }
        else
        {
            AuthoringFileGrant? grant = scope.FileGrant;
            AuthoringFileBrokerProposal fileProposal = envelope.Payload.FileBroker!;
            exact = scope.NetworkGrant is null && grant is not null && approval.Destination is null &&
                !string.IsNullOrWhiteSpace(grant.CanonicalRoot) &&
                grant.CanonicalRoot == approval.CanonicalRoot && grant.GrantId == approval.GrantId && grant.RuntimeIdentity == approval.RuntimeIdentity &&
                grant.Purpose == approval.Purpose && grant.ExpiresAt == approval.ExpiresAt && grant.RelativePath == fileProposal.RelativePath &&
                grant.Operation == fileProposal.Operation && grant.MaximumBytes is >= 1 and <= 64 * 1024 * 1024 &&
                (fileProposal.ProposedBytes.IsDefault || fileProposal.ProposedBytes.Length <= grant.MaximumBytes);
        }
        if (!exact)
        {
            throw new AuthoringExtensionContractException("Broker proposal differs from the live same-store approved IO scope.");
        }
    }

    private static byte[] SerializeRequest(AuthoringRpcEnvelope envelope, int depth)
    {
        // Default ImmutableArray values are represented as null, never enumerated.
        var file = envelope.Payload.FileBroker;
        return JsonSerializer.SerializeToUtf8Bytes(new
        {
            Context = envelope with
            {
                Payload = new AuthoringRpcPayload(BrokerGrantId: envelope.GrantDigest, StateValue: [])
            },
            envelope.Payload.NetworkBroker,
            FileBroker = file is null ? null : new
            {
                file.RelativePath,
                file.Operation,
                ProposedBytes = file.ProposedBytes.IsDefault ? null : file.ProposedBytes.ToArray()
            }
        }, new JsonSerializerOptions { MaxDepth = depth });
    }

    private static string ScopeDigest(IAuthoringCapabilityBrokerGrantReadScope scope) =>
        Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(new
        {
            scope.NetworkGrant,
            scope.FileGrant
        })));

    internal static void ValidateResultBinding(AuthoringRpcEnvelope request, AuthoringRpcBrokerResult result)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArgumentNullException.ThrowIfNull(request.Payload);
        ArgumentNullException.ThrowIfNull(result);
        _ = Capability(request);
        if (request.Method == AuthoringRpcMethod.NetworkBrokerRequest
            ? request.Payload.NetworkBroker is null || request.Payload.FileBroker is not null
            : request.Payload.FileBroker is null || request.Payload.NetworkBroker is not null)
        {
            throw new AuthoringExtensionContractException("Broker result requires one closed typed proposal.");
        }
        if (request.Payload.DocumentRange is not null || request.Payload.MutationPlan is not null ||
            request.Payload.QueryReference is not null || request.Payload.DiagnosticSchemaReference is not null ||
            request.Payload.StateKey is not null || !request.Payload.StateValue.IsDefault)
        {
            throw new AuthoringExtensionContractException("Broker proposal cannot contain another payload variant.");
        }
        AuthoringRpcBrokerReceipt receipt = result.Receipt;
        AuthoringRpcEnvelope expected = request with
        {
            Payload = new AuthoringRpcPayload(BrokerGrantId: request.GrantDigest, StateValue: [])
        };
        if (receipt?.Context?.Payload is not { } contextPayload ||
            contextPayload.BrokerGrantId != request.GrantDigest || contextPayload.DocumentRange is not null ||
            contextPayload.MutationPlan is not null || contextPayload.QueryReference is not null ||
            contextPayload.DiagnosticSchemaReference is not null || contextPayload.StateKey is not null ||
            contextPayload.StateValue.IsDefault || !contextPayload.StateValue.IsEmpty ||
            contextPayload.NetworkBroker is not null || contextPayload.FileBroker is not null ||
            (receipt.Context with
            {
                Payload = expected.Payload
            }) != expected)
        {
            throw new AuthoringExtensionContractException("Broker receipt context contains drift or content-bearing data.");
        }
        bool write = request.Method == AuthoringRpcMethod.FileBrokerRequest &&
            request.Payload.FileBroker?.Operation == AuthoringFileGrantOperation.ProposeWrite;
        string outcome = request.Method == AuthoringRpcMethod.NetworkBrokerRequest ? "network-read" :
            write ? "write-staged-for-host-approval" : "file-read";
        ImmutableArray<byte> content = write ? request.Payload.FileBroker!.ProposedBytes : result.Payload;
        if (request.SchemaVersion != 2 || request.Payload.BrokerGrantId != request.GrantDigest ||
            result.Payload.IsDefault || content.IsDefault || receipt?.IoReceipt is not { } io ||
            receipt.ProposalDigest != Convert.ToHexStringLower(SHA256.HashData(SerializeRequest(request, 64))) ||
            io.GrantId != request.GrantDigest || io.RuntimeIdentity != request.RuntimeIdentity || io.Purpose != request.Purpose ||
            io.Outcome != outcome || io.Bytes != content.Length ||
            io.ContentSha256 != Convert.ToHexStringLower(SHA256.HashData(content.AsSpan())) ||
            (write ? result.Payload.Length != 0 || !IsDigest(io.ArtifactReference) : io.ArtifactReference is not null) ||
            receipt.ReceiptDigest != Convert.ToHexStringLower(SHA256.HashData(JsonSerializer.SerializeToUtf8Bytes(receipt with
            {
                ReceiptDigest = string.Empty
            }))))
        {
            throw new AuthoringExtensionContractException("Broker RPC result is not bound to the exact proposal and context.");
        }
    }

    private static bool IsDigest(string? value) => value?.Length == 64 && value.All(static character =>
        character is >= '0' and <= '9' or >= 'a' and <= 'f');

    private static void ValidateResponse(AuthoringRpcBrokerResult result, AuthoringResourceLimits limits)
    {
        long bytes = JsonSerializer.SerializeToUtf8Bytes(result with
        {
            Payload = []
        }, new JsonSerializerOptions
        {
            MaxDepth = limits.MaximumObjectDepth
        }).LongLength;
        // Count the original ImmutableArray numeric representation without
        // materializing another payload-sized serialized value.
        foreach (byte value in result.Payload)
        {
            bytes += value < 10 ? 1 : value < 100 ? 2 : 3;
        }
        bytes += Math.Max(0, result.Payload.Length - 1);
        if (bytes > limits.MaximumResponseBytes)
        {
            throw new AuthoringExtensionContractException("Broker RPC exceeds the declared response budget.");
        }
    }

    private void CheckBoundary(AuthoringRpcEnvelope envelope, CancellationToken token)
    {
        token.ThrowIfCancellationRequested();
        if (envelope.Deadline <= timeProvider.GetUtcNow())
        {
            throw new AuthoringExtensionContractException("Broker RPC deadline has expired.");
        }
    }
}
