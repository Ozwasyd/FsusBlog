namespace FsusBlog.Shared.Contracts.AuthSystem;

/// <summary>Defines the current enrollment and account lifecycle states without legacy identity inference.</summary>
public enum AccountRegistrationState
{
    Provisional = 1,
    Active = 2,
    Suspended = 3,
    Closed = 4
}

/// <summary>Owns the exact persisted registration-state values for every current account consumer.</summary>
public static class AccountRegistrationStates
{
    public const string Provisional = "provisional";
    public const string Active = "active";
    public const string Suspended = "suspended";
    public const string Closed = "closed";

    /// <summary>Admits only the exact active state without treating missing or legacy values as enrolled.</summary>
    public static bool IsActive(string? value)
        => string.Equals(value, Active, StringComparison.Ordinal);

    /// <summary>Reads an exact current registration state and refuses unknown or normalized replacements.</summary>
    public static bool TryParse(string? value, out AccountRegistrationState state)
    {
        state = value switch
        {
            Provisional => AccountRegistrationState.Provisional,
            Active => AccountRegistrationState.Active,
            Suspended => AccountRegistrationState.Suspended,
            Closed => AccountRegistrationState.Closed,
            _ => default
        };
        return state != default;
    }

    /// <summary>Projects a validated registration state to its unchanged persisted spelling.</summary>
    public static string ToWireValue(AccountRegistrationState state)
        => state switch
        {
            AccountRegistrationState.Provisional => Provisional,
            AccountRegistrationState.Active => Active,
            AccountRegistrationState.Suspended => Suspended,
            AccountRegistrationState.Closed => Closed,
            _ => throw new ArgumentOutOfRangeException(nameof(state))
        };
}
