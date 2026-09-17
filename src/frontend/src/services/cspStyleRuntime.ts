import { AppErrorCode, createAppError } from '@/utils/appError';

import type { ObjectDirective } from 'vue';

export type CspStyleValue = string | number | null | undefined;
export type CspStyleDeclarations = Readonly<Record<string, CspStyleValue>>;

export type CspStyleBinding = Readonly<{
    className: string;
    update(declarations: CspStyleDeclarations): void;
    dispose(): void;
}>;

const directiveBindings = new WeakMap<HTMLElement, CspStyleBinding>();
let nextBindingId = 0;

function toCssPropertyName(property: string): string
{
    const normalized = property.trim();
    if (normalized.startsWith('--'))
    {
        if (!/^--[a-zA-Z0-9_-]+$/.test(normalized))
        {
            throw new TypeError(`invalid custom property: ${property}`);
        }
        return normalized;
    }

    const kebabCase = normalized
        .replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`)
        .toLowerCase();
    if (!/^-?[a-z][a-z0-9-]*$/.test(kebabCase))
    {
        throw new TypeError(`invalid CSS property: ${property}`);
    }
    return kebabCase;
}

function readCspNonce(documentRef: Document): string
{
    const source = documentRef.querySelector<HTMLElement>(
        'meta[property="csp-nonce"], script[nonce], style[nonce]'
    );
    return source?.nonce ?? '';
}

function createRule(
    element: HTMLElement,
    scope: string
): { className: string; rule: CSSStyleRule; styleElement: HTMLStyleElement; }
{
    const documentRef = element.ownerDocument;
    const className = `fsus-csp-style-${++nextBindingId}`;
    const styleElement = documentRef.createElement('style');
    styleElement.dataset.fsusCspRuntimeStyle = scope;
    const nonce = readCspNonce(documentRef);
    if (nonce)
    {
        styleElement.nonce = nonce;
    }
    ;(documentRef.head ?? documentRef.documentElement).append(styleElement);

    const sheet = styleElement.sheet;
    if (!sheet)
    {
        styleElement.remove();
        throw createAppError(AppErrorCode.InfraFailure, 'csp_runtime_stylesheet_unavailable');
    }
    const index = sheet.insertRule(`.${className} {}`, sheet.cssRules.length);
    const rule = sheet.cssRules[index] as CSSStyleRule | undefined;
    if (!rule || typeof rule.style?.setProperty !== 'function')
    {
        styleElement.remove();
        throw createAppError(AppErrorCode.InfraFailure, 'csp_runtime_style_rule_unavailable');
    }

    element.classList.add(className);
    return { className, rule, styleElement };
}

export function createCspStyleBinding(
    element: HTMLElement,
    declarations: CspStyleDeclarations = {},
    scope = 'runtime'
): CspStyleBinding
{
    const { className, rule, styleElement } = createRule(element, scope);
    let activeProperties = new Set<string>();
    let disposed = false;

    const update = (nextDeclarations: CspStyleDeclarations): void =>
    {
        if (disposed)
        {
            return;
        }

        const nextProperties = new Set<string>();
        for (const [property, rawValue] of Object.entries(nextDeclarations))
        {
            const cssProperty = toCssPropertyName(property);
            if (rawValue === null || rawValue === undefined || rawValue === '')
            {
                continue;
            }
            rule.style.setProperty(cssProperty, String(rawValue));
            nextProperties.add(cssProperty);
        }

        for (const property of activeProperties)
        {
            if (!nextProperties.has(property))
            {
                rule.style.removeProperty(property);
            }
        }
        activeProperties = nextProperties;
    };

    const dispose = (): void =>
    {
        if (disposed)
        {
            return;
        }
        disposed = true;
        element.classList.remove(className);
        styleElement.remove();
        activeProperties.clear();
    };

    update(declarations);
    return { className, update, dispose };
}

export const cspStyleDirective: ObjectDirective<HTMLElement, CspStyleDeclarations> = {
    mounted(element, binding)
    {
        directiveBindings.set(
            element,
            createCspStyleBinding(element, binding.value ?? {}, 'vue-directive')
        );
    },
    updated(element, binding)
    {
        directiveBindings.get(element)?.update(binding.value ?? {});
    },
    unmounted(element)
    {
        directiveBindings.get(element)?.dispose();
        directiveBindings.delete(element);
    }
};
