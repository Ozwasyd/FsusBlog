namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(AdminSignInHistorySnapshot value)
    {
        if (value is null || value.SignIns is null || value.Generation <= 0 ||
            value.SignIns.Count > WireLimits.AdminSignInHistoryMaxItems)
            throw new ProtocolException("Invalid administrator sign-in history.");

        for (var index = 0; index < value.SignIns.Count; index++)
        {
            var signIn = value.SignIns[index];
            if (signIn is null)
                throw new ProtocolException("Invalid administrator sign-in interval.");
            var valid = signIn.State switch
            {
                AdminSignInState.Current => index == 0 && signIn.EndedAt == 0,
                AdminSignInState.Ended => signIn.EndedAt >= signIn.StartedAt && signIn.EndedAt < signIn.ExpiresAt,
                AdminSignInState.Expired => signIn.EndedAt == signIn.ExpiresAt,
                _ => false
            };
            if (!valid || signIn.StartedAt <= 0 || signIn.ExpiresAt <= signIn.StartedAt ||
                signIn.ExpiresAt > 8_640_000_000_000_000L)
                throw new ProtocolException("Invalid administrator sign-in interval.");
        }
    }
}
