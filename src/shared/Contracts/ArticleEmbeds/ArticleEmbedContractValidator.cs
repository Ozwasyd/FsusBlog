using System.Security.Cryptography;

namespace FsusBlog.Shared.Contracts.ArticleEmbeds;

/// <summary>Independent fail-closed validator for provider requests, results and shared dependency coordinates.</summary>
public static class ArticleEmbedContractValidator
{
    public static ArticleEmbedProviderRequest Seal(ArticleEmbedProviderRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ArticleEmbedProviderRequest unsigned = request with
        {
            RequestDigest = string.Empty
        };
        return unsigned with
        {
            RequestDigest = ArticleEmbedContractDigest.ComputeRequest(unsigned)
        };
    }

    public static ArticleEmbedDependencyCoordinate Seal(ArticleEmbedDependencyCoordinate coordinate)
    {
        ArgumentNullException.ThrowIfNull(coordinate);
        ArticleEmbedDependencyCoordinate unsigned = coordinate with
        {
            DependencyDigest = string.Empty
        };
        return unsigned with
        {
            DependencyDigest = ArticleEmbedContractDigest.ComputeDependency(unsigned)
        };
    }

    public static ArticleEmbedProviderResult Seal(ArticleEmbedProviderResult result)
    {
        ArgumentNullException.ThrowIfNull(result);
        ArticleEmbedProviderResult unsigned = result with
        {
            ResultDigest = string.Empty
        };
        return unsigned with
        {
            ResultDigest = ArticleEmbedContractDigest.ComputeResult(unsigned)
        };
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedProviderRequest? request)
    {
        if (request is null)
        {
            return Invalid("article_embed_request_missing");
        }
        if (request.Schema != ArticleEmbedSchemas.ProviderRequest
            || request.SchemaVersion != ArticleEmbedSchemas.Version)
        {
            return Invalid("article_embed_request_schema_unknown");
        }
        if (!IsIdentifier(request.RequestId)
            || !ArticleEmbedTargetCodec.IsPortableArticleIdentity(request.HostPortableArticleIdentity)
            || request.HostDocument is null
            || !IsIdentifier(request.HostDocument.Id)
            || request.HostDocument.Epoch < 1
            || request.SourceRevision < 1)
        {
            return Invalid("article_embed_host_coordinate_invalid");
        }
        if (!request.AbortSignal.CanBeCanceled)
        {
            return Invalid("article_embed_abort_signal_required");
        }
        if (request.Directive is null
            || request.Directive.ParserContract != ArticleEmbedSchemas.ParserContract
            || request.Directive.RawRange is null
            || request.Directive.RawRange.Start < 0
            || request.Directive.RawRange.End <= request.Directive.RawRange.Start)
        {
            return Invalid("article_embed_directive_projection_invalid");
        }
        if (!Enum.IsDefined(request.RequestedScope))
        {
            return Invalid("article_embed_scope_unknown");
        }

        ArticleEmbedValidationResult targetValidation = ArticleEmbedTargetCodec.Validate(request.Target);
        if (!targetValidation.IsValid)
        {
            return targetValidation;
        }
        if (request.Directive.Mode != request.Target.Kind
            || request.Directive.TargetToken != ArticleEmbedTargetCodec.Encode(request.Target))
        {
            return Invalid("article_embed_directive_target_binding_mismatch");
        }
        if (request.Actor is null
            || !IsContextIdentity(request.Actor.ActorIdentity)
            || !IsContextIdentity(request.Actor.SiteIdentity)
            || !ArticleEmbedContractDigest.IsSha256(request.Actor.PermissionContextDigest))
        {
            return Invalid("article_embed_actor_context_invalid");
        }
        if (request.Runtime is null
            || !IsIdentifier(request.Runtime.ProviderId)
            || request.Runtime.ProviderVersion < 1
            || request.Runtime.RuntimeVersion != ArticleEmbedSchemas.ProviderRuntime
            || !ArticleEmbedContractDigest.IsSha256(request.Runtime.RuntimeDigest))
        {
            return Invalid("article_embed_runtime_context_invalid");
        }
        if (!ArticleEmbedContractDigest.IsSha256(request.ContentDigest))
        {
            return Invalid("article_embed_content_digest_invalid");
        }
        if (!DigestEquals(request.RequestDigest, ArticleEmbedContractDigest.ComputeRequest(request)))
        {
            return Invalid("article_embed_request_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    public static ArticleEmbedValidationResult Validate(
        ArticleEmbedProviderResult? result,
        ArticleEmbedProviderRequest? request)
    {
        ArticleEmbedValidationResult requestValidation = Validate(request);
        if (!requestValidation.IsValid)
        {
            return requestValidation;
        }
        if (result is null)
        {
            return Invalid("article_embed_result_missing");
        }
        if (result.Schema != ArticleEmbedSchemas.ProviderResult
            || result.SchemaVersion != ArticleEmbedSchemas.Version)
        {
            return Invalid("article_embed_result_schema_unknown");
        }
        if (result.RequestId != request!.RequestId || !DigestEquals(result.RequestDigest, request.RequestDigest))
        {
            return Invalid("article_embed_result_request_binding_mismatch");
        }
        if (!Enum.IsDefined(result.Status)
            || !Enum.IsDefined(result.Visibility)
            || !Enum.IsDefined(result.Lifecycle)
            || !Enum.IsDefined(result.Permission))
        {
            return Invalid("article_embed_result_status_unknown");
        }
        if (!ValidateBudgets(result.Budgets))
        {
            return Invalid("article_embed_result_budgets_invalid");
        }
        if (!DigestEquals(result.ResultDigest, ArticleEmbedContractDigest.ComputeResult(result)))
        {
            return Invalid("article_embed_result_digest_mismatch");
        }

        return result.Status switch
        {
            ArticleEmbedProviderResultStatus.Resolved => ValidateResolved(result, request),
            ArticleEmbedProviderResultStatus.Failed => ValidateFailure(result),
            _ => Invalid("article_embed_result_status_unknown")
        };
    }

    public static ArticleEmbedValidationResult Validate(ArticleEmbedDependencyCoordinate? coordinate)
    {
        if (coordinate is null)
        {
            return Invalid("article_embed_dependency_coordinate_missing");
        }
        if (coordinate.Schema != ArticleEmbedSchemas.DependencyCoordinate
            || coordinate.SchemaVersion != ArticleEmbedSchemas.Version)
        {
            return Invalid("article_embed_dependency_schema_unknown");
        }
        ArticleEmbedValidationResult target = ArticleEmbedTargetCodec.Validate(coordinate.Target);
        if (!target.IsValid)
        {
            return target;
        }
        if (coordinate.ResolvedRevision < 1
            || !IsIdentifier(coordinate.TargetVersionIdentity)
            || !IsIdentifier(coordinate.ProjectionIdentity)
            || !ArticleEmbedContractDigest.IsSha256(coordinate.ProjectionDigest))
        {
            return Invalid("article_embed_dependency_coordinate_invalid");
        }
        if (!DigestEquals(coordinate.DependencyDigest, ArticleEmbedContractDigest.ComputeDependency(coordinate)))
        {
            return Invalid("article_embed_dependency_digest_mismatch");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    private static ArticleEmbedValidationResult ValidateResolved(
        ArticleEmbedProviderResult result,
        ArticleEmbedProviderRequest request)
    {
        if (result.Error is not null
            || result.Coordinate is null
            || result.Projection is null
            || result.Attribution is null)
        {
            return Invalid("article_embed_resolved_payload_incomplete");
        }
        ArticleEmbedValidationResult coordinate = Validate(result.Coordinate);
        if (!coordinate.IsValid)
        {
            return coordinate;
        }
        if (result.Coordinate.Target != request.Target
            || result.Projection.ProjectionIdentity != result.Coordinate.ProjectionIdentity
            || !DigestEquals(result.Projection.ContentDigest, result.Coordinate.ProjectionDigest)
            || !Enum.IsDefined(result.Projection.Kind)
            || result.Attribution.SourcePortableArticleIdentity != request.Target.PortableArticleIdentity
            || result.Attribution.SourceRevision != result.Coordinate.ResolvedRevision
            || !IsSafeDisplayText(result.Attribution.DisplayText)
            || !DigestEquals(result.Attribution.AttributionDigest, ArticleEmbedContractDigest.ComputeAttribution(
                result.Attribution.SourcePortableArticleIdentity,
                result.Attribution.SourceRevision,
                result.Attribution.DisplayText))
            || result.Permission != ArticleEmbedPermissionStatus.Allowed)
        {
            return Invalid("article_embed_resolved_payload_mismatch");
        }

        if (request.RequestedScope == ArticleEmbedRequestedScope.PublicationPlan)
        {
            return result.Visibility == ArticleEmbedVisibilityStatus.Public
                && result.Lifecycle == ArticleEmbedLifecycleStatus.Published
                ? ArticleEmbedValidationResult.Valid()
                : Invalid("article_embed_publication_target_not_frozen_public");
        }
        if (result.Visibility == ArticleEmbedVisibilityStatus.Unknown
            || result.Lifecycle is ArticleEmbedLifecycleStatus.Archived
                or ArticleEmbedLifecycleStatus.Deleted
                or ArticleEmbedLifecycleStatus.Unknown)
        {
            return Invalid("article_embed_authoring_target_unavailable");
        }
        return ArticleEmbedValidationResult.Valid();
    }

    private static ArticleEmbedValidationResult ValidateFailure(ArticleEmbedProviderResult result)
    {
        if (result.Error is null
            || result.Coordinate is not null
            || result.Projection is not null
            || result.Attribution is not null
            || !Enum.IsDefined(result.Error.Code)
            || !IsReasonCode(result.Error.SafeReasonCode))
        {
            return Invalid("article_embed_failed_payload_invalid");
        }

        bool statusMatches = result.Error.Code switch
        {
            ArticleEmbedErrorCode.PermissionDenied => result.Permission == ArticleEmbedPermissionStatus.Denied,
            ArticleEmbedErrorCode.PermissionUnknown => result.Permission == ArticleEmbedPermissionStatus.Unknown,
            ArticleEmbedErrorCode.Private => result.Visibility == ArticleEmbedVisibilityStatus.Private,
            ArticleEmbedErrorCode.Draft => result.Lifecycle == ArticleEmbedLifecycleStatus.Draft,
            ArticleEmbedErrorCode.Unpublished => result.Lifecycle != ArticleEmbedLifecycleStatus.Published,
            ArticleEmbedErrorCode.Archived => result.Lifecycle == ArticleEmbedLifecycleStatus.Archived,
            ArticleEmbedErrorCode.Deleted => result.Lifecycle == ArticleEmbedLifecycleStatus.Deleted,
            _ => true
        };
        return statusMatches
            ? ArticleEmbedValidationResult.Valid()
            : Invalid("article_embed_error_status_mismatch");
    }

    private static bool ValidateBudgets(ArticleEmbedBudgetObservation? budgets)
        => budgets is not null
            && budgets.Depth >= 0
            && budgets.Nodes >= 0
            && budgets.Bytes >= 0
            && budgets.ElapsedMilliseconds >= 0;

    private static bool IsIdentifier(string? value)
    {
        if (value is null || value.Length is < 1 or > 160)
        {
            return false;
        }
        foreach (char character in value)
        {
            if (char.IsWhiteSpace(character) || char.IsControl(character) || character is '/' or '\\')
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsContextIdentity(string? value)
        => IsIdentifier(value) && value!.Contains(':', StringComparison.Ordinal);

    private static bool IsSafeDisplayText(string? value)
    {
        if (value is null || value.Length > 512)
        {
            return false;
        }
        foreach (char character in value)
        {
            if (char.IsControl(character) && character is not '\t' and not '\n')
            {
                return false;
            }
        }
        return true;
    }

    private static bool IsReasonCode(string? value)
    {
        if (value is null || value.Length is < 3 or > 128)
        {
            return false;
        }
        foreach (char character in value)
        {
            if (!((character >= 'a' && character <= 'z')
                || (character >= '0' && character <= '9')
                || character is '_' or '-'))
            {
                return false;
            }
        }
        return true;
    }

    private static bool DigestEquals(string? supplied, string expected)
    {
        if (!ArticleEmbedContractDigest.IsSha256(supplied))
        {
            return false;
        }
        return CryptographicOperations.FixedTimeEquals(
            Convert.FromHexString(supplied!),
            Convert.FromHexString(expected));
    }

    private static ArticleEmbedValidationResult Invalid(string reasonCode)
        => ArticleEmbedValidationResult.Invalid(reasonCode);
}
