export type MarkdownRenderResult = Readonly<{
  html?: string
  features?: unknown
  placeholders?: unknown
  metadata?: Record<string, unknown>
}>

// Temporary downstream activation layer: FsusBlog keeps business CSS/CSP/anchor
// behavior here until FsusUI markdown activation fully owns those generic features.
let mermaidInitialized = false;
let styleNonceBridgeInstalled = false;

type CspNonceWindow = Window & typeof globalThis & {
  __FSUSBLOG_CSP_NONCE__?: string
}

type StyleNonceElement = Element & {
  nonce?: string
}

function readCspNonce(): string {
  const meta = document.querySelector('meta[property="csp-nonce"]') as StyleNonceElement | null
  return meta?.nonce
    || meta?.getAttribute('nonce')
    || (window as CspNonceWindow).__FSUSBLOG_CSP_NONCE__
    || ''
}

function applyCspNonceToStyleNode(node: Node): void {
  if (!(node instanceof Element) || node.tagName.toLowerCase() !== 'style') {
    return
  }

  const style = node as StyleNonceElement
  if (style.nonce || style.getAttribute('nonce')) {
    return
  }

  const nonce = readCspNonce()
  if (!nonce) {
    return
  }

  style.nonce = nonce
  style.setAttribute('nonce', nonce)
}

function installStyleNonceBridge(): void {
  if (styleNonceBridgeInstalled || typeof document === 'undefined') {
    return
  }

  styleNonceBridgeInstalled = true
  const appendChild = Node.prototype.appendChild
  const insertBefore = Node.prototype.insertBefore

  Node.prototype.appendChild = function<T extends Node>(node: T): T {
    applyCspNonceToStyleNode(node)
    return appendChild.call(this, node) as T
  }

  Node.prototype.insertBefore = function<T extends Node>(node: T, child: Node | null): T {
    applyCspNonceToStyleNode(node)
    return insertBefore.call(this, node, child) as T
  }
}

async function initMermaid() {
  if (mermaidInitialized) return;
  installStyleNonceBridge();
  const mermaid = (await import('mermaid')).default;

  const isDark = document.documentElement.dataset.themeResolved === 'dark'
  const rootStyles = getComputedStyle(document.documentElement);
  const cssColor = (name: string, fallback: string) => rootStyles.getPropertyValue(name).trim() || fallback;

  // FsusUI Colors
  const ink = cssColor('--fsusblog-text-primary', 'currentColor');
  const paper = cssColor('--fsusblog-panel-bg', 'Canvas');
  const blue = cssColor('--fsusblog-color-primary', 'Highlight');
  const muted = cssColor('--fsusblog-text-muted', ink);
  const border = cssColor('--fsusblog-panel-border', muted);
  const borderStrong = cssColor('--fsusblog-panel-border-strong', border);
  const pageSoft = cssColor('--fsusblog-page-bg-soft', paper);
  const panelSoft = cssColor('--fsusblog-panel-bg-soft', paper);
  const fontFamily = cssColor('--font-sans', 'ui-sans-serif, system-ui, sans-serif');

  mermaid.initialize({
    startOnLoad: false,
    theme: 'base',
    securityLevel: 'loose',
    fontFamily,
    themeVariables: {
      primaryColor: isDark ? panelSoft : paper,
      primaryTextColor: isDark ? border : ink,
      primaryBorderColor: isDark ? borderStrong : ink,
      lineColor: isDark ? muted : ink,
      secondaryColor: blue,
      tertiaryColor: isDark ? border : pageSoft,
      mainBkg: isDark ? panelSoft : paper,
      nodeBorder: isDark ? borderStrong : ink,
      clusterBkg: isDark ? border : pageSoft,
      titleColor: isDark ? paper : ink,
      edgeLabelBackground: isDark ? panelSoft : paper,
      background: isDark ? panelSoft : paper,
    }
  });
  mermaidInitialized = true;
  return mermaid;
}

