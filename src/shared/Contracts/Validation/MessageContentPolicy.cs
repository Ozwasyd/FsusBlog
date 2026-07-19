using System.Globalization;
using System.Text;

namespace FsusBlog.Shared.Contracts.Validation;

public enum MessageContentViolation
{
    None = 0,
    Empty = 1,
    ScalarLimit = 2,
    GraphemeLimit = 3,
    Utf8ByteLimit = 4
}

public readonly record struct MessageContentValidation(
    bool IsValid,
    string Value,
    MessageContentViolation Violation)
{
    public static MessageContentValidation Valid(string value) => new(true, value, MessageContentViolation.None);

    public static MessageContentValidation Invalid(string value, MessageContentViolation violation) => new(false, value, violation);
}

public static class MessageContentPolicy
{
    public const int SubjectMaxScalars = 320;
    public const int SubjectMaxGraphemes = 160;
    public const int SubjectMaxUtf8Bytes = 640;
    public const int BodyMaxScalars = 8000;
    public const int BodyMaxGraphemes = 4000;
    public const int BodyMaxUtf8Bytes = 16000;
    public const int PreviewMaxGraphemes = 96;
    public const int MaxRequestFrameBytes = 20 * 1024;

    public static MessageContentValidation ValidateSubject(string? input, string fallback)
    {
        string value = string.IsNullOrWhiteSpace(input) ? fallback : input;
        return Validate(value, SubjectMaxScalars, SubjectMaxGraphemes, SubjectMaxUtf8Bytes, allowBlank: false);
    }

    public static MessageContentValidation ValidateBody(string? input)
        => Validate(input ?? string.Empty, BodyMaxScalars, BodyMaxGraphemes, BodyMaxUtf8Bytes, allowBlank: false);

    public static string CreatePreview(string value)
    {
        int[] boundaries = StringInfo.ParseCombiningCharacters(value);
        if (boundaries.Length <= PreviewMaxGraphemes)
        {
            return value;
        }

        return string.Concat(value.AsSpan(0, boundaries[PreviewMaxGraphemes]), "...");
    }

    private static MessageContentValidation Validate(
        string value,
        int maxScalars,
        int maxGraphemes,
        int maxUtf8Bytes,
        bool allowBlank)
    {
        if (!allowBlank && string.IsNullOrWhiteSpace(value))
        {
            return MessageContentValidation.Invalid(value, MessageContentViolation.Empty);
        }

        int scalarCount = 0;
        foreach (Rune _ in value.EnumerateRunes())
        {
            scalarCount++;
            if (scalarCount > maxScalars)
            {
                return MessageContentValidation.Invalid(value, MessageContentViolation.ScalarLimit);
            }
        }

        if (StringInfo.ParseCombiningCharacters(value).Length > maxGraphemes)
        {
            return MessageContentValidation.Invalid(value, MessageContentViolation.GraphemeLimit);
        }

        if (Encoding.UTF8.GetByteCount(value) > maxUtf8Bytes)
        {
            return MessageContentValidation.Invalid(value, MessageContentViolation.Utf8ByteLimit);
        }

        return MessageContentValidation.Valid(value);
    }
}
