import type { ArticleExportFormat } from '../../../Contracts/markdown-export'

export const exportFormatLabels: Record<ArticleExportFormat, string> = {
  md: 'Markdown', docx: 'Word', html: 'HTML', epub: 'EPUB', pdf: 'PDF',
}

export function downloadExport(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  try {
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    link.click()
  } finally {
    // Let the browser start reading before releasing the download URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }
}
