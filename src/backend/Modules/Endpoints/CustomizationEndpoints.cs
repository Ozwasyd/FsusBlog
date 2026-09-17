using System.Security.Cryptography;
using System.Text.Json;

using FsusBlog.Server.Infrastructure.Auth;
using FsusBlog.Server.Infrastructure.Customization;

using Microsoft.AspNetCore.Mvc;

namespace FsusBlog.Server.Modules.Endpoints;

/// <summary>
/// HTTP API for the customization profile / draft / version / change-set bounded context.
/// </summary>
public static class CustomizationEndpoints
{
    private const string RoutePrefix = "/api/binary/author/ops/customization";

    public static IEndpointRouteBuilder MapCustomizationEndpoints(this IEndpointRouteBuilder app)
    {
        RouteGroupBuilder group = app.MapGroup(RoutePrefix)
            .WithTags("Customization")
            .RequireAdminPermission(AdminPermissions.SystemConfig)
            .RequireRateLimiting("fixed_ip");

        MapProfileEndpoints(group);
        return app;
    }

    private static void MapProfileEndpoints(RouteGroupBuilder group)
    {
        group.MapGet("/profiles", ListProfilesAsync);
        group.MapPost("/profiles", CreateProfileAsync);
        group.MapGet("/profiles/{id:long}", GetProfileAsync);
        group.MapGet("/profiles/{id:long}/versions", ListVersionsAsync);
        group.MapGet("/profiles/{id:long}/draft", GetDraftAsync);
        group.MapPut("/profiles/{id:long}/draft", UpsertDraftAsync);
        group.MapGet("/profiles/{id:long}/changesets", ListChangeSetsAsync);
    }

    private static async Task<IResult> ListProfilesAsync(
        HttpContext httpContext,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        // Resolve the authenticated user id from the admin principal.
        // The admin identity carries a stable account id claim.
        int userId = ResolveAdminUserId(httpContext);

        IReadOnlyList<CustomizationProfile> profiles = await store.ListProfilesAsync(userId, cancellationToken);
        return Results.Ok(profiles.Select(ToProfileDto));
    }

    private static async Task<IResult> CreateProfileAsync(
        HttpContext httpContext,
        [FromBody] CreateCustomizationProfileRequest request,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(request.Name))
        {
            return Results.BadRequest(new
            {
                error = "validation",
                message = "Name is required."
            });
        }

        int userId = ResolveAdminUserId(httpContext);
        DateTime now = DateTime.UtcNow;

