namespace FsusBlog.Server.Interfaces;

public interface IPowRequest
{
    string PowSalt
    {
        get;
    }
    string PowSignature
    {
        get;
    }
    long PowTimestamp
    {
        get;
    }
    int Difficulty
    {
        get;
    }
    string PowNonce
    {
        get;
    }
    string BrowserFp
    {
        get;
    }
}
