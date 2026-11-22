using FsusBlog.V2.Contracts;

internal static class AdminSignInHistoryVectors
{
    private const long Hours2 = 7_200_000;
    private const long MaxDate = 8_640_000_000_000_000;

    internal static void Run(string fixtures)
    {
        var vectors = new (string Name, AdminSignInHistorySnapshot Value)[]
        {
            ("admin-sign-in-history.hex", Typical),
            ("admin-sign-in-history-empty.hex", new(1, [])),
            ("admin-sign-in-history-full.hex", new(2, Full(50))),
        };
        foreach (var (name, value) in vectors)
        {
            var expected = VectorFixture.Hex(fixtures, name);
            if (!Wire.EncodeAdminSignInHistorySnapshot(value).AsSpan().SequenceEqual(expected))
                throw new InvalidOperationException($"Administrator sign-in history differs from independent vector {name}");
            var decoded = Wire.DecodeAdminSignInHistorySnapshot(expected);
            if (decoded.Generation != value.Generation || !decoded.SignIns.SequenceEqual(value.SignIns))
                throw new InvalidOperationException($"Decoded administrator sign-in history differs from vector {name}");
        }

        var rows = Typical.SignIns;
        AdminSignInHistorySnapshot Edit(int index, AdminSignIn row) =>
            Typical with { SignIns = [.. rows.Select((item, at) => at == index ? row : item)] };
        foreach (var invalid in new[]
        {
            Typical with { Generation = 0 },
            Typical with { Generation = -1 },
            new AdminSignInHistorySnapshot(2, Full(51)),
            Typical with { SignIns = [rows[1], rows[0], rows[2], rows[3]] },
            Edit(1, rows[1] with { EndedAt = 0, State = AdminSignInState.Current }),
            Edit(0, rows[0] with { EndedAt = rows[0].StartedAt }),
            Edit(1, rows[1] with { EndedAt = rows[1].ExpiresAt }),
            Edit(1, rows[1] with { EndedAt = rows[1].StartedAt - 1 }),
            Edit(1, rows[1] with { EndedAt = 0 }),
            Edit(2, rows[2] with { EndedAt = rows[2].ExpiresAt - 1 }),
            Edit(2, rows[2] with { EndedAt = 0 }),
            Edit(3, rows[3] with { ExpiresAt = rows[3].StartedAt }),
            Edit(3, rows[3] with { ExpiresAt = rows[3].StartedAt - 1 }),
            Edit(1, rows[1] with { StartedAt = 0, EndedAt = 0 }),
            Edit(0, rows[0] with { StartedAt = -1 }),
            Edit(2, rows[2] with { ExpiresAt = MaxDate + 1, EndedAt = MaxDate + 1 }),
            Edit(1, rows[1] with { State = 0 }),
            Edit(1, rows[1] with { State = (AdminSignInState)4 }),
            Edit(1, rows[1] with { State = (AdminSignInState)255 }),
        })
            Reject(() => Wire.EncodeAdminSignInHistorySnapshot(invalid));

        var rejectPayloads = File.ReadAllLines(Path.Combine(fixtures, "admin-sign-in-history-reject.txt"))
            .Where(line => !string.IsNullOrWhiteSpace(line))
            .ToArray();
        if (rejectPayloads.Length != 23)
            throw new InvalidOperationException("Unexpected count of administrator sign-in history reject vectors");
        foreach (var line in rejectPayloads)
        {
            var payload = Convert.FromHexString(line.Split(' ', 2)[1].Trim());
            var frame = Aeds.Encode(FrameType.AdminSignInHistory, payload);
            Reject(() => Wire.DecodeAdminSignInHistorySnapshot(frame));
        }

        var typicalFrame = VectorFixture.Hex(fixtures, "admin-sign-in-history.hex");
        for (var length = 0; length < typicalFrame.Length; length++)
            Reject(() => Wire.DecodeAdminSignInHistorySnapshot(typicalFrame.AsSpan(0, length)));

        var wrongFrame = Aeds.Encode(FrameType.AdminSessionSnapshot, Aeds.Decode(typicalFrame, FrameType.AdminSignInHistory));
        Reject(() => Wire.DecodeAdminSignInHistorySnapshot(wrongFrame));
    }

    private static AdminSignInHistorySnapshot Typical { get; } = new(9_007_199_254_740_993, [
        new(1_800_000_000_000, 1_800_000_000_000 + Hours2, 0, AdminSignInState.Current),
        new(1_799_990_000_000, 1_799_990_000_000 + Hours2, 1_799_990_000_000, AdminSignInState.Ended),
        new(MaxDate - Hours2, MaxDate, MaxDate, AdminSignInState.Expired),
        new(1_799_980_000_000, 1_799_980_000_000 + Hours2, 1_799_981_234_567, AdminSignInState.Ended),
    ]);

    private static AdminSignIn[] Full(int count) =>
    [
        new(1_800_000_000_000, 1_800_000_000_000 + Hours2, 0, AdminSignInState.Current),
        .. Enumerable.Range(1, count - 1).Select(index =>
        {
            var started = 1_700_000_000_000 + index * 10_000_000L;
            return index % 2 == 1
                ? new AdminSignIn(started, started + Hours2, started + index * 1000L, AdminSignInState.Ended)
                : new AdminSignIn(started, started + Hours2, started + Hours2, AdminSignInState.Expired);
        }),
    ];

    private static void Reject(Action operation) =>
        ProtocolRejection.Assert(operation, "Invalid administrator sign-in history accepted");
}
