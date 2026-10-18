using System.Globalization;

using FsusBlog.Core.Algorithms;
using FsusBlog.Core.Cache;
using FsusBlog.Core.Common;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Binary;
using FsusBlog.Server.Infrastructure.Filters;
using FsusBlog.Server.Infrastructure.Policies;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Modules.Endpoints.Binary;
using FsusBlog.Server.Services.Authoring;
using FsusBlog.Shared.Contracts.ArticleProperties;
using FsusBlog.Shared.Contracts.AuthoringCanvas;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static void MapArticlePropertyValueRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/articles/{articleId:int}/properties", static async Task<BinaryFrameResult> (
            int articleId, HttpContext context, IAedsEncoder aeds, IArticlePropertyValueAuthority authority,
            IBinaryEndpointRequestContext requests, CancellationToken cancellationToken) =>
        {
            using BinaryRequestPayload payload = await requests.ReadFrameAsync(context, aeds,
                AedsFrameType.ArticlePropertyValueMutationCommand, cancellationToken,
                ArticlePropertyValueReadWireContract.MaxPayloadBytes + AedsFrameHeader.Size);
            if (!payload.IsSuccess)
            {
                return BinaryResults.FromError(payload.Error, aeds);
            }
            if (!PodBinaryCodec.TryDecodeArticlePropertyValueMutationCommand(payload.Payload, out var command)
                || command.ArticleId != articleId || command.SiteScope != "primary-site"
                || context.Request.QueryString.HasValue)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_value_command_invalid"), aeds);
            }
            return await ExecutePropertyMutationAsync(aeds, async () =>
            {
                ArticlePropertyValueMutationReceipt receipt = await authority.MutateAsync(
                    ResolveRequiredAdminPrincipalId(context), command, cancellationToken).ConfigureAwait(false);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyValueMutationReceipt,
                    destination => PodBinaryCodec.WriteArticlePropertyValueMutationReceipt(receipt, destination));
            }).ConfigureAwait(false);
        })
        .WithName("binary_author_article_property_values_mutate")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(AedsFrameType.ArticlePropertyValueMutationCommand,
            AedsFrameType.ArticlePropertyValueMutationReceipt))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite)
        .AddEndpointFilterWithMetadata<RequiresPowFilter>();

        group.MapGet("/articles/{articleId:int}/properties", static async Task<BinaryFrameResult> (
            int articleId, HttpContext context, IAedsEncoder aeds, IArticlePropertyValueAuthority authority,
            CancellationToken cancellationToken) =>
        {
            long? ownerUserId = null;
            if (context.Request.Query.TryGetValue("ownerUserId", out var supplied)
                && (supplied.Count != 1 || !long.TryParse(supplied[0], NumberStyles.None,
                    CultureInfo.InvariantCulture, out long ownerId) || ownerId <= 0))
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_value_owner_invalid"), aeds);
            }
            else if (supplied.Count == 1)
            {
                ownerUserId = long.Parse(supplied[0]!, CultureInfo.InvariantCulture);
            }
            if (articleId <= 0)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_value_article_invalid"), aeds);
            }
            try
            {
                var owner = new ArticlePropertyDefinitionOwner(ownerUserId, "primary-site");
                ArticlePropertyValueReadModel model = await authority.ReadAsync(
                    ResolveRequiredAdminPrincipalId(context), owner,
                    articleId, cancellationToken).ConfigureAwait(false);
                ArticlePropertyValueReadResponse response = ToPropertyReadResponse(model, owner);
                return BinaryResults.Frame(aeds, AedsFrameType.ArticlePropertyValueReadResponse,
                    destination => PodBinaryCodec.WriteArticlePropertyValueReadResponse(response, destination));
            }
            catch (Exception error) when (error is ArticlePropertyDefinitionAccessDeniedException or AuthoringCanvasAccessDeniedException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.NotFound,
                    "article_property_value_unavailable"), aeds);
            }
            catch (ArticlePropertyDefinitionValidationException error)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation, error.Code), aeds);
            }
            catch (ArticlePropertyDefinitionIntegrityException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.InfraFailure,
                    "article_property_value_integrity_failed"), aeds);
            }
            catch (ArticlePropertyDefinitionBudgetExceededException)
            {
                return BinaryResults.FromError(ErrorDetail.Create(ErrorCode.Validation,
                    "article_property_value_read_budget_exceeded"), aeds);
            }
        })
        .WithName("binary_author_article_property_values_read")
        .WithMetadata(new FsusOpenApiAedsContractMetadata(null, AedsFrameType.ArticlePropertyValueReadResponse))
        .RequireNoStoreResponse()
        .RequireAdminPermission(AdminPermissions.ArticleWrite);
    }

    private static ArticlePropertyValueReadResponse ToPropertyReadResponse(
        ArticlePropertyValueReadModel model, ArticlePropertyDefinitionOwner authorizedOwner)
        => new(model.ArticleId, model.ArticleRevisionId, model.PropertyRevision, model.Current,
            Array.AsReadOnly(model.Definitions.Select(ToPropertyDefinitionReadDescriptor).ToArray()),
            Array.AsReadOnly(model.Reconciliation.Select(static item => new ArticlePropertyValueReconciliationRead(
                item.DefinitionId, (byte)item.Status, item.ReasonCode)).ToArray()),
            new(authorizedOwner.UserId, authorizedOwner.SiteScope, ArticlePropertyDefinitionContract.SchemaVersion));

    private static ArticlePropertyDefinitionReadDescriptor ToPropertyDefinitionReadDescriptor(ArticlePropertyDefinition definition)
        => new(definition.SchemaVersion, definition.DefinitionId, definition.Owner.UserId,
            definition.Owner.SiteScope, definition.MachineKey,
            Array.AsReadOnly(definition.DisplayNames.Select(static name => new ArticlePropertyReadLocalizedName(name.Locale, name.Value)).ToArray()),
            (byte)definition.ValueType, (byte)definition.Cardinality, definition.Required,
            new((byte)definition.Presence.Missing, (byte)definition.Presence.Null, (byte)definition.Presence.Empty),
            definition.DefaultValue is null ? null : new((byte)definition.DefaultValue.Kind,
                PropertyDefaultPayload(definition.ValueType, definition.DefaultValue)),
            new(definition.Constraints.MinLength, definition.Constraints.MaxLength,
                definition.Constraints.MinNumber, definition.Constraints.MaxNumber,
                definition.Constraints.MinDateUtc, definition.Constraints.MaxDateUtc,
                definition.Constraints.MinItems, definition.Constraints.MaxItems),
            Array.AsReadOnly(definition.Options.Select(static option => new ArticlePropertyReadOption(
                option.OptionId, option.Label, option.Order, (byte)option.Status,
                Array.AsReadOnly(option.LocalizedLabels.Select(static label => new ArticlePropertyReadLocalizedName(label.Locale, label.Value)).ToArray()))).ToArray()),
            definition.ReferencePolicy is null ? null : new((byte)definition.ReferencePolicy.Cardinality,
                (byte)definition.ReferencePolicy.Permission, definition.ReferencePolicy.AllowCrossSite,
                definition.ReferencePolicy.AllowDeleted, definition.ReferencePolicy.AllowArchived,
                definition.ReferencePolicy.AllowSelfReference, definition.ReferencePolicy.AllowCycles),
            definition.UrlPolicy is null ? null : new(definition.UrlPolicy.AllowedSchemes,
                definition.UrlPolicy.AllowRelative, definition.UrlPolicy.AllowAbsolute,
                definition.UrlPolicy.MaxLength, (byte)definition.UrlPolicy.Normalization),
            definition.SearchEligible, definition.Filterable, definition.Sortable,
            (byte)definition.DisplayPlacement, (byte)definition.VisibilityScope, (byte)definition.Status,
            definition.SchemaRevision, definition.CreatedAtUtc, definition.UpdatedAtUtc, definition.ContentDigest);

    private static ArticlePropertyTypedValue? PropertyDefaultPayload(ArticlePropertyValueType type,
        ArticlePropertyDefaultValue value)
        => value.Kind is ArticlePropertyDefaultKind.None or ArticlePropertyDefaultKind.Null ? null : type switch
        {
            ArticlePropertyValueType.Text => new ArticlePropertyTextValue(value.Scalar!),
            ArticlePropertyValueType.Number => new ArticlePropertyNumberValue(decimal.Parse(value.Scalar!, CultureInfo.InvariantCulture)),
            ArticlePropertyValueType.Boolean => new ArticlePropertyBooleanValue(bool.Parse(value.Scalar!)),
            ArticlePropertyValueType.Date => new ArticlePropertyDateValue(DateTime.Parse(value.Scalar!, CultureInfo.InvariantCulture, DateTimeStyles.RoundtripKind)),
            ArticlePropertyValueType.SingleSelect => new ArticlePropertySingleSelectValue(value.OptionIds.Single()),
            ArticlePropertyValueType.MultiSelect => new ArticlePropertyMultiSelectValue(value.OptionIds),
            ArticlePropertyValueType.ArticleReference => new ArticlePropertyArticleReferenceValue(value.ArticleIds),
            ArticlePropertyValueType.Url => new ArticlePropertyUrlValue(value.Scalar!),
            _ => throw new ArticlePropertyDefinitionIntegrityException("article_property_default_read_type_invalid")
        };
}
