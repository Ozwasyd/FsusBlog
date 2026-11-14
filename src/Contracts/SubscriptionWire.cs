namespace FsusBlog.V2.Contracts;

public static partial class Wire
{
    internal static void Validate(SubscriptionPreferenceRequest request)
    {
        if (string.IsNullOrEmpty(request.Email) || request.Email.Length > WireLimits.SubscriptionEmailBytes ||
            !request.Email.All(c => c is >= '!' and <= '~') ||
            request.Channel is not (WireLayouts.SubscriptionRssChannel or WireLayouts.SubscriptionEmailChannel))
            throw new ProtocolException("Invalid subscription preference request");
    }
}
