export async function collectPublicPreviewQualityDom(page, normalizedScenario, policy)
{
    return await page.evaluate(({ currentScenario, currentPolicy }) =>
    {
        const tolerance = Number(currentPolicy.overflowTolerancePx ?? 1);
        const mobile = innerWidth <= Number(currentPolicy.mobileMaxWidth ?? 768);
        const visible = (element) =>
        {
            if (!(element instanceof HTMLElement)) return false;
            const style = getComputedStyle(element);
            const rect = element.getBoundingClientRect();
            return style.display !== 'none'
                && style.visibility !== 'hidden'
                && Number.parseFloat(style.opacity || '1') > 0
                && rect.width > 0
                && rect.height > 0;
        };
        const descriptor = (element) =>
        {
            const id = element.id ? `#${element.id}` : '';
            const dataId = element.getAttribute('data-testid')
                ?? element.getAttribute('data-article-id')
                ?? element.getAttribute('data-route-name')
                ?? '';
            const classes = [...element.classList].slice(0, 3).join('.');
            return `${element.tagName.toLowerCase()}${id}${classes ? `.${classes}` : ''}${dataId ? `[${dataId}]` : ''}`;
        };
        const rectRecord = (element) =>
        {
            const rect = element.getBoundingClientRect();
            return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, right: rect.right, bottom: rect.bottom };
        };
        const uniqueElements = (selectors) =>
        {
            const values = [];
            const seen = new Set();
            for (const selector of selectors)
            {
                for (const element of document.querySelectorAll(selector))
                {
                    if (!seen.has(element) && visible(element))
                    {
                        seen.add(element);
                        values.push(element);
                    }
                }
            }
            return values;
        };
        const isExcludedUserContent = (element) => (currentPolicy.userContentSelectors ?? [])
            .some((selector) => element.closest(selector));

        const overflow = {
            scrollWidth: document.documentElement.scrollWidth,
            clientWidth: document.documentElement.clientWidth,
            deltaPx: document.documentElement.scrollWidth - document.documentElement.clientWidth
        };
        overflow.status = overflow.deltaPx <= tolerance ? 'pass' : 'fail';
        overflow.findings = overflow.status === 'pass' ? [] : [`page horizontal overflow ${overflow.deltaPx}px`];

        const interactiveSelectors = [
            'button:not([disabled])',
            'input:not([type="hidden"]):not([disabled])',
            'select:not([disabled])',
            'textarea:not([disabled])',
            'summary',
            '[role="button"]',
            '[tabindex]:not([tabindex="-1"])',
            'nav a[href]',
            '[data-public-shell-action]',
            '[data-comment-empty-action]',
            '[data-primary-action]',
            '[data-article-category]',
            '[data-article-tag]'
        ];
        const interactive = uniqueElements(interactiveSelectors);
        const specialSelectors = currentPolicy.primaryHitTargetSelectors ?? [];
        const hitTargetFailures = [];
        if (mobile)
        {
            for (const element of interactive)
            {
                const rect = element.getBoundingClientRect();
                const primary = specialSelectors.some((selector) => element.matches(selector) || element.closest(selector));
                const minimum = primary
                    ? Number(currentPolicy.primaryHitTargetHeightMinPx ?? 44)
                    : Number(currentPolicy.normalHitTargetMinPx ?? 40);
                if (rect.height + tolerance < minimum || rect.width + tolerance < Number(currentPolicy.normalHitTargetMinPx ?? 40))
                {
                    hitTargetFailures.push({ element: descriptor(element), rect: rectRecord(element), minimum, primary });
                }
            }
        }
        const hitTargets = {
            status: hitTargetFailures.length === 0 ? 'pass' : 'fail',
            checked: mobile ? interactive.length : 0,
            findings: hitTargetFailures
        };

        const overlapFindings = [];
        for (let leftIndex = 0; leftIndex < interactive.length; leftIndex++)
        {
            const left = interactive[leftIndex];
            const leftRect = left.getBoundingClientRect();
            for (let rightIndex = leftIndex + 1; rightIndex < interactive.length; rightIndex++)
            {
                const right = interactive[rightIndex];
                if (left.contains(right) || right.contains(left)) continue;
                const rightRect = right.getBoundingClientRect();
                const width = Math.max(0, Math.min(leftRect.right, rightRect.right) - Math.max(leftRect.left, rightRect.left));
                const height = Math.max(0, Math.min(leftRect.bottom, rightRect.bottom) - Math.max(leftRect.top, rightRect.top));
                const area = width * height;
                if (area > 1)
                {
                    overlapFindings.push({ left: descriptor(left), right: descriptor(right), area });
                }
            }
        }
        const overlaps = {
            status: overlapFindings.length === 0 ? 'pass' : 'fail',
            checked: interactive.length,
            findings: overlapFindings.slice(0, 40)
        };

        const readable = uniqueElements([
            'main h1', 'main h2', 'main h3', 'button', 'label', 'summary', 'nav a',
            '[data-page-title]', '[data-home-feed-heading]', '[data-empty-state]'
        ]).filter((element) => !isExcludedUserContent(element));
        const clippedFindings = [];
        for (const element of readable)
        {
            if (element.matches('[data-public-preview-allow-truncation]') || element.closest('[data-public-preview-allow-truncation]')) continue;
            const style = getComputedStyle(element);
            const clipped = element.scrollWidth > element.clientWidth + tolerance
                || element.scrollHeight > element.clientHeight + tolerance;
            if (clipped && style.overflow !== 'visible')
            {
                clippedFindings.push({ element: descriptor(element), rect: rectRecord(element), text: element.textContent?.trim().slice(0, 120) ?? '' });
            }
        }
        const clippedText = {
            status: clippedFindings.length === 0 ? 'pass' : 'fail',
            checked: readable.length,
            findings: clippedFindings
        };

        const focusFindings = [];
        const focusTolerance = Number(currentPolicy.focusClipTolerancePx ?? 2);
        for (const element of interactive)
        {
            const rect = element.getBoundingClientRect();
            const expanded = {
                left: rect.left - focusTolerance,
                top: rect.top - focusTolerance,
                right: rect.right + focusTolerance,
                bottom: rect.bottom + focusTolerance
            };
            if (expanded.left < -focusTolerance || expanded.top < -focusTolerance
                || expanded.right > innerWidth + focusTolerance || expanded.bottom > innerHeight + Math.max(document.documentElement.scrollHeight - innerHeight, 0) + focusTolerance)
            {
                focusFindings.push({ element: descriptor(element), reason: 'viewport', rect: rectRecord(element) });
                continue;
            }
            let ancestor = element.parentElement;
            while (ancestor)
            {
                const style = getComputedStyle(ancestor);
                if (/(hidden|clip)/u.test(`${style.overflow}${style.overflowX}${style.overflowY}`))
                {
                    const parentRect = ancestor.getBoundingClientRect();
                    if (expanded.left < parentRect.left - focusTolerance || expanded.right > parentRect.right + focusTolerance
                        || expanded.top < parentRect.top - focusTolerance || expanded.bottom > parentRect.bottom + focusTolerance)
                    {
                        focusFindings.push({ element: descriptor(element), reason: `clipped by ${descriptor(ancestor)}`, rect: rectRecord(element) });
                        break;
                    }
                }
                ancestor = ancestor.parentElement;
            }
        }
        const focusClipping = {
            status: focusFindings.length === 0 ? 'pass' : 'fail',
            checked: interactive.length,
            findings: focusFindings.slice(0, 40)
        };

        const chromeElements = uniqueElements(currentPolicy.uiChromeSelectors ?? [])
            .filter((element) => !isExcludedUserContent(element));
        const chromeText = chromeElements.map((element) => element.textContent?.trim() ?? '').filter(Boolean).join('\n');
        const oppositeLocale = currentScenario.locale === 'zh-CN' ? 'en-US' : 'zh-CN';
        const oppositeTokens = currentPolicy.localeTokens?.[oppositeLocale] ?? [];
        const localeFindings = oppositeTokens.filter((token) => chromeText.includes(token));
        const documentLocale = document.documentElement.lang;
        if (documentLocale !== currentScenario.locale)
        {
            localeFindings.unshift(`document.lang=${documentLocale || '<empty>'}`);
        }
        const localeCoherence = {
            status: localeFindings.length === 0 ? 'pass' : 'fail',
            expectedLocale: currentScenario.locale,
            oppositeLocale,
            findings: localeFindings
        };

        const primaryTaskElements = uniqueElements(currentScenario.primaryTaskSelectors ?? []);
        const primaryTaskVisible = primaryTaskElements.some((element) => element.getBoundingClientRect().top < innerHeight);
        const primaryTask = {
            status: (currentScenario.primaryTaskSelectors ?? []).length === 0 || primaryTaskVisible ? 'pass' : 'fail',
            checkedSelectors: currentScenario.primaryTaskSelectors ?? [],
            visibleInFirstViewport: primaryTaskVisible,
            findings: (currentScenario.primaryTaskSelectors ?? []).length === 0 || primaryTaskVisible
                ? []
                : ['no primary task, result, or complete empty state is visible in the first viewport']
        };

        const panels = uniqueElements(currentPolicy.panelSelectors ?? []);
        const panelSet = new Set(panels);
        const nestedPanels = panels.filter((panel) =>
        {
            let parent = panel.parentElement;
            while (parent)
            {
                if (panelSet.has(parent)) return true;
                parent = parent.parentElement;
            }
            return false;
        });
        const badges = uniqueElements(currentPolicy.badgeSelectors ?? []);
        const primaryActions = uniqueElements(currentPolicy.primaryActionSelectors ?? [])
            .filter((element) => element.getBoundingClientRect().top < innerHeight);
        const styledCandidates = uniqueElements([
            'body', 'main', 'section', 'aside', 'header',
            ...(currentPolicy.panelSelectors ?? []),
            ...(currentPolicy.primaryActionSelectors ?? [])
        ]);
        const gradients = [];
        const glass = [];
        const excessiveRadius = [];
        for (const element of styledCandidates)
        {
            const style = getComputedStyle(element);
            if (style.backgroundImage && style.backgroundImage !== 'none' && /gradient/iu.test(style.backgroundImage))
            {
                gradients.push(descriptor(element));
            }
            if ((style.backdropFilter && style.backdropFilter !== 'none') || (style.webkitBackdropFilter && style.webkitBackdropFilter !== 'none'))
            {
                glass.push(descriptor(element));
            }
            const radius = Math.max(...[style.borderTopLeftRadius, style.borderTopRightRadius, style.borderBottomLeftRadius, style.borderBottomRightRadius]
                .map((value) => Number.parseFloat(value) || 0));
            if (radius > Number(currentPolicy.maxUnscopedRadiusPx ?? 12)
                && !element.matches('[data-expressive-radius]')
                && !element.closest('[data-expressive-radius]'))
            {
                excessiveRadius.push({ element: descriptor(element), radius });
            }
        }
        const reviewerFindings = [];
        if (currentScenario.surfaceRole === 'task' && panels.length > Number(currentPolicy.maxTaskPanels ?? 8))
        {
            reviewerFindings.push(`task surface has ${panels.length} panels; budget=${currentPolicy.maxTaskPanels}`);
        }
        if (nestedPanels.length > 0) reviewerFindings.push(`nested panel count=${nestedPanels.length}`);
        if (badges.length > Number(currentPolicy.maxBadges ?? 12)) reviewerFindings.push(`badge count=${badges.length}`);
        if (primaryActions.length > Number(currentPolicy.maxPrimaryActions ?? 3)) reviewerFindings.push(`first-viewport primary action count=${primaryActions.length}`);
        if (gradients.length > 0) reviewerFindings.push(`gradient surfaces=${gradients.length}`);
        if (glass.length > 0) reviewerFindings.push(`backdrop-filter surfaces=${glass.length}`);
        if (excessiveRadius.length > 0) reviewerFindings.push(`unscoped large-radius surfaces=${excessiveRadius.length}`);

        return {
            overflow,
            overlaps,
            clippedText,
            hitTargets,
            focusClipping,
            localeCoherence,
            primaryTask,
            reviewer: {
                findings: reviewerFindings,
                metrics: {
                    panelCount: panels.length,
                    nestedPanelCount: nestedPanels.length,
                    badgeCount: badges.length,
                    firstViewportPrimaryActionCount: primaryActions.length,
                    gradientCount: gradients.length,
                    glassCount: glass.length,
                    excessiveRadiusCount: excessiveRadius.length
                }
            }
        };
    }, { currentScenario: normalizedScenario, currentPolicy: policy });
}
