using System.Reflection;
using System.Text.Json;

using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Authorization.Infrastructure;
using Microsoft.AspNetCore.Builder;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;

using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Bootstrap;
using FsusBlog.Server.Interfaces;
using FsusBlog.Server.Models.CommentIdentity;
using FsusBlog.Server.Models.Dtos;
using FsusBlog.Server.Models.Moderation;
using FsusBlog.Server.Modules.Endpoints;
using FsusBlog.Server.Services;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Server.Services.Moderation;
using FsusBlog.Server.Services.Security;
using FsusBlog.Server.Tests.TestInfrastructure;
namespace FsusBlog.Server.Tests.Unit;

public sealed class AnonymousCommentModerationPipelineTests
{
    [Fact]
    public void AntiSpamContext_CarriesAnonymousSafeActorAndPolicyMetadata()
    {
        string[] contextProperties = typeof(AntiSpamCommentModerationContext)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        foreach (string requiredField in new[]
        {
            "AuthorMode",
            "AnonymousDisplayLanguage",
            "ModerationSubjectHash",
            "AnonymousNullifierHash",
            "AnonymousScope",
            "RateClass",
            "RequiresModeration",
            "AnonymousCommentsEnabled",
            "ZkAnonymousEnabled"
        })
        {
            Assert.Contains(requiredField, contextProperties);
        }

        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(AntiSpamModerationService));
        foreach (string metadataKey in new[]
        {
            "author_mode",
            "anonymous_display_language",
            "moderation_subject_hash",
            "anonymous_nullifier_hash",
            "anonymous_scope",
            "rate_class",
            "requires_moderation",
            "anonymous_comments_enabled",
            "zk_anonymous_enabled"
        })
        {
            Assert.Contains(metadataKey, runtimeShape, StringComparison.Ordinal);
        }

