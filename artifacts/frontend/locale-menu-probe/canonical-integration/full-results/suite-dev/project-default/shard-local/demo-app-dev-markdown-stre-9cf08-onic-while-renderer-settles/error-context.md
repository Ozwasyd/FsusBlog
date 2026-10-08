# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: demo-app-dev.spec.ts >> markdown stress preview scroll remains monotonic while renderer settles
- Location: vue/tests/demo-app-dev/demo-app-dev.spec.ts:814:5

# Error details

```
Error: expect(locator).toContainText(expected) failed

Locator: locator('.markdown-stress-renderer')
Expected substring: "Stress Section 1"
Received string:    "Rendering markdown..."
Timeout: 20000ms

Call log:
  - Expect "toContainText" with timeout 20000ms
  - waiting for locator('.markdown-stress-renderer')
    - locator resolved to <div class="el-scrollbar__view markdown-stress-renderer">…</div>
    - unexpected value ""
    - locator resolved to <div class="el-scrollbar__view markdown-stress-renderer">…</div>
    - unexpected value "Rendering markdown..."

```

# Page snapshot

```yaml
- generic [ref=e4]:
  - heading "Markdown Stress" [level=2] [ref=e5]
  - generic [ref=e6]:
    - heading "Raw HTML Renderer" [level=3] [ref=e7]
    - generic [ref=e8]:
      - generic [ref=e9]:
        - text: "status:"
        - strong [ref=e10]: rendering
      - generic [ref=e11]: "source: 500,232 chars"
      - generic [ref=e12]: "lines: 12,626"
      - generic [ref=e13]: "html: 1,326,878 chars"
      - generic [ref=e14]: "features: 7"
      - generic [ref=e15]: "placeholders: 0"
      - generic [ref=e16]: "engine: SIMD-128"
      - generic [ref=e17]: "version: markdown-wasm-contract@2026-07-29"
      - generic [ref=e18]: "elapsed: 347ms"
    - generic [ref=e19]:
      - generic [ref=e20]:
        - strong [ref=e21]: preheat
        - generic [ref=e22]: total 63.7ms
        - generic [ref=e23]: init 63.7ms
        - generic [ref=e24]: render 0ms
        - generic [ref=e25]: html 0ms
        - generic [ref=e26]: placeholders 0ms
      - generic [ref=e27]:
        - strong [ref=e28]: html-only
        - generic [ref=e29]: total 49.5ms
        - generic [ref=e30]: init 0.7ms
        - generic [ref=e31]: render 27.8ms
        - generic [ref=e32]: html 3ms
        - generic [ref=e33]: placeholders 0ms
      - generic [ref=e34]:
        - strong [ref=e35]: html-only-warm
        - generic [ref=e36]: total 19.4ms
        - generic [ref=e37]: init 1.4ms
        - generic [ref=e38]: render 12.4ms
        - generic [ref=e39]: html 2.5ms
        - generic [ref=e40]: placeholders 0ms
      - generic [ref=e41]:
        - strong [ref=e42]: summary
        - generic [ref=e43]: total 37.1ms
        - generic [ref=e44]: init 0.5ms
        - generic [ref=e45]: render 13.2ms
        - generic [ref=e46]: html 9.1ms
        - generic [ref=e47]: placeholders 0ms
      - generic [ref=e48]:
        - strong [ref=e49]: full-result
        - generic [ref=e50]: total 175.5ms
        - generic [ref=e51]: init 0.6ms
        - generic [ref=e52]: render 165.3ms
        - generic [ref=e53]: html 2.8ms
        - generic [ref=e54]: placeholders 2.9ms
      - generic [ref=e55]:
        - strong [ref=e56]: component-chunks
        - generic [ref=e57]: total 121.9ms
        - generic [ref=e58]: init 7.4ms
        - generic [ref=e59]: render 96.9ms
        - generic [ref=e60]: html 3ms
        - generic [ref=e61]: placeholders 0ms
    - article [ref=e66]:
      - heading "Markdown Stress Corpus" [level=1] [ref=e68]
      - paragraph [ref=e70]:
        - text: Intro paragraph with
        - strong [ref=e71]: strong
        - text: ","
        - emphasis [ref=e72]: emphasis
        - text: ","
        - code [ref=e73]: inline code
        - text: ","
        - link "link" [ref=e74] [cursor=pointer]:
          - /url: https://example.com/path?q=markdown&x=1
        - text: ", CJK text, and escaped HTML probes. <script>alert(\"xss\")</script><img src=x onerror=alert(1)> <details open>raw</details><svg onload=alert(1)>x</svg>"
      - table [ref=e76]:
        - rowgroup [ref=e77]:
          - row "Column A Column B Column C" [ref=e78]:
            - columnheader "Column A" [ref=e79]
            - columnheader "Column B" [ref=e80]
            - columnheader "Column C" [ref=e81]
        - rowgroup [ref=e82]:
          - row "short 42 text" [ref=e83]:
            - cell "short" [ref=e84]
            - cell "42" [ref=e85]
            - cell "text" [ref=e86]
          - row "very-long-cell cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value- end" [ref=e87]:
            - cell "very-long-cell" [ref=e88]
            - cell "cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-cell-value-" [ref=e89]
            - cell "end" [ref=e90]
      - code [ref=e93]: const value = "<unsafe>& markdown"; console.log(value.repeat(2));
      - figure [ref=e95]:
        - img "Mermaid diagram" [ref=e96]:
          - generic [ref=e98]: "\"Alpha Node\""
          - generic [ref=e100]: Beta Branch
          - generic [ref=e102]: Gamma End
      - paragraph [ref=e104]:
        - text: Inline math
        - math [ref=e106]:
          - generic [ref=e107]:
            - generic [ref=e108]:
              - generic [ref=e109]: x
              - generic [ref=e110]: "1"
              - generic [ref=e111]: "2"
            - generic [ref=e112]: +
            - generic [ref=e113]: α
            - generic [ref=e114]: +
            - generic [ref=e117]: b
        - text: "and display math:"
      - math [ref=e120]:
        - generic [ref=e121]:
          - generic [ref=e123]:
            - generic [ref=e124]:
              - generic [ref=e125]: a
              - generic [ref=e126]: "1"
              - generic [ref=e127]: "2"
            - generic [ref=e128]: +
            - generic [ref=e131]: b
          - generic [ref=e133]:
            - generic [ref=e134]: α
            - generic [ref=e135]: +
            - generic [ref=e136]: "2"
      - heading "Stress Section 1" [level=2] [ref=e138]
      - paragraph [ref=e140]:
        - text: Paragraph 1 with repeated words longwordlongword and inline math
        - math [ref=e142]:
          - generic [ref=e143]:
            - generic [ref=e144]:
              - generic [ref=e145]: "n"
              - generic [ref=e146]: "1"
              - generic [ref=e147]: "2"
            - generic [ref=e148]: +
            - generic [ref=e149]: β
        - text: .
      - list [ref=e151]:
        - listitem [ref=e152]: list item alpha
        - listitem [ref=e153]: list item beta
        - listitem [ref=e154]: list item gamma
```

