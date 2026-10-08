namespace FsusBlog.Shared.Contracts.AuthSystem;

/// <summary>Distinguishes ordinary current accounts from the separately authenticated administrator plane.</summary>
public enum CurrentIdentityKind
{
    AnonymousAccount = 1,
    AdminPrincipal = 2
}

/// <summary>Owns the exact current identity kinds shared by accounts and the independent admin principal.</summary>
public static class AnonymousIdentityRuntime
{
    public const string AnonymousAccountKind = "anonymous_account";
    public const string AdminPrincipalKind = "admin_principal";
    public const string AccountSubjectHashClaim = "account_subject_hash";

    /// <summary>Reads an exact current identity kind without normalizing legacy or unknown values.</summary>
    public static bool TryParse(string? value, out CurrentIdentityKind kind)
    {
        kind = value switch
        {
            AnonymousAccountKind => CurrentIdentityKind.AnonymousAccount,
            AdminPrincipalKind => CurrentIdentityKind.AdminPrincipal,
            _ => default
        };
        return kind != default;
    }

    /// <summary>Projects a validated current identity kind to its unchanged database and claim spelling.</summary>
    public static string ToWireValue(CurrentIdentityKind kind)
        => kind switch
        {
            CurrentIdentityKind.AnonymousAccount => AnonymousAccountKind,
            CurrentIdentityKind.AdminPrincipal => AdminPrincipalKind,
            _ => throw new ArgumentOutOfRangeException(nameof(kind))
        };
}
