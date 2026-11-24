internal static class SubscriptionPreferenceVectors
{
    internal static void Run(string fixtures)
    {
        var expected = VectorFixture.Hex(fixtures, "subscription-preference.hex");
        var preference = new SubscriptionPreferenceRequest("news+brief@example.test", WireLayouts.SubscriptionEmailChannel);
        if (!Wire.EncodeSubscriptionPreferenceRequest(preference).AsSpan().SequenceEqual(expected) ||
            Wire.DecodeSubscriptionPreferenceRequest(expected) != preference ||
            Wire.EncodeSubscriptionPreferenceRequest(preference with { Email = new string('x', WireLimits.SubscriptionEmailBytes) }).Length !=
                WireLimits.MaxSubscriptionPreferenceFrameBytes)
            throw new InvalidOperationException("Subscription preference diverges from the wire contract");

        var pod = Aeds.Decode(expected, FrameType.SubscriptionPreferenceRequest).ToArray();
        Reject(() => Decode(pod[..^1]));
        Reject(() => Decode([.. pod, 0]));
        var unknownChannel = pod.ToArray();
        BinaryPrimitives.WriteInt32LittleEndian(unknownChannel.AsSpan(unknownChannel.Length - 4), 0);
        Reject(() => Decode(unknownChannel));
        var invalidUtf8 = pod.ToArray();
        invalidUtf8[4] = 0xff;
        Reject(() => Decode(invalidUtf8));
        foreach (var value in new[] { "", "whitespace @example.test", "国际@example.test", new string('x', WireLimits.SubscriptionEmailBytes + 1) })
            Reject(() => Wire.EncodeSubscriptionPreferenceRequest(preference with { Email = value }));
    }

    private static SubscriptionPreferenceRequest Decode(byte[] pod) =>
        Wire.DecodeSubscriptionPreferenceRequest(Aeds.Encode(FrameType.SubscriptionPreferenceRequest, pod));

    private static void Reject(Action operation) =>
        ProtocolRejection.Assert(operation, "Invalid subscription preference accepted");
}
