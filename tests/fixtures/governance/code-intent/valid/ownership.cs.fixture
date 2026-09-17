public sealed class LeaseOwner
{
    // OWNERSHIP: Retirement rejects new leases while current readers retain the buffer.
    public void Retire()
    {
        _retired = true;
    }

    private bool _retired;
}
