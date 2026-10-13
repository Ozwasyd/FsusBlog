using FsusBlog.Core.Algorithms;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Results;
using FsusBlog.Server.Services.ArticleVault;
using FsusBlog.Shared.Contracts.ArticleVault;

namespace FsusBlog.Server.Modules.Endpoints;

public static partial class AuthoringEndpoints
{
    private static void MapArticleVaultReadRoutes(IEndpointRouteBuilder group)
    {
        group.MapPost("/vault/recovery/history", ReadArticleVaultRecoveryHistoryAsync)
            .RequireAdminPermission(AdminPermissions.ArticleWrite);
    }

    internal static async Task<IResult> ReadArticleVaultRecoveryHistoryAsync(
        HttpContext context, IAedsEncoder aeds, CancellationToken cancellationToken)
    {
        EndpointUserContext authenticated = EndpointUserContext.From(context) with
        {
            SessionId = context.User.GetAdminSessionId()
        };
        if (!authenticated.IsAuthenticated || !authenticated.IsAdminPrincipal
            || authenticated.AdminPrincipalId <= 0 || string.IsNullOrWhiteSpace(authenticated.SessionId))
        {
            return AedsJsonResults.Unauthorized(aeds);
        }
        var parsed = await AedsJsonResults.ReadAsync<ArticleVaultRecoveryHistoryRequest>(context, aeds,
            AedsFrameType.ArticleVaultRecoveryHistoryRequest, ArticleVaultRecoveryHistoryRequestCodec.MaximumBytes,
            "article_vault_recovery_history_request_invalid", cancellationToken,
            static bytes => ArticleVaultRecoveryHistoryRequestCodec.Decode(bytes.Span));
        if (!parsed.IsSuccess)
        {
            return parsed.ToErrorResult(aeds);
        }
        ArticleVaultRecoveryHistoryRequest request = parsed.Value!;
        ArticleVaultRecoveryHistoryReader? reader = context.RequestServices.GetService<ArticleVaultRecoveryHistoryReader>();
        if (reader is null)
        {
            return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Generic503InfraFailure,
                "article_vault_trusted_site_composition_unavailable");
        }
        try
        {
            ArticleVaultRecoveryHistoryResponse response = await reader.ReadAsync(request, authenticated, cancellationToken);
            byte[] bytes = ArticleVaultOperationCodec.Serialize(response);
            if (bytes.Length > AedsJsonResults.MaxAuthoringFrameBytes)
            {
                return AedsJsonResults.BadRequest(aeds, "article_vault_recovery_history_response_budget_exceeded");
            }
            return BinaryResults.FrameRaw(aeds, AedsFrameType.ArticleVaultRecoveryHistoryResponse, bytes);
        }
        catch (ArticleVaultExecutionRejectedException)
        {
            // Never project store/parser excerpts or content into ordinary error transport.
            return AedsJsonResults.Error(aeds, ApiErrorTransportMappingId.Generic403Forbidden,
                "article_vault_recovery_history_not_authorized");
        }
    }
}
