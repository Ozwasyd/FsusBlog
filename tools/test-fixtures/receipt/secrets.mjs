/** Fail-closed secret / PII rejection for fixture receipts (#1710). */

const FORBIDDEN_KEY = /(?:^|[_.-])(?:access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer|password|passwd|secret|cookie|set-cookie|authorization|session[_-]?token|jwt|private[_-]?key|api[_-]?key|client[_-]?secret)(?:$|[_.-])/iu;
const FORBIDDEN_VALUE = /(?:^|[\s"'])(?:Bearer\s+[A-Za-z0-9\-._~+/]+=*|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/u;
const EMAIL_LIKE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu;
const PHONE_LIKE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{4}/u;

/**
 * Walk receipt-shaped values and throw if secrets, tokens, full cookies, or obvious PII appear.
 * Entity identities may carry stable handles/IDs only.
 */
export function assertNoSecrets(value, path = '$')
{
    if (value == null)
    {
        return;
    }
    if (typeof value === 'string')
    {
        if (FORBIDDEN_VALUE.test(value))
        {
            throw new Error(`receipt forbids secret/token material at ${path}`);
        }
        if (EMAIL_LIKE.test(value) && !path.endsWith('.schema'))
        {
            throw new Error(`receipt forbids PII email-like value at ${path}`);
        }
        // Full cookie header material
        if (/sessionid=|auth_token=|__Host-|__Secure-/iu.test(value) && value.includes('='))
        {
            throw new Error(`receipt forbids cookie material at ${path}`);
        }
        return;
    }
    if (typeof value === 'number' || typeof value === 'boolean')
    {
        return;
    }
    if (Array.isArray(value))
    {
        value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
        return;
    }
    if (typeof value === 'object')
    {
        for (const [key, child] of Object.entries(value))
        {
            if (FORBIDDEN_KEY.test(key))
            {
                throw new Error(`receipt forbids secret field ${key} at ${path}`);
            }
            assertNoSecrets(child, `${path}.${key}`);
        }
    }
}

export function looksLikeSecretKey(key)
{
    return FORBIDDEN_KEY.test(String(key ?? ''));
}
