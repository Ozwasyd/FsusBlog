import { defineComponent, h, type App, type PropType } from 'vue';

type RouterLinkTo = string | {
    path?: string;
    query?: Record<string, unknown>;
    hash?: string;
};

function encodeQuery(query: Record<string, unknown> | undefined): string
{
    if (!query)
    {
        return '';
    }

    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query))
    {
        if (value === undefined || value === null)
        {
            continue;
        }

        if (Array.isArray(value))
        {
            for (const item of value)
            {
                if (item !== undefined && item !== null)
                {
                    params.append(key, String(item));
                }
            }
            continue;
        }

        params.set(key, String(value));
    }

    const text = params.toString();
    return text ? `?${text}` : '';
}

function resolveHref(to: RouterLinkTo): string
{
    if (typeof to === 'string')
    {
        return to;
    }

    const path = typeof to.path === 'string' && to.path.length > 0 ? to.path : '#';
    const hash = typeof to.hash === 'string' && to.hash.length > 0
        ? to.hash.startsWith('#') ? to.hash : `#${to.hash}`
        : '';
    return `${path}${encodeQuery(to.query)}${hash}`;
}

export const PublicStaticRouterLink = defineComponent({
    name: 'RouterLink',
    props: {
        to: {
            type: [String, Object] as PropType<RouterLinkTo>,
            required: true
        },
        custom: {
            type: Boolean,
            default: false
        }
    },
    setup(props, { slots })
    {
        return () =>
        {
            const href = resolveHref(props.to);
            const navigate = () =>
            {
                if (typeof window !== 'undefined')
                {
                    window.location.assign(href);
                }
            };

            if (props.custom)
            {
                return slots.default?.({
                    href,
                    navigate,
                    route: {
                        fullPath: href,
                        path: href
                    }
                }) ?? null;
            }

            return h('a', { href }, slots.default?.());
        };
    }
});

export function registerPublicStaticRouterLink(app: App): void
{
    app.component('RouterLink', PublicStaticRouterLink);
}
