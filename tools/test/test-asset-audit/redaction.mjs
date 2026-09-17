function secretValues(env)
{
    return Object.entries(env)
        .filter(([key, value]) => /TOKEN|PASSWORD|SECRET|CONNECTION_STRING|DATABASE_URL|REDIS_URL|AUTH/iu.test(key) && String(value ?? '').length >= 4)
        .map(([, value]) => String(value))
        .sort((left, right) => right.length - left.length);
}

export function redactAuditText(value, env = process.env)
{
    return secretValues(env).reduce((text, secret) => text.replaceAll(secret, '[REDACTED]'), String(value ?? ''));
}
