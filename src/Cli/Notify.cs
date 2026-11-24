internal static partial class Cli
{
    private static async Task NotifyAsync(NpgsqlConnection connection, string recipient, string eventId, Stream input, CancellationToken ct)
    {
        if (!Guid.TryParseExact(recipient, "D", out var account) || account == Guid.Empty)
            throw new ArgumentException("Set ACCOUNT_ID to the intended user's database UUID.");
        var message = await ReadNoticeAsync(input, ct);
        await CurrentSchema.VerifyAsync(connection, ct);

        await using var transaction = await connection.BeginTransactionAsync(ct);
        InboxNoticeReceipt receipt;
        try
        {
            var inbox = new InboxStore(connection, transaction, account, fenceVisibleMessages: true);
            var sent = await inbox.SendNoticeAsync(eventId, message.Subject, message.Body, ct);
            receipt = new InboxNoticeReceipt(account, sent.Message.ConversationId, sent.Message.Id, sent.Replayed);
        }
        catch (BusinessException error)
        {
            throw new InvalidOperationException(error.Message, error);
        }

        await transaction.CommitAsync(ct);
        Console.WriteLine(JsonSerializer.Serialize(receipt, Json));
    }

    private static async Task<(string Subject, string Body)> ReadNoticeAsync(Stream input, CancellationToken ct)
    {
        using var document = await ReadInputJsonAsync(input, 96 * 1024, "Notice input exceeds 96 KiB.", ct);
        if (document.RootElement.ValueKind != JsonValueKind.Object)
            throw new ArgumentException("Expected an object with subject and body strings.");
        var fields = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var field in document.RootElement.EnumerateObject())
        {
            if (field.Value.ValueKind != JsonValueKind.String)
                throw new ArgumentException("Expected subject and body strings.");
            if (field.Name is not ("subject" or "body") || fields.ContainsKey(field.Name))
                throw new ArgumentException("Unexpected or repeated notice field.");
            fields.Add(field.Name, field.Value.GetString()!);
        }
        if (!fields.TryGetValue("subject", out var subject) || !fields.TryGetValue("body", out var body))
            throw new ArgumentException("Set both subject and body.");
        return (subject, body);
    }

    private sealed record InboxNoticeReceipt(Guid AccountId, long ConversationId, long MessageId, bool Replayed);
}