        CustomizationProfile profile = await store.CreateProfileAsync(userId, request.Name.Trim(), now, cancellationToken);
        return Results.Created($"{RoutePrefix}/profiles/{profile.Id}", ToProfileDto(profile));
    }

    private static async Task<IResult> GetProfileAsync(
        long id,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        CustomizationProfile? profile = await store.GetProfileAsync(id, cancellationToken);
        if (profile is null)
        {
            return Results.NotFound(new
            {
                error = "not_found",
                message = "Profile not found."
            });
        }

        return Results.Ok(ToProfileDto(profile));
    }

    private static async Task<IResult> ListVersionsAsync(
        long id,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        CustomizationProfile? profile = await store.GetProfileAsync(id, cancellationToken);
        if (profile is null)
        {
            return Results.NotFound(new
            {
                error = "not_found",
                message = "Profile not found."
            });
        }

        IReadOnlyList<CustomizationVersion> versions = await store.ListVersionsAsync(id, cancellationToken);
        return Results.Ok(versions.Select(ToVersionDto));
    }

    private static async Task<IResult> GetDraftAsync(
        long id,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        CustomizationProfile? profile = await store.GetProfileAsync(id, cancellationToken);
        if (profile is null)
        {
            return Results.NotFound(new
            {
                error = "not_found",
                message = "Profile not found."
            });
        }

        CustomizationDraft? draft = await store.GetDraftAsync(id, cancellationToken);
        if (draft is null)
        {
            return Results.Ok(new
            {
                profileId = id,
                exists = false,
                payload = "{}",
                versionId = (long?)null,
                etag = (string?)null
            });
        }

        return Results.Ok(ToDraftDto(draft));
    }

    private static async Task<IResult> UpsertDraftAsync(
        long id,
        HttpContext httpContext,
        [FromBody] UpsertCustomizationDraftRequest request,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        CustomizationProfile? profile = await store.GetProfileAsync(id, cancellationToken);
        if (profile is null)
        {
            return Results.NotFound(new
            {
                error = "not_found",
                message = "Profile not found."
            });
        }

        // Read If-Match header for ETag-based optimistic concurrency.
        string? expectedEtag = httpContext.Request.Headers.IfMatch.FirstOrDefault();
        if (!string.IsNullOrWhiteSpace(expectedEtag))
        {
            // Strip quotes from the ETag value as per HTTP spec.
            expectedEtag = expectedEtag.Trim('"');
        }

        DateTime now = DateTime.UtcNow;
        string newEtag = ComputeDraftEtag();

        CustomizationDraft? draft = await store.UpsertDraftAsync(
            id,
            request.VersionId,
            request.Payload,
            newEtag,
            expectedEtag,
            now,
            cancellationToken);

        if (draft is null)
        {
            // ETag mismatch - conflict.
            return Results.Conflict(new
            {
                error = "conflict",
                message = "Draft was modified by another request. Re-fetch and retry."
            });
        }

        httpContext.Response.Headers["ETag"] = $"\"{draft.Etag}\"";
        return Results.Ok(ToDraftDto(draft));
    }

    private static async Task<IResult> ListChangeSetsAsync(
        long id,
        [FromServices] ICustomizationProfileStore store,
        CancellationToken cancellationToken)
    {
        CustomizationProfile? profile = await store.GetProfileAsync(id, cancellationToken);
        if (profile is null)
        {
            return Results.NotFound(new
            {
                error = "not_found",
                message = "Profile not found."
            });
        }

        IReadOnlyList<CustomizationChangeSet> changeSets = await store.ListChangeSetsAsync(id, cancellationToken);
        return Results.Ok(changeSets.Select(ToChangeSetDto));
    }

    private static int ResolveAdminUserId(HttpContext httpContext)
    {
        // The admin principal carries an account_id claim.
        string? accountIdClaim = httpContext.User.FindFirst("account_id")?.Value;
        if (string.IsNullOrWhiteSpace(accountIdClaim) || !int.TryParse(accountIdClaim, out int userId))
        {
            // Fallback: derive from the sub claim or the admin_id claim.
            string? adminIdClaim = httpContext.User.FindFirst("admin_id")?.Value;
            if (!string.IsNullOrWhiteSpace(adminIdClaim) && int.TryParse(adminIdClaim, out int fallbackId))
            {
                return fallbackId;
            }

            // Use a stable hash of the subject as a fallback.
            string? sub = httpContext.User.FindFirst("sub")?.Value
                ?? httpContext.User.FindFirst("http://schemas.xmlsoap.org/ws/2005/05/identity/claims/nameidentifier")?.Value
                ?? "unknown";

            byte[] hash = SHA256.HashData(System.Text.Encoding.UTF8.GetBytes(sub));
            return Math.Abs(BitConverter.ToInt32(hash, 0)) % 100000 + 1;
        }

        return userId;
    }

    private static string ComputeDraftEtag()
    {
        byte[] nonce = RandomNumberGenerator.GetBytes(16);
        return Convert.ToHexString(nonce).ToLowerInvariant();
    }

    private static object ToProfileDto(CustomizationProfile profile)
        => new
        {
            profile.Id,
            profile.UserId,
            profile.Name,
            profile.CreatedAtUtc,
            profile.UpdatedAtUtc
        };

    private static object ToVersionDto(CustomizationVersion version)
        => new
        {
            version.Id,
            version.ProfileId,
            version.Version,
            payload = DeserializePayload(version.Payload),
            version.CreatedAtUtc
        };

    private static object ToDraftDto(CustomizationDraft draft)
        => new
        {
            draft.Id,
            draft.ProfileId,
            draft.VersionId,
            payload = DeserializePayload(draft.Payload),
            draft.Etag,
            draft.UpdatedAtUtc,
            exists = true
        };

    private static object ToChangeSetDto(CustomizationChangeSet changeSet)
        => new
        {
            changeSet.Id,
            changeSet.ProfileId,
            changeSet.FromVersionId,
            changeSet.ToVersionId,
            changes = DeserializePayload(changeSet.Changes),
            changeSet.CreatedAtUtc
        };

    private static object? DeserializePayload(string payload)
    {
        if (string.IsNullOrWhiteSpace(payload))
        {
            return null;
        }

        try
        {
            return JsonSerializer.Deserialize<object>(payload);
        }
        catch (JsonException)
        {
            return payload;
        }
    }
}