        string[] requestProperties = typeof(AntiSpamModerationRequest)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        Assert.DoesNotContain("IpHash", requestProperties);
        Assert.DoesNotContain("UserId", requestProperties);
        Assert.DoesNotContain("CredentialLevel", contextProperties);
        Assert.DoesNotContain("ReputationBucket", contextProperties);
        Assert.DoesNotContain("AccountAgeBucket", contextProperties);
        Assert.Contains("anonymous_nullifier_hash", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("user_name", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("public_handle", runtimeShape, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void AntiSpamModelRequest_UsesPrivacyAllowListAndSanitizesRuntimeMetadata()
    {
        string[] requestProperties = typeof(AntiSpamModerationRequest)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        foreach (string forbidden in new[]
        {
            "UserId", "UserName", "PublicHandle", "CredentialCommitment", "Proof",
            "Nullifier", "IpHash", "DeviceFingerprint"
        })
        {
            Assert.DoesNotContain(requestProperties, property =>
                property.Contains(forbidden, StringComparison.OrdinalIgnoreCase));
        }

        string runtimeShape = RuntimeMetadataInspection.DescribeType(typeof(AntiSpamModerationService));
        Assert.Contains("ValidateModelRequestDocument", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("AllowedRequestMetadataFields", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ForbiddenIdentityFields", runtimeShape, StringComparison.Ordinal);
        foreach (string allowed in new[]
        {
            "moderation_subject_hash", "anonymous_nullifier_hash", "anonymous_scope",
            "rate_class", "requires_moderation"
        })
        {
            Assert.Contains(allowed, runtimeShape, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void CommentService_RuntimePathPassesCommentActorAndPolicySnapshotToAntiSpamContext()
    {
        ParameterInfo[] constructorParameters = Assert.Single(typeof(CommentService).GetConstructors()).GetParameters();
        Assert.Contains(constructorParameters, static parameter => parameter.ParameterType == typeof(IAnonymousCommentPolicyService));

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentService),
            "CreateResolvedCommentAsync");
        foreach (string requiredMember in new[]
        {
            "AnonymousCommentPolicySnapshot",
            "get_UserId",
            "get_AuthorMode",
            "get_DisplayLanguage",
            "get_ModerationSubjectHash",
            "get_AnonymousNullifierHash",
            "get_AnonymousScope",
            "get_RateClass",
            "get_RequiresModeration",
            "get_AnonymousCommentsEnabled",
            "get_ZkAnonymousEnabled"
        })
        {
            Assert.Contains(requiredMember, runtimeShape, StringComparison.Ordinal);
        }
    }

    [Fact]
    public void CommentService_RuntimePathAppliesModelDispositionPolicyAndAuditsAutomaticActions()
    {
        ParameterInfo[] constructorParameters = Assert.Single(typeof(CommentService).GetConstructors()).GetParameters();
        Assert.Contains(constructorParameters, static parameter => parameter.ParameterType == typeof(ICommentModerationDispositionPolicy));
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentService),
            "CreateResolvedCommentAsync",
            "ApplyAutomaticModerationDispositionAsync");
        Assert.Contains("ICommentModerationDispositionPolicy.Decide", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ApplyAutomaticModerationDispositionAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("model_moderation_auto_disposition", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_ModerationStatus", runtimeShape, StringComparison.Ordinal);

        var services = new ServiceCollection();
        services.AddFsusRuntimeDomainServices();
        ServiceDescriptor disposition = Assert.Single(services, static descriptor =>
            descriptor.ServiceType == typeof(ICommentModerationDispositionPolicy));
        Assert.Equal(ServiceLifetime.Scoped, disposition.Lifetime);
        Assert.Equal(typeof(CommentModerationDispositionPolicy), disposition.ImplementationType);
        Assert.NotNull(typeof(CommentModerationItemResponse).GetProperty(nameof(CommentModerationItemResponse.AutoModerated)));
        Assert.NotNull(typeof(CommentModerationItemResponse).GetProperty(nameof(CommentModerationItemResponse.ModerationActor)));
    }

    [Fact]
    public void CommentService_AutomaticDispositionRuntimeUsesRowVersionGuardAndRetry()
    {
        PropertyInfo rowVersion = Assert.IsAssignableFrom<PropertyInfo>(typeof(Comment).GetProperty("RowVersion"));
        Assert.Equal(typeof(string), rowVersion.PropertyType);

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentService),
            "ApplyAutomaticModerationDispositionAsync",
            "LoadAutomaticModerationTargetAsync",
            "TryApplyAutomaticModerationDispositionAsync");
        Assert.Contains("LoadAutomaticModerationTargetAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("TryApplyAutomaticModerationDispositionAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("get_ModerationStatus", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("xmin::text AS row_version", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND xmin::text = @RowVersion", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("AND is_deleted = false", runtimeShape, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("Updateable", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void CommentService_RuntimeEnforcesAnonymousNullifierWithAtomicConsumeBeforeCommit()
    {
        ParameterInfo[] constructorParameters = Assert.Single(typeof(CommentService).GetConstructors()).GetParameters();
        Assert.Contains(constructorParameters, static parameter => parameter.ParameterType == typeof(ICommentAnonymousNullifierService));

        string create = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentService),
            "CreateResolvedCommentAsync",
            "RequiresAnonymousNullifierEnforcement");
        Assert.Contains("UseTranAsync", create, StringComparison.Ordinal);
        Assert.Contains("TryConsumeAsync", create, StringComparison.Ordinal);
        Assert.DoesNotContain("CheckAndReserveAsync", create, StringComparison.Ordinal);
        Assert.DoesNotContain("IncrementUsageAsync", create, StringComparison.Ordinal);
        Assert.Contains("AnonymousNullifierRejectedException", create, StringComparison.Ordinal);
        Assert.Contains(CommentAuthorModes.ZkAnonymous, create, StringComparison.Ordinal);
    }

    [Fact]
    public void NullifierService_RuntimeUsesPrecheckAndAtomicConsume()
    {
        Type service = typeof(CommentAnonymousNullifierService);
        Assert.NotNull(service.GetMethod(nameof(CommentAnonymousNullifierService.PrecheckAsync)));
        Assert.NotNull(service.GetMethod(nameof(CommentAnonymousNullifierService.TryConsumeAsync)));
        IReadOnlyList<string> atomicReaderCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            service,
            static member => member.Name == "GetDataReaderAsync" && member.DeclaringType?.Name.Contains("Ado", StringComparison.OrdinalIgnoreCase) == true);
        Assert.Contains(atomicReaderCallers,
            static caller => caller.Contains("<TryConsumeAsync>", StringComparison.Ordinal));
        IReadOnlyList<string> precheckTelemetryCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            service,
            static member => member.DeclaringType?.Name == "FsusObservability"
                && member.Name == "RecordAnonymousNullifierPrecheck");
        Assert.Contains(precheckTelemetryCallers,
            static caller => caller.Contains("<PrecheckAsync>", StringComparison.Ordinal));
        IReadOnlyList<string> consumeTelemetryCallers = RuntimeMetadataInspection.FindMethodsCallingMember(
            service,
            static member => member.DeclaringType?.Name == "FsusObservability"
                && member.Name == "RecordAnonymousNullifierAtomicIncrement");
        Assert.Contains(consumeTelemetryCallers,
            static caller => caller.Contains("<TryConsumeAsync>", StringComparison.Ordinal));
    }

    [Fact]
    public void CommentService_AnonymousFailureRuntimeLogsDoNotWriteRawAnonymousScope()
    {
        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(CommentService),
            "CreateResolvedCommentAsync",
            "HashAnonymousScopeForLog",
            "NormalizeAnonymousScope");

        Assert.Contains("HashAnonymousScopeForLog", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("NormalizeAnonymousScope", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("ScopeHash", runtimeShape, StringComparison.Ordinal);
        Assert.DoesNotContain("Scope: {Scope}", runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    [Trait("ShardAffinity", "EndpointContractApplication")]
    public async Task AdminModerationEndpoints_ExposeAnonymousGovernanceActionsWithSpecificPermissions()
    {
        await using EndpointContractSnapshot app = EndpointContractApplication.CreateSnapshot();
        AssertPermission(
            EndpointContractApplication.Find(
                app,
                "/api/binary/author/moderation/anonymous-comment-policy",
                HttpMethods.Put),
            AdminPermissions.AnonymousCommentConfigure);
        AssertPermission(
            EndpointContractApplication.Find(
                app,
                "/api/binary/author/comments/moderation/nullifiers/block",
                HttpMethods.Post),
            AdminPermissions.AnonymousNullifierBlock);
        AssertPermission(
            EndpointContractApplication.Find(
                app,
                "/api/binary/author/comments/moderation/anonymous-credentials/{credentialId:long}/revoke",
                HttpMethods.Post),
            AdminPermissions.AnonymousCredentialRevoke);

        string endpointRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringEndpoints),
            nameof(AuthoringEndpoints.MapAuthoringEndpoints));
        Assert.Contains(nameof(AnonymousCommentPolicyUpdateRequest), endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("ICommentAnonymousNullifierService.BlockAsync", endpointRuntime, StringComparison.Ordinal);
        Assert.Contains("IAnonymousCredentialService.RevokeAsync", endpointRuntime, StringComparison.Ordinal);

        string[] responseProperties = typeof(CommentModerationItemResponse)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        foreach (string responseField in new[]
        {
            "AuthorMode",
            "AuthorDisplayName",
            "AnonymousDisplayLanguage",
            "ModerationSubjectHash",
            "NullifierHash",
            "NullifierStatusLabel",
            "AnonymousScope",
            "RateClass",
            "RequiresModeration",
            "CanBlockAnonymousNullifier",
            "CanRevokeAnonymousCredential"
        })
        {
            Assert.Contains(responseField, responseProperties);
        }
        Assert.DoesNotContain("CredentialLevel", responseProperties);
        Assert.DoesNotContain("ReputationBucket", responseProperties);
        Assert.DoesNotContain("AccountAgeBucket", responseProperties);
    }

    [Fact]
    public void ModerationQueue_RuntimeContractDoesNotExposeRealUserIdAndBatchesNullifierState()
    {
        string[] responseProperties = typeof(CommentModerationItemResponse)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        Assert.DoesNotContain("UserId", responseProperties);
        Assert.Contains(nameof(CommentModerationItemResponse.AuthorDisplayName), responseProperties);
        Assert.Contains(nameof(CommentModerationItemResponse.AuthorMode), responseProperties);
        Assert.Contains(nameof(CommentModerationItemResponse.AnonymousDisplayLanguage), responseProperties);
        Assert.Contains(nameof(CommentModerationItemResponse.NullifierStatusLabel), responseProperties);
        Assert.Equal("authorDisplayName", JsonNamingPolicy.CamelCase.ConvertName(nameof(CommentModerationItemResponse.AuthorDisplayName)));
        Assert.DoesNotContain(
            responseProperties.Select(JsonNamingPolicy.CamelCase.ConvertName),
            static property => string.Equals(property, "userId", StringComparison.Ordinal));

        string runtimeShape = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringWorkflowService),
            nameof(AuthoringWorkflowService.ListCommentModerationQueueAsync),
            "LoadAnonymousNullifierSummariesAsync");
        Assert.Contains("get_AnonymousDisplayName", runtimeShape, StringComparison.Ordinal);
        Assert.Contains("LoadAnonymousNullifierSummariesAsync", runtimeShape, StringComparison.Ordinal);
        Assert.Contains(nameof(CommentAnonymousNullifier), runtimeShape, StringComparison.Ordinal);
        Assert.Contains(nameof(CommentModerationItemResponse.NullifierStatusLabel), runtimeShape, StringComparison.Ordinal);
    }

    [Fact]
    public void AnonymousGovernanceAudit_RuntimeHashesIrreversibleTargetsAndPreservesProviderPrivacy()
    {
        MethodInfo hashMethod = typeof(AuthoringEndpoints).GetMethod(
            "HashAuditTargetId",
            BindingFlags.Static | BindingFlags.NonPublic)!;
        const string RawNullifier = "raw-nullifier-secret";
        string nullifierTarget = (string)hashMethod.Invoke(null, ["comment_anonymous_nullifier", RawNullifier])!;
        string credentialTarget = (string)hashMethod.Invoke(null, ["anonymous_credential", "88001"])!;
        Assert.NotEqual(RawNullifier, nullifierTarget);
        Assert.DoesNotContain(RawNullifier, nullifierTarget, StringComparison.Ordinal);
        Assert.NotEqual("88001", credentialTarget);
        Assert.NotEqual(nullifierTarget, credentialTarget);

        string endpointRuntime = RuntimeMetadataInspection.DescribeMethods(
            typeof(AuthoringEndpoints),
            nameof(AuthoringEndpoints.MapAuthoringEndpoints),
            "HashAuditTargetId");
        Assert.Contains("HashAuditTargetId", endpointRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("TargetId: request.NullifierHash", endpointRuntime, StringComparison.Ordinal);
        Assert.DoesNotContain("TargetId: credentialId.ToString", endpointRuntime, StringComparison.Ordinal);

        string[] providerRequestProperties = typeof(AntiSpamModerationRequest)
            .GetProperties(BindingFlags.Instance | BindingFlags.Public)
            .Select(static property => property.Name)
            .ToArray();
        Assert.DoesNotContain("UserId", providerRequestProperties);
        Assert.DoesNotContain("PublicHandle", providerRequestProperties);
    }

    private static void AssertPermission(RouteEndpoint endpoint, string expectedPermission)
    {
        ClaimsAuthorizationRequirement permission = Assert.Single(endpoint.Metadata
            .GetOrderedMetadata<AuthorizationPolicy>()
            .SelectMany(static policy => policy.Requirements)
            .OfType<ClaimsAuthorizationRequirement>(),
            static requirement => requirement.ClaimType == AdminPermissions.PermissionClaimType);
        Assert.Contains(expectedPermission, permission.AllowedValues ?? []);
    }
}
