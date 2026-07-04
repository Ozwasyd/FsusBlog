using System.Text.Json;
using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Helpers;
using FsusBlog.Server.Infrastructure.Integrity;
using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Modules.Endpoints;

public static class AdminIntegrityConsoleEndpoints
{
    private const string AdminSensitiveAction = "admin-sensitive";
    private const string MfaProofHeader = "X-Fsus-Mfa-Proof";

    public static IEndpointRouteBuilder MapAdminIntegrityConsoleEndpoints(this IEndpointRouteBuilder app)
    {
        var group = app.MapGroup("/api/admin/integrity/console")
            .WithTags("AdminIntegrityConsole")
            .RequireAdminPermission(AdminPermissions.SystemConfig);

        group.MapGet(string.Empty, async (
            int? articleId,
            long? articleRevisionId,
            int? revisionNo,
            HttpContext context,
            IIntegrityAdminConsoleService service,
            CancellationToken cancellationToken) =>
        {
            MarkNoStore(context);
            IntegrityAdminConsoleResponse response = await service.GetConsoleAsync(
                new IntegrityAdminConsoleQuery(articleId, articleRevisionId, revisionNo),
                cancellationToken);
            return Results.Json(response, IntegrityVerificationJson.Options);
        }).RequireRateLimiting("fixed_ip");

        group.MapPost("/proofs/{proofId:long}/retry", async (
            long proofId,
            HttpContext context,
            IIntegrityAdminConsoleService service,
            IAdminPrincipalService adminPrincipals,
            CancellationToken cancellationToken) =>
        {
            MarkNoStore(context);
            IResult? stepUp = await RequireAdminSensitiveStepUpAsync(context, adminPrincipals, cancellationToken);
            if (stepUp is not null)
            {
                return stepUp;
            }

            try
            {
                IntegrityAdminRetryResponse response = await service.RetryProofAsync(proofId, cancellationToken);
                return Results.Json(response, IntegrityVerificationJson.Options);
            }
            catch (KeyNotFoundException)
            {
                return Results.Json(
                    new { code = "integrity_proof_not_found", message = "Publish proof not found." },
                    IntegrityVerificationJson.Options,
                    statusCode: StatusCodes.Status404NotFound);
            }
            catch (InvalidOperationException ex)
            {
                return Results.Json(
                    new { code = "integrity_proof_retry_rejected", message = ex.Message },
                    IntegrityVerificationJson.Options,
                    statusCode: StatusCodes.Status409Conflict);
            }
        }).RequireRateLimiting("fixed_ip");

        return app;
    }

    private static async Task<IResult?> RequireAdminSensitiveStepUpAsync(
        HttpContext context,
        IAdminPrincipalService adminPrincipals,
        CancellationToken cancellationToken)
    {
        if (!context.User.TryGetAdminPrincipalId(out long adminPrincipalId) ||
            string.IsNullOrWhiteSpace(context.User.GetAdminSessionId()))
        {
            return Results.Unauthorized();
        }

        string adminSessionId = context.User.GetAdminSessionId()!;
        if (!TrustedRequestOrigin.RequireTrustedOriginOrReferer(context))
        {
            return Results.Json(
                new { code = "origin_not_allowed", message = "Request origin is not trusted." },
                IntegrityVerificationJson.Options,
                statusCode: StatusCodes.Status403Forbidden);
        }

        string proofToken = context.Request.Headers.TryGetValue(MfaProofHeader, out var values)
            ? values.ToString().Trim()
            : string.Empty;
        if (string.IsNullOrWhiteSpace(proofToken) ||
            !await adminPrincipals.ValidateAndConsumeAdminStepUpProofTokenAsync(
                adminPrincipalId,
                adminSessionId,
                AdminSensitiveAction,
                proofToken,
                cancellationToken))
        {
            return Results.Json(
                new { code = "mfa_proof_required", message = "Admin step-up proof is required." },
                IntegrityVerificationJson.Options,
                statusCode: StatusCodes.Status428PreconditionRequired);
        }

        return null;
    }

    private static void MarkNoStore(HttpContext context)
    {
        context.Response.Headers.CacheControl = "no-store";
        context.Response.Headers.Pragma = "no-cache";
    }
}
