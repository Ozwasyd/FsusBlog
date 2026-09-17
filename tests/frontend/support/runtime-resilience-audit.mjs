export function selectValues(values, rawSelection, label)
{
    const requested = new Set(String(rawSelection ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean));
    if (requested.size === 0)
    {
        return values;
    }
    const selected = values.filter((value) => requested.has(value));
    const selectedValues = new Set(selected);
    const unknown = [...requested].filter((value) => !selectedValues.has(value));
    if (unknown.length > 0)
    {
        throw new Error(`unknown ${label}: ${unknown.join(', ')}`);
    }
    return selected;
}

export function selectedRoutes(scope, routes)
{
    const envName = `FSUSBLOG_RESILIENCE_${scope.toUpperCase()}_ROUTES`;
    return selectValues(routes, process.env[envName], `${scope} resilience route`);
}

function isIgnorableConsole(text)
{
    return text.includes('favicon.ico')
    || text.includes('ERR_ABORTED')
    || text.includes('ERR_NETWORK_CHANGED')
    || text.includes('Failed to load resource: the server responded with a status of 401 (Unauthorized)');
}

export function attachAudit(page)
{
    const events = [];

    page.on('console', (message) =>
    {
        if (message.type() !== 'error' && message.type() !== 'warning')
        {
            return;
        }
        const text = message.text().trim();
        if (!isIgnorableConsole(text))
        {
            events.push(`console:${message.type()}:${text}`);
        }
    });
    page.on('pageerror', (error) =>
    {
        const text = error.message.trim();
        if (!isIgnorableConsole(text))
        {
            events.push(`pageerror:${text}`);
        }
    });
    page.on('requestfailed', (request) =>
    {
        const failure = request.failure()?.errorText || 'request_failed';
        if (!failure.includes('ERR_ABORTED') && !failure.includes('ERR_NETWORK_CHANGED'))
        {
            events.push(`requestfailed:${request.method()} ${request.url()} ${failure}`);
        }
    });

    return () =>
    {
        if (events.length > 0)
        {
            throw new Error(`runtime resilience captured unexpected events:\n${events.join('\n')}`);
        }
    };
}

export function toCookieEntries(cookieMapOrHeader)
{
    if (cookieMapOrHeader instanceof Map)
    {
        return Array.from(cookieMapOrHeader.entries());
    }
    return String(cookieMapOrHeader || '')
        .split(';')
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) =>
        {
            const eq = part.indexOf('=');
            return eq > 0 ? [part.slice(0, eq), part.slice(eq + 1)] : null;
        })
        .filter(Boolean);
}
