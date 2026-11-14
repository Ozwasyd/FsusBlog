namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(RecoveryKeyOperation value)
    {
        if (value.Operation is not (1 or 2)) throw new ProtocolException("Invalid recovery key operation.");
    }

    internal static void Validate(RecoveryKeyIssued value)
    {
        if (!IsRecoveryKey(value.Key) || value.Version <= 0 || value.CreatedAt <= 0)
            throw new ProtocolException("Invalid recovery key receipt.");
    }

    internal static void Validate(RecoveryKeyStatus value) { }

    internal static void Validate(RecoveryKeyVerify value)
    {
        if (!IsRecoveryKey(value.Key)) throw new ProtocolException("Invalid recovery key.");
    }

    private static bool IsRecoveryKey(string key) =>
        key.Length == WireLimits.RecoveryKeyBytes && key.StartsWith("frk_", StringComparison.Ordinal) &&
        key[4..36].All(char.IsAsciiHexDigitLower) && key[36] == '_' &&
        key[37..].All(value => char.IsAsciiLetterOrDigit(value) || value is '-' or '_');
}
