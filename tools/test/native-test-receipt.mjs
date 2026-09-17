const sha256Pattern = /^sha256:[0-9a-f]{64}$/u;

function fail(errors, message)
{
    errors.push(message);
}

export function validateNativeReceipt(receipt, profile, target, { expectedCommit = null } = {})
{
    const errors = [];
    if (receipt?.schema !== 'fsusblog.native-test-receipt.v1')
    {
        fail(errors, 'receipt schema is invalid');
    }
    if (receipt?.profile !== profile?.id)
    {
        fail(errors, `receipt profile must be ${profile?.id}`);
    }
    if (receipt?.testId !== target?.testId)
    {
        fail(errors, `receipt testId must be ${target?.testId}`);
    }
    if (receipt?.target !== target?.cmakeTarget)
    {
        fail(errors, `receipt target must be ${target?.cmakeTarget}`);
    }
    if (!/^[0-9a-f]{40}$/u.test(String(receipt?.source?.commit ?? '')))
    {
        fail(errors, 'receipt source commit is invalid');
    }
    if (expectedCommit && receipt?.source?.commit !== expectedCommit)
    {
        fail(errors, 'receipt source commit does not match the requested commit');
    }
    if (!sha256Pattern.test(String(receipt?.source?.inputDigest ?? '')))
    {
        fail(errors, 'receipt source input digest is invalid');
    }
    if (!String(receipt?.toolchain?.compilerPath ?? '').trim())
    {
        fail(errors, 'receipt compiler path is missing');
    }
    if (!String(receipt?.toolchain?.compilerVersion ?? '').trim())
    {
        fail(errors, 'receipt compiler version is missing');
    }
    if (!String(receipt?.toolchain?.cmakeVersion ?? '').trim())
    {
        fail(errors, 'receipt CMake version is missing');
    }
    if (!Array.isArray(receipt?.flags?.sanitizers))
    {
        fail(errors, 'receipt sanitizer flags are missing');
    }
    if (!Array.isArray(receipt?.flags?.fuzzer))
    {
        fail(errors, 'receipt fuzzer flags are missing');
    }
    if (!sha256Pattern.test(String(receipt?.corpus?.identity ?? '')))
    {
        fail(errors, 'receipt corpus identity is invalid');
    }
    if (!sha256Pattern.test(String(receipt?.crashArtifacts?.digest ?? '')))
    {
        fail(errors, 'receipt crash artifact digest is invalid');
    }
    if (!Number.isInteger(receipt?.crashArtifacts?.count) || receipt.crashArtifacts.count < 0)
    {
        fail(errors, 'receipt crash artifact count is invalid');
    }
    if (!['passed', 'failed', 'blocked'].includes(receipt?.outcome))
    {
        fail(errors, 'receipt outcome is invalid');
    }
    if (receipt?.outcome === 'blocked' && !String(receipt?.preflight?.missingReason ?? '').trim())
    {
        fail(errors, 'blocked receipt must include a structured missing reason');
    }
    return errors;
}
