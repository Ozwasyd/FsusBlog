using static FsusBlog.Server.Infrastructure.AuthoringExtensions.AuthoringExtensionStateContract;

namespace FsusBlog.Server.Infrastructure.AuthoringExtensions;

/// <summary>
/// Canonical scope provenance adapter for the existing approval port. This leaf intentionally has
/// no production registration. The approval/state owners must first establish a single writer
/// lock order across Create uniqueness conflicts, Change, Complete, receipt, revoke and deletion.
/// A digest describes a held authorization; it does not establish global deadlock safety.
/// </summary>
public sealed class AuthoringExtensionScopeProvenanceAuthority(
    PostgresAuthoringExtensionScopeProvenanceStore store) : IAuthoringExtensionApprovalScopeAuthority
{
    public ValueTask<IAuthoringExtensionApprovalScope> AcquireAsync(HttpContext context,
        AuthoringApprovalOperation operation, AuthoringStateScope scope, AuthoringStateScope? destinationScope,
        CancellationToken cancellationToken)
    {
        ValidateRequest(operation, scope, destinationScope);
        throw new AuthoringExtensionContractException("scope_original_state_custody_required");
    }

    public ValueTask<IAuthoringExtensionApprovalScope> AcquireWithStateCustodyAsync(HttpContext context,
        AuthoringApprovalOperation operation, AuthoringStateScope scope, AuthoringStateScope? destinationScope,
        IAuthoringExtensionStateObservation stateCustody, CancellationToken cancellationToken)
    {
        ValidateRequest(operation, scope, destinationScope);
        return store.AcquireWithStateCustodyAsync(context, operation, scope, destinationScope, stateCustody, cancellationToken);
    }

    private static void ValidateRequest(AuthoringApprovalOperation operation, AuthoringStateScope scope,
        AuthoringStateScope? destinationScope)
    {
        ValidateScope(scope);
        Require(scope.DocumentId is null, "scope_document_authority_unavailable");
        Require(operation is AuthoringApprovalOperation.Deletion && destinationScope is null ||
            operation is AuthoringApprovalOperation.Migration && destinationScope is not null, "scope_operation_invalid");
        if (destinationScope is not null)
        {
            ValidateScope(destinationScope);
            Require(destinationScope.DocumentId is null, "scope_document_authority_unavailable");
            Require(scope != destinationScope && scope.ExtensionId == destinationScope.ExtensionId &&
                scope.SiteId == destinationScope.SiteId && scope.UserId == destinationScope.UserId,
                "scope_migration_owner_mismatch");
        }
    }
}
