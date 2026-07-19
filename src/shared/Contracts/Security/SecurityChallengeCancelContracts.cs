namespace FsusBlog.Shared.Contracts.Security;

/// <summary>
/// Revokes one server-owned challenge envelope without exposing a JSON fallback.
/// Identity and network bindings are derived again by the server.
/// </summary>
public sealed record class SecurityChallengeCancelBinaryRequest(
    string EnvelopeId,
    string Action,
    string RouteKey,
    string DeviceFingerprint,
    string PolicyVersion);
