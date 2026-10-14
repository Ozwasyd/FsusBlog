using System.Security.Claims;

using FsusBlog.Server.Infrastructure.Security;
using FsusBlog.Server.Services.Security;

namespace FsusBlog.Server.Infrastructure.Auth;

/// <summary>
/// Carries the original authentication-time projection observation within its request.
/// Reading it grants no permission and performs no later expiry or revocation observation.
/// </summary>
internal sealed class AdminSessionRequestValidation
{
    private static readonly object s_itemKey = new();
    private readonly HttpContext _context;
    private readonly ClaimsPrincipal? _principal;
    private readonly AdminSessionValidationResult? _result;

    private AdminSessionRequestValidation(
        HttpContext context,
        ClaimsPrincipal? principal,
        AdminSessionValidationResult? result = null)
    {
        _context = context;
        _principal = principal;
        _result = result;
    }

    internal static AdminSessionRequestValidation Begin(HttpContext context, ClaimsPrincipal? principal)
    {
        // Retire an earlier observation before validation can await or invoke another owner.
        var pending = new AdminSessionRequestValidation(context, principal);
        context.Items[s_itemKey] = pending;
        return pending;
    }

    internal void Complete(AdminSessionValidationResult result)
    {
        if (_principal is null
            || !result.TryGetProjectionValidation(_principal, out _)
            || !_context.Items.TryGetValue(s_itemKey, out object? current)
            || !ReferenceEquals(current, this))
        {
            return;
        }

        // The immutable completed state replaces only this still-current pending state.
        _context.Items[s_itemKey] = new AdminSessionRequestValidation(_context, _principal, result);
    }

    internal static bool TryGet(HttpContext context, out AdminSessionProjectionValidationResult validation)
    {
        validation = default;
        if (!context.Items.TryGetValue(s_itemKey, out object? value)
            || value is not AdminSessionRequestValidation state
            || !ReferenceEquals(state._context, context)
            || state._result is null)
        {
            return false;
        }

        ClaimsPrincipal principal = context.User;
        if (!ReferenceEquals(state._principal, principal)
            || !state._result.TryGetProjectionValidation(principal, out validation))
        {
            return false;
        }

        // Claims access may call custom principal code; a replaced request state stays retired.
        if (!ReferenceEquals(context.User, principal)
            || !context.Items.TryGetValue(s_itemKey, out object? current)
            || !ReferenceEquals(current, state))
        {
            validation = default;
            return false;
        }

        return true;
    }
}
