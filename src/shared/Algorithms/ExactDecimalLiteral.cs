using System.Globalization;
using System.Numerics;
using System.Text.RegularExpressions;

namespace FsusBlog.Shared.Algorithms;

/// <summary>Exact, provider-neutral decimal literal identity without finite-precision rounding.</summary>
public static class ExactDecimalLiteral
{
    /// <summary>Normalizes decimal digits and an optional base-ten exponent without expanding the exponent.</summary>
    /// <param name="value">An optional sign, decimal digits, optional fraction and optional signed exponent.</param>
    /// <returns>A signed significant coefficient and optional exponent; all representations of zero return zero.</returns>
    /// <exception cref="InvalidOperationException">The input is not the supported decimal literal syntax.</exception>
    public static string Normalize(string value)
    {
        ArgumentNullException.ThrowIfNull(value);
        Match match = Regex.Match(value, "\\A(?<sign>[+-]?)(?<whole>[0-9]+)(?:\\.(?<fraction>[0-9]*))?(?:[eE](?<exponent>[+-]?[0-9]+))?\\z",
            RegexOptions.CultureInvariant, TimeSpan.FromSeconds(1));
        if (!match.Success)
            throw new InvalidOperationException("decimal_literal_syntax_unsupported");
        string fraction = match.Groups["fraction"].Value;
        string digits = (match.Groups["whole"].Value + fraction).TrimStart('0');
        if (digits.Length == 0)
            return "0";
        BigInteger scale = match.Groups["exponent"].Success
            ? BigInteger.Parse(match.Groups["exponent"].Value, CultureInfo.InvariantCulture) : BigInteger.Zero;
        scale -= fraction.Length;
        int end = digits.Length;
        while (digits[end - 1] == '0')
        {
            end--;
            scale++;
        }
        string coefficient = (match.Groups["sign"].Value == "-" ? "-" : "") + digits[..end];
        return scale.IsZero ? coefficient : coefficient + "e" + scale.ToString(CultureInfo.InvariantCulture);
    }
}
