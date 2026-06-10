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
const shikiHtmlCache = new Map<string, string>();
const SHIKI_HTML_CACHE_LIMIT = 128;
const MARKDOWN_ACTIVATION_CHUNK_SIZE = 8;
const MERMAID_RENDER_BUDGET = 10;

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

  const targets = collectMarkdownFeatureTargets(container);
  const activationStartedAt = performance.now();

  // 1. Mermaid 渲染有单篇预算，避免超大文档在首帧内全部激活。
  const mermaidPlaceholders = targets.mermaidPlaceholders.slice(0, MERMAID_RENDER_BUDGET);
  if (mermaidPlaceholders.length > 0) {
    const mermaid = await initMermaid();
    if (mermaid) {
      await processInChunks(mermaidPlaceholders, async (el) => {
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
      });
    }
  }
  for (const el of targets.mermaidPlaceholders.slice(MERMAID_RENDER_BUDGET)) {
    el.dataset.mermaidRendered = 'deferred';
    el.removeAttribute('data-mermaid-placeholder');
  }

  // 2. 查找所有待激活的 LaTeX 占位符
  const latexPlaceholders = targets.latexPlaceholders;
  if (latexPlaceholders.length > 0) {
    const katex = (await import('katex')).default;
    await processInChunks(latexPlaceholders, async (el) => {
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
    });
  }

  // 3. 代码高亮 (Shiki)
  const codeBlocks = targets.codeBlocks;
  if (codeBlocks.length > 0) {
    try {
      const { getShikiHighlighter, normalizeShikiLanguage } = await import('@/services/shikiHighlighter');
      const highlighter = await getShikiHighlighter();
      const isDark = document.documentElement.dataset.themeResolved === 'dark'
      const theme = isDark ? 'github-dark' : 'github-light';

      await processInChunks(codeBlocks, async (el) => {
        // 如果父元素已经被处理过（比如被 Shiki 替换了 pre），跳过
        if (!el.parentElement || el.parentElement.tagName !== 'PRE') return;

        const langMatch = Array.from(el.classList).find(c => c.startsWith('language-'));
        const lang = normalizeShikiLanguage(langMatch ? langMatch.replace('language-', '') : 'text');
        const code = el.textContent || '';

        try {
          const cacheKey = `${theme}\0${lang}\0${hashString(code)}`;
          const html = shikiHtmlCache.get(cacheKey) ?? highlighter.codeToHtml(code, { lang, theme });
          rememberShikiHtml(cacheKey, html);
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = html;
          const newPre = tempDiv.firstElementChild;
          if (newPre && el.parentElement) {
            el.parentElement.replaceWith(newPre);
          }
        } catch (e) {
          console.warn(`[MarkdownActivation] Shiki highlight failed for lang: ${lang}`, e);
        }
      });
    } catch (e) {
      console.error('[MarkdownActivation] Shiki initialization failed:', e);
    }
  }

  // 4. 为标题注入 id，使手写 TOC 锚点链接可以页内跳转
  const headingEls = targets.headingEls;
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
  const hashLinks = targets.hashLinks;
  for (const a of hashLinks) {
    a.removeAttribute('target');
    a.removeAttribute('rel');
  }

  container.dataset.markdownActivationSummary = JSON.stringify({
    mermaid: targets.mermaidPlaceholders.length,
    mermaidRendered: mermaidPlaceholders.length,
    mermaidDeferred: Math.max(0, targets.mermaidPlaceholders.length - MERMAID_RENDER_BUDGET),
    latex: targets.latexPlaceholders.length,
    code: targets.codeBlocks.length,
    headings: targets.headingEls.length,
    hashLinks: targets.hashLinks.length,
    activationMs: Math.round(performance.now() - activationStartedAt)
  });
}

type MarkdownFeatureTargets = {
  mermaidPlaceholders: HTMLElement[]
  latexPlaceholders: HTMLElement[]
  codeBlocks: HTMLElement[]
  headingEls: HTMLElement[]
  hashLinks: HTMLAnchorElement[]
}

function collectMarkdownFeatureTargets(container: HTMLElement): MarkdownFeatureTargets {
  const targets: MarkdownFeatureTargets = {
    mermaidPlaceholders: [],
    latexPlaceholders: [],
    codeBlocks: [],
    headingEls: [],
    hashLinks: []
  };
  const ownerDocument = container.ownerDocument;
  const showElement = ownerDocument.defaultView?.NodeFilter?.SHOW_ELEMENT ?? 1;
  const walker = ownerDocument.createTreeWalker(container, showElement);
  let current = walker.currentNode;

  while (current) {
    if (current.nodeType === 1) {
      const element = current as HTMLElement;
      if (element.dataset.mermaidPlaceholder === 'true') {
        targets.mermaidPlaceholders.push(element);
      } else if (element.dataset.latexPlaceholder === 'true') {
        targets.latexPlaceholders.push(element);
      } else if (
        element.tagName === 'CODE'
        && element.parentElement?.tagName === 'PRE'
        && element.dataset.mermaidPlaceholder !== 'true'
        && element.dataset.latexPlaceholder !== 'true'
      ) {
        targets.codeBlocks.push(element);
      } else if (/^H[1-6]$/u.test(element.tagName)) {
        targets.headingEls.push(element);
      }

      if (element.tagName === 'A' && element.getAttribute('href')?.startsWith('#')) {
        targets.hashLinks.push(element as HTMLAnchorElement);
      }
    }

    current = walker.nextNode();
  }

  return targets;
}

async function processInChunks<T>(items: readonly T[], handler: (item: T) => Promise<void> | void): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    await handler(items[index]);
    if ((index + 1) % MARKDOWN_ACTIVATION_CHUNK_SIZE === 0) {
      await yieldToBrowser();
    }
  }
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    const idle = (window as Window & {
      requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number
    }).requestIdleCallback;
    if (typeof idle === 'function') {
      idle(() => resolve(), { timeout: 120 });
      return;
    }
    window.setTimeout(resolve, 0);
  });
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function rememberShikiHtml(cacheKey: string, html: string): void {
  if (!shikiHtmlCache.has(cacheKey) && shikiHtmlCache.size >= SHIKI_HTML_CACHE_LIMIT) {
    const oldest = shikiHtmlCache.keys().next().value;
    if (oldest) {
      shikiHtmlCache.delete(oldest);
    }
  }
  shikiHtmlCache.set(cacheKey, html);
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
