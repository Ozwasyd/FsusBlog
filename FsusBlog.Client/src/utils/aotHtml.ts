let trustedPolicy: TrustedTypePolicy | null = null;

function ensurePolicy(): TrustedTypePolicy | null {
  if (trustedPolicy) {
    return trustedPolicy;
  }

  if (typeof window === 'undefined' || !window.trustedTypes) {
    return null;
  }

  trustedPolicy = window.trustedTypes.createPolicy('fsus-aot-html', {
    createHTML: (input: string) => input
  });
  return trustedPolicy;
}

function hasDangerousPattern(input: string): boolean {
  const lower = input.toLowerCase();
  return lower.includes('<script')
    || lower.includes('javascript:')
    || lower.includes('onerror=')
    || lower.includes('onload=')
    || lower.includes('onclick=');
}

export function sanitizeAotHtml(input: string): string {
  // Real Mermaid SVG and MathML payloads are materially larger than placeholder HTML.
  if (!input || input.length > 1_000_000) {
    return '';
  }

  if (hasDangerousPattern(input)) {
    return '';
  }

  const policy = ensurePolicy();
  if (!policy) {
    return input;
  }

  return String(policy.createHTML(input));
}