export async function activateMarkdownFeatures(container: HTMLElement, _result?: MarkdownRenderResult) {
  if (!container) return;

  // 1. 查找所有待激活的 Mermaid 占位符
  const mermaidPlaceholders = container.querySelectorAll<HTMLElement>('[data-mermaid-placeholder="true"]');
  if (mermaidPlaceholders.length > 0) {
    const mermaid = await initMermaid();
    if (mermaid) {
      for (const el of mermaidPlaceholders) {
        const sourceCode = el.querySelector('code')?.textContent;
        if (sourceCode) {
          try {
            const { svg } = await mermaid.render(`mermaid-${Math.random().toString(36).slice(2, 9)}`, sourceCode);
            el.innerHTML = svg;
            el.dataset.mermaidRendered = 'true';
            el.removeAttribute('data-mermaid-placeholder');

          } catch {
            el.innerHTML = '<div class="blog-markdown-feature-error">图表渲染失败，请检查 Mermaid 语法。</div>';
            el.dataset.mermaidRendered = 'error';
            el.removeAttribute('data-mermaid-placeholder');
          }
        }
      }
    }
  }

  // 2. 查找所有待激活的 LaTeX 占位符
  const latexPlaceholders = container.querySelectorAll<HTMLElement>('[data-latex-placeholder="true"]');
  if (latexPlaceholders.length > 0) {
    const katex = (await import('katex')).default;
    for (const el of latexPlaceholders) {
      const sourceCode = el.querySelector('code')?.textContent;
      if (sourceCode) {
        try {
          const isBlock = el.tagName === 'DIV';
          katex.render(sourceCode, el, {
            displayMode: isBlock,
            throwOnError: false,
            trust: false,
            errorColor: 'var(--fsusblog-reading-error-text)'
          });
          el.dataset.latexRendered = 'katex';
          el.removeAttribute('data-latex-placeholder');
        } catch (e) {
          console.error('[MarkdownActivation] KaTeX render failed:', e);
        }
      }
    }
  }

  // 3. 代码高亮 (Shiki)
  const codeBlocks = container.querySelectorAll<HTMLElement>('pre > code:not([data-mermaid-placeholder]):not([data-latex-placeholder])');
  if (codeBlocks.length > 0) {
    try {
      const { getShikiHighlighter, normalizeShikiLanguage } = await import('@/services/shikiHighlighter');
      const highlighter = await getShikiHighlighter();
      const isDark = document.documentElement.dataset.themeResolved === 'dark'
      const theme = isDark ? 'github-dark' : 'github-light';

      for (const el of codeBlocks) {
        // 如果父元素已经被处理过（比如被 Shiki 替换了 pre），跳过
        if (!el.parentElement || el.parentElement.tagName !== 'PRE') continue;

        const langMatch = Array.from(el.classList).find(c => c.startsWith('language-'));
        const lang = normalizeShikiLanguage(langMatch ? langMatch.replace('language-', '') : 'text');
        const code = el.textContent || '';

        try {
          const html = highlighter.codeToHtml(code, { lang, theme });
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = html;
          const newPre = tempDiv.firstElementChild;
          if (newPre && el.parentElement) {
            el.parentElement.replaceWith(newPre);
          }
        } catch (e) {
          console.warn(`[MarkdownActivation] Shiki highlight failed for lang: ${lang}`, e);
        }
      }
    } catch (e) {
      console.error('[MarkdownActivation] Shiki initialization failed:', e);
    }
  }

  // 4. 为标题注入 id，使手写 TOC 锚点链接可以页内跳转
  const headingEls = container.querySelectorAll<HTMLElement>('h1, h2, h3, h4, h5, h6');
  if (headingEls.length > 0) {
    const usedSlugs = new Map<string, number>();
    for (const el of headingEls) {
      if (el.id) continue;
      const slug = toHeadingSlug(el.textContent || '');
      if (!slug) continue;
      const count = usedSlugs.get(slug) ?? 0;
      usedSlugs.set(slug, count + 1);
      el.id = count === 0 ? slug : `${slug}-${count + 1}`;
    }
  }

  // 5. 修复 C++ 渲染器对所有链接加的 target="_blank"：
  //    hash 锚点链接（href="#..."）应在当前页面内跳转
  const hashLinks = container.querySelectorAll<HTMLAnchorElement>('a[href^="#"]');
  for (const a of hashLinks) {
    a.removeAttribute('target');
    a.removeAttribute('rel');
  }
}

/**
 * 将标题文本转换为 URL slug，与 C++ 渲染器生成 TOC 链接所用的算法一致：
 * 1. 转小写
 * 2. 去除标点符号（保留 Unicode 字母、数字、连字符、空格）
 * 3. 空格替换为连字符
 * 4. 修剪首尾连字符
 */
function toHeadingSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')
    .replace(/^-+|-+$/g, '');
}
