import { defineAsyncComponent } from 'vue'

export const AsyncMdEditor = defineAsyncComponent(async () => {
  await import('md-editor-v3/lib/style.css')
  const mod = await import('md-editor-v3')
  return mod.MdEditor
})