# Test source

```ts
  724 | 
  725 |   await page.mouse.move(
  726 |     thumbBox.x + thumbBox.width / 2,
  727 |     thumbBox.y + Math.min(8, thumbBox.height / 2),
  728 |   )
  729 |   await page.mouse.down()
  730 |   await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 160, {
  731 |     steps: 16,
  732 |   })
  733 |   await expect(scrollbar).toHaveClass(/is-scrolling/)
  734 |   await expect(scrollbar).toHaveClass(/is-thumb-dragging/)
  735 |   await page.waitForTimeout(50)
  736 | 
  737 |   const forwardDragPosition = await readDragPosition()
  738 |   await page.mouse.move(thumbBox.x + thumbBox.width / 2, thumbBox.y + 120, {
  739 |     steps: 8,
  740 |   })
  741 |   await page.waitForTimeout(80)
  742 |   const reverseDragPosition = await readDragPosition()
  743 | 
  744 |   expect(reverseDragPosition.scrollTop).toBeGreaterThanOrEqual(
  745 |     forwardDragPosition.scrollTop - 18_000,
  746 |   )
  747 |   if (forwardDragPosition.section > 0 && reverseDragPosition.section > 0) {
  748 |     expect(reverseDragPosition.section).toBeGreaterThanOrEqual(
  749 |       forwardDragPosition.section - 64,
  750 |     )
  751 |   }
  752 | 
  753 |   const dragMetrics = await scrollbar.evaluate((element) => {
  754 |     const wrap = element.querySelector<HTMLElement>('.el-scrollbar__wrap')
  755 |     const content = element.querySelector<HTMLElement>(
  756 |       '.el-scrollbar__view > *',
  757 |     )
  758 |     const thumb = element.querySelector<HTMLElement>(
  759 |       '.el-scrollbar__bar.is-vertical .el-scrollbar__thumb',
  760 |     )
  761 | 
  762 |     if (!wrap || !content || !thumb) {
  763 |       throw new Error('Markdown stress scrollbar drag internals are missing')
  764 |     }
  765 | 
  766 |     const readBlur = (filter: string) => {
  767 |       const match = /blur\(([\d.]+)px\)/.exec(filter)
  768 |       return match ? Number.parseFloat(match[1]) : 0
  769 |     }
  770 |     const contentStyle = getComputedStyle(content)
  771 |     const thumbStyle = getComputedStyle(thumb)
  772 |     const thumbAfterStyle = getComputedStyle(thumb, '::after')
  773 | 
  774 |     return {
  775 |       contentBlur: readBlur(contentStyle.filter),
  776 |       contentTransform: contentStyle.transform,
  777 |       scrollTop: wrap.scrollTop,
  778 |       thumbAfterOpacity: Number.parseFloat(thumbAfterStyle.opacity),
  779 |       thumbShadow: thumbStyle.boxShadow,
  780 |     }
  781 |   })
  782 | 
  783 |   expect(dragMetrics.scrollTop).toBeGreaterThan(0)
  784 |   expect(dragMetrics.contentTransform).not.toBe('none')
  785 |   expect(dragMetrics.contentBlur).toBeLessThanOrEqual(0.05)
  786 |   expect(dragMetrics.thumbAfterOpacity).toBeGreaterThan(0)
  787 |   expect(dragMetrics.thumbShadow).not.toBe('none')
  788 | 
  789 |   await page.mouse.up()
  790 |   await expect(scrollbar).not.toHaveClass(/is-scrolling/, { timeout: 2500 })
  791 | 
  792 |   await wrap.evaluate((element) => {
  793 |     element.scrollTop = 0
  794 |     element.dispatchEvent(new Event('scroll'))
  795 |   })
  796 |   await expect(scrollbar).not.toHaveClass(/is-scrolling/, { timeout: 2500 })
  797 | 
  798 |   const bar = scrollbar.locator('.el-scrollbar__bar.is-vertical').first()
  799 |   const barBox = await bar.boundingBox()
  800 |   expect(barBox).not.toBeNull()
  801 |   if (!barBox) return
  802 | 
  803 |   await page.mouse.click(
  804 |     barBox.x + barBox.width / 2,
  805 |     barBox.y + barBox.height / 2,
  806 |   )
  807 |   await page.waitForTimeout(50)
  808 |   const trackClickPosition = await readDragPosition()
  809 |   expect(trackClickPosition.scrollTop).toBeLessThanOrEqual(
  810 |     trackClickPosition.clientHeight * 1.2,
  811 |   )
  812 | })
  813 | 
  814 | test('markdown stress preview scroll remains monotonic while renderer settles', async ({
  815 |   page,
  816 | }) => {
  817 |   test.setTimeout(60_000)
  818 |   await page.setViewportSize({ width: 900, height: 760 })
  819 |   await page.goto('/?visual=markdown-stress&theme=light&debugScroll=1', {
  820 |     waitUntil: 'domcontentloaded',
  821 |   })
  822 | 
  823 |   const renderer = page.locator('.markdown-stress-renderer')
> 824 |   await expect(renderer).toContainText('Stress Section 1', {
      |                          ^ Error: expect(locator).toContainText(expected) failed
  825 |     timeout: 20_000,
  826 |   })
  827 | 
  828 |   const samples = await sampleMarkdownStressScroll(page, {
  829 |     delayMs: 8,
  830 |     steps: 80,
  831 |   })
  832 |   expectStableForwardMarkdownScroll(samples)
  833 | 
  834 |   await expect(
  835 |     page.locator('[data-testid="markdown-stress-status"]'),
  836 |   ).toHaveText('complete', { timeout: 20_000 })
  837 | })
  838 | 
  839 | test('markdown stress preview keeps position in narrow devtools-like viewport', async ({
  840 |   page,
  841 | }) => {
  842 |   test.setTimeout(60_000)
  843 |   await page.setViewportSize({ width: 520, height: 760 })
  844 |   await page.goto('/?visual=markdown-stress&theme=light', {
  845 |     waitUntil: 'domcontentloaded',
  846 |   })
  847 | 
  848 |   await expect(
  849 |     page.locator('[data-testid="markdown-stress-status"]'),
  850 |   ).toHaveText('complete', { timeout: 20_000 })
  851 | 
  852 |   const samples = await sampleMarkdownStressScroll(page, {
  853 |     delayMs: 8,
  854 |     steps: 80,
  855 |   })
  856 |   expectStableForwardMarkdownScroll(samples)
  857 | 
  858 |   const last = samples[samples.length - 1]
  859 |   expect(last.scrollHeight).toBeGreaterThan(last.clientHeight)
  860 |   expect(last.section).toBeGreaterThan(20)
  861 | })
  862 | 
```