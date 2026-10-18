using System.Globalization;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Core.Services.Articles;
using FsusBlog.Server.Entities;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

using SqlSugar;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static void MapArticlePropertyDefinitionRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/property-definitions", static async Task<BinaryFrameResult> (
            HttpContext context, IAedsEncoder aeds, IArticlePropertyDefinitionStore store,
            ISqlSugarClient db, IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticlePropertyDefinitionCreateRequest, cancellationToken,
                ArticlePropertyValueReadWireContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeArticlePropertyDefinitionCreateRequest(payload.Payload, out var request)
                || request.SiteScope != "primary-site"
                || context.Request.QueryString.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_definition_request_invalid"), aeds);
            }
            return await ExecutePropertyMutationAsync(aeds, async () =>
            {
                var owner = new ArticlePropertyDefinitionOwner(request.DefinitionOwnerUserId, request.SiteScope);
                ArticlePropertyDefinitionActor actor = await ResolvePropertyDefinitionActorAsync(
                    context, db, owner, cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionSettings settings = request.Settings;
                ArticlePropertyDefinitionWriteReceipt receipt = await store.CreateAsync(new(
                    actor,
                    owner,
                    request.DefinitionId,
                    request.RequestId,
                    request.ExpectedOwnerRevision,
                    request.MachineKey,
                    PropertyDefinitionNames(request.DisplayNames),
                    (ArticlePropertyValueType)settings.ValueType,
                    (ArticlePropertyCardinality)settings.Cardinality,
                    settings.Required,
                    new((ArticlePropertyMissingBehavior)settings.Presence.Missing, (ArticlePropertyNullBehavior)settings.Presence.Null, (ArticlePropertyEmptyBehavior)settings.Presence.Empty),
                    PropertyDefinitionDefault(settings.DefaultValue),
                    new(settings.Constraints.MinLength, settings.Constraints.MaxLength, settings.Constraints.MinNumber, settings.Constraints.MaxNumber, settings.Constraints.MinDateUtc, settings.Constraints.MaxDateUtc, settings.Constraints.MinItems, settings.Constraints.MaxItems),
                    Array.AsReadOnly(settings.Options.Select(static option => new ArticlePropertyOption(option.OptionId, option.Label, option.Order, (ArticlePropertyOptionStatus)option.Status, PropertyDefinitionNames(option.LocalizedLabels))).ToArray()),
                    settings.ReferencePolicy is not { } reference ? null : new((ArticlePropertyCardinality)reference.Cardinality, (ArticlePropertyReferencePermission)reference.Permission, reference.AllowCrossSite, reference.AllowDeleted, reference.AllowArchived, reference.AllowSelfReference, reference.AllowCycles),
                    settings.UrlPolicy is not { } url ? null : new(url.AllowedSchemes, url.AllowRelative, url.AllowAbsolute, url.MaxLength, (ArticlePropertyUrlNormalization)url.Normalization),
                    settings.SearchEligible,
                    settings.Filterable,
                    settings.Sortable,
                    (ArticlePropertyDisplayPlacement)settings.DisplayPlacement,
                    (ArticlePropertyVisibilityScope)settings.VisibilityScope), cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionMutationReceipt response = PropertyDefinitionReceipt(receipt);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyDefinitionMutationReceipt,
                    destination => PodBinaryCodec.WriteArticlePropertyDefinitionMutationReceipt(response, destination));
            }).ConfigureAwait(false);
        })
        .WithName("binary_author_article_property_definition_create")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticlePropertyDefinitionCreateRequest,
            AedsFrameType.ArticlePropertyDefinitionMutationReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPut("/property-definitions/{definitionId:guid}", static async Task<BinaryFrameResult> (
            Guid definitionId, HttpContext context, IAedsEncoder aeds, IArticlePropertyDefinitionStore store,
            ISqlSugarClient db, IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticlePropertyDefinitionUpdateRequest, cancellationToken,
                ArticlePropertyValueReadWireContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeArticlePropertyDefinitionUpdateRequest(payload.Payload, out var request)
                || request.SiteScope != "primary-site" || request.DefinitionId != definitionId
                || context.Request.QueryString.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_definition_request_invalid"), aeds);
            }
            return await ExecutePropertyMutationAsync(aeds, async () =>
            {
                var owner = new ArticlePropertyDefinitionOwner(request.DefinitionOwnerUserId, request.SiteScope);
                ArticlePropertyDefinitionActor actor = await ResolvePropertyDefinitionActorAsync(
                    context, db, owner, cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionSettings settings = request.Settings;
                ArticlePropertyDefinitionWriteReceipt receipt = await store.UpdateAsync(new(
                    actor,
                    owner,
                    request.DefinitionId,
                    request.RequestId,
                    request.ExpectedOwnerRevision,
                    request.ExpectedSchemaRevision,
                    (ArticlePropertyValueType)settings.ValueType,
                    (ArticlePropertyCardinality)settings.Cardinality,
                    settings.Required,
                    new((ArticlePropertyMissingBehavior)settings.Presence.Missing, (ArticlePropertyNullBehavior)settings.Presence.Null, (ArticlePropertyEmptyBehavior)settings.Presence.Empty),
                    PropertyDefinitionDefault(settings.DefaultValue),
                    new(settings.Constraints.MinLength, settings.Constraints.MaxLength, settings.Constraints.MinNumber, settings.Constraints.MaxNumber, settings.Constraints.MinDateUtc, settings.Constraints.MaxDateUtc, settings.Constraints.MinItems, settings.Constraints.MaxItems),
                    Array.AsReadOnly(settings.Options.Select(static option => new ArticlePropertyOption(option.OptionId, option.Label, option.Order, (ArticlePropertyOptionStatus)option.Status, PropertyDefinitionNames(option.LocalizedLabels))).ToArray()),
                    settings.ReferencePolicy is not { } reference ? null : new((ArticlePropertyCardinality)reference.Cardinality, (ArticlePropertyReferencePermission)reference.Permission, reference.AllowCrossSite, reference.AllowDeleted, reference.AllowArchived, reference.AllowSelfReference, reference.AllowCycles),
                    settings.UrlPolicy is not { } url ? null : new(url.AllowedSchemes, url.AllowRelative, url.AllowAbsolute, url.MaxLength, (ArticlePropertyUrlNormalization)url.Normalization),
                    settings.SearchEligible,
                    settings.Filterable,
                    settings.Sortable,
                    (ArticlePropertyDisplayPlacement)settings.DisplayPlacement,
                    (ArticlePropertyVisibilityScope)settings.VisibilityScope), cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionMutationReceipt response = PropertyDefinitionReceipt(receipt);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyDefinitionMutationReceipt,
                    destination => PodBinaryCodec.WriteArticlePropertyDefinitionMutationReceipt(response, destination));
            }).ConfigureAwait(false);
        })
        .WithName("binary_author_article_property_definition_update")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticlePropertyDefinitionUpdateRequest,
            AedsFrameType.ArticlePropertyDefinitionMutationReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/property-definitions/{definitionId:guid}/rename", static async Task<BinaryFrameResult> (
            Guid definitionId, HttpContext context, IAedsEncoder aeds, IArticlePropertyDefinitionStore store,
            ISqlSugarClient db, IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticlePropertyDefinitionRenameRequest, cancellationToken,
                ArticlePropertyValueReadWireContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeArticlePropertyDefinitionRenameRequest(payload.Payload, out var request)
                || request.SiteScope != "primary-site" || request.DefinitionId != definitionId
                || context.Request.QueryString.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_definition_request_invalid"), aeds);
            }
            return await ExecutePropertyMutationAsync(aeds, async () =>
            {
                var owner = new ArticlePropertyDefinitionOwner(request.DefinitionOwnerUserId, request.SiteScope);
                ArticlePropertyDefinitionActor actor = await ResolvePropertyDefinitionActorAsync(
                    context, db, owner, cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionWriteReceipt receipt = await store.RenameAsync(new(
                    actor,
                    owner,
                    request.DefinitionId,
                    request.RequestId,
                    request.ExpectedOwnerRevision,
                    request.ExpectedSchemaRevision,
                    PropertyDefinitionNames(request.DisplayNames)), cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionMutationReceipt response = PropertyDefinitionReceipt(receipt);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyDefinitionMutationReceipt,
                    destination => PodBinaryCodec.WriteArticlePropertyDefinitionMutationReceipt(response, destination));
            }).ConfigureAwait(false);
        })
        .WithName("binary_author_article_property_definition_rename")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticlePropertyDefinitionRenameRequest,
            AedsFrameType.ArticlePropertyDefinitionMutationReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapPost("/property-definitions/{definitionId:guid}/deprecate", static async Task<BinaryFrameResult> (
            Guid definitionId, HttpContext context, IAedsEncoder aeds, IArticlePropertyDefinitionStore store,
            ISqlSugarClient db, IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticlePropertyDefinitionDeprecateRequest, cancellationToken,
                ArticlePropertyValueReadWireContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeArticlePropertyDefinitionDeprecateRequest(payload.Payload, out var request)
                || request.SiteScope != "primary-site" || request.DefinitionId != definitionId
                || context.Request.QueryString.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_definition_request_invalid"), aeds);
            }
            return await ExecutePropertyMutationAsync(aeds, async () =>
            {
                var owner = new ArticlePropertyDefinitionOwner(request.DefinitionOwnerUserId, request.SiteScope);
                ArticlePropertyDefinitionActor actor = await ResolvePropertyDefinitionActorAsync(
                    context, db, owner, cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionWriteReceipt receipt = await store.DeprecateAsync(new(
                    actor,
                    owner,
                    request.DefinitionId,
                    request.RequestId,
                    request.ExpectedOwnerRevision,
                    request.ExpectedSchemaRevision), cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionMutationReceipt response = PropertyDefinitionReceipt(receipt);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyDefinitionMutationReceipt,
                    destination => PodBinaryCodec.WriteArticlePropertyDefinitionMutationReceipt(response, destination));
            }).ConfigureAwait(false);
        })
        .WithName("binary_author_article_property_definition_deprecate")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticlePropertyDefinitionDeprecateRequest,
            AedsFrameType.ArticlePropertyDefinitionMutationReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapDelete("/property-definitions/{definitionId:guid}", static async Task<BinaryFrameResult> (
            Guid definitionId, HttpContext context, IAedsEncoder aeds, IArticlePropertyDefinitionStore store,
            ISqlSugarClient db, IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticlePropertyDefinitionDeleteRequest, cancellationToken,
                ArticlePropertyValueReadWireContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeArticlePropertyDefinitionDeleteRequest(payload.Payload, out var request)
                || request.SiteScope != "primary-site" || request.DefinitionId != definitionId
                || context.Request.QueryString.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_definition_request_invalid"), aeds);
            }
            return await ExecutePropertyMutationAsync(aeds, async () =>
            {
                var owner = new ArticlePropertyDefinitionOwner(request.DefinitionOwnerUserId, request.SiteScope);
                ArticlePropertyDefinitionActor actor = await ResolvePropertyDefinitionActorAsync(
                    context, db, owner, cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionWriteReceipt receipt = await store.DeleteAsync(new(
                    actor,
                    owner,
                    request.DefinitionId,
                    request.RequestId,
                    request.ExpectedOwnerRevision,
                    request.ExpectedSchemaRevision), cancellationToken).ConfigureAwait(false);
                ArticlePropertyDefinitionMutationReceipt response = PropertyDefinitionReceipt(receipt);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyDefinitionMutationReceipt,
                    destination => PodBinaryCodec.WriteArticlePropertyDefinitionMutationReceipt(response, destination));
            }).ConfigureAwait(false);
        })
        .WithName("binary_author_article_property_definition_delete")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticlePropertyDefinitionDeleteRequest,
            AedsFrameType.ArticlePropertyDefinitionMutationReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

    }

    private static async Task<ArticlePropertyDefinitionActor> ResolvePropertyDefinitionActorAsync(
        HttpContext context, ISqlSugarClient db, ArticlePropertyDefinitionOwner owner,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!context.User.IsAdminPrincipal() || string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }
        long principalId = ResolveRequiredAdminPrincipalId(context);
        AdminPrincipal? principal = await db.Queryable<AdminPrincipal>()
            .Where(row => row.Id == principalId && row.Status == AdminPrincipalStatus.Active)
            .FirstAsync(cancellationToken).ConfigureAwait(false);
        if (principal is null)
        {
            throw new ArticlePropertyDefinitionAccessDeniedException();
        }
        var actor = new ArticlePropertyDefinitionActor(principalId,
            principal.IsRoot ? AdminPermissions.All : principal.Permissions.Split('\n', StringSplitOptions.RemoveEmptyEntries));
        new ArticlePropertyDefinitionPermissionAuthority().EnsureAllowed(actor, owner, manage: true);
        return actor;
    }

    private static IReadOnlyList<ArticlePropertyLocalizedName> PropertyDefinitionNames(
        IReadOnlyList<ArticlePropertyReadLocalizedName> names)
        => Array.AsReadOnly(names.Select(static name => new ArticlePropertyLocalizedName(name.Locale, name.Value)).ToArray());

    private static ArticlePropertyDefaultValue? PropertyDefinitionDefault(ArticlePropertyReadDefaultValue? value)
        => value is null ? null : value.Value switch
        {
            null => new((ArticlePropertyDefaultKind)value.Kind),
            ArticlePropertyTextValue text => new((ArticlePropertyDefaultKind)value.Kind, text.Text),
            ArticlePropertyNumberValue number => new((ArticlePropertyDefaultKind)value.Kind, number.Number.ToString(CultureInfo.InvariantCulture)),
            ArticlePropertyBooleanValue boolean => new((ArticlePropertyDefaultKind)value.Kind, boolean.Boolean.ToString(CultureInfo.InvariantCulture)),
            ArticlePropertyDateValue date => new((ArticlePropertyDefaultKind)value.Kind, date.Utc.ToString("O", CultureInfo.InvariantCulture)),
            ArticlePropertyUrlValue url => new((ArticlePropertyDefaultKind)value.Kind, url.Url),
            ArticlePropertySingleSelectValue single => new((ArticlePropertyDefaultKind)value.Kind, OptionIds: [single.OptionId]),
            ArticlePropertyMultiSelectValue multi => new((ArticlePropertyDefaultKind)value.Kind, OptionIds: multi.OptionIds),
            ArticlePropertyArticleReferenceValue reference => new((ArticlePropertyDefaultKind)value.Kind, ArticleIds: reference.ArticleIds),
            _ => throw new ArticlePropertyDefinitionValidationException("article_property_definition_default_invalid")
        };

    private static ArticlePropertyDefinitionMutationReceipt PropertyDefinitionReceipt(ArticlePropertyDefinitionWriteReceipt receipt)
        => new(receipt.ReceiptId, receipt.RequestId, receipt.ActorAdminPrincipalId, receipt.Owner.UserId,
            receipt.Owner.SiteScope, receipt.CommandKind, receipt.CommandDigest, receipt.DefinitionId,
            receipt.PreviousOwnerRevision, receipt.OwnerRevision, receipt.PreviousSchemaRevision,
            receipt.SchemaRevision, (byte)receipt.Status, receipt.BeforeDefinitionDigest, receipt.AfterDefinitionDigest,
            receipt.ConstraintDigest, receipt.OptionsDigest, receipt.PolicyDigest, receipt.FlagsDigest,
            Array.AsReadOnly(receipt.Obligations.Select(static obligation => new ArticlePropertyDefinitionMutationObligation(
                obligation.Kind, obligation.AffectedValueCount, obligation.RequiresReconciliation, obligation.ReasonCode)).ToArray()),
            receipt.AuditReference, receipt.AuditDigest, receipt.ContentDigest, receipt.OccurredAtUtc, receipt.IsIdempotentReplay);

    private static async Task<BinaryFrameResult> ExecutePropertyMutationAsync(IAedsEncoder aeds,
        Func<Task<BinaryFrameResult>> execute)
    {
        try
        {
            return await execute().ConfigureAwait(false);
        }
        catch (ArticleRevisionConflictException)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, "article_property_value_article_revision_conflict"), aeds);
        }
        catch (ArticlePropertyDefinitionConflictException error)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Conflict, error.Code), aeds);
        }
        catch (Exception error) when (error is ArticlePropertyDefinitionAccessDeniedException or ArticlePropertyDefinitionNotFoundException or AuthoringCanvasAccessDeniedException)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound, "article_property_unavailable"), aeds);
        }
        catch (ArticlePropertyDefinitionIntegrityException)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure, "article_property_integrity_failed"), aeds);
        }
        catch (ArticlePropertyDefinitionValidationException error)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
        }
        catch (ArticlePropertyDefinitionBudgetExceededException error)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
        }
        catch (ArgumentException)
        {
            return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, "article_property_request_invalid"), aeds);
        }
    }
}
