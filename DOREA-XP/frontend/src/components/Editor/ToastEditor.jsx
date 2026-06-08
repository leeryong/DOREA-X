import React, { useEffect, useRef, useImperativeHandle, forwardRef, useCallback, useState } from 'react'

const AUTHORED_ASSET_NAME_RE = /^([A-Za-z0-9][A-Za-z0-9._-]*)$/

function normalizeAuthoredAssetSrc(src) {
  if (typeof src !== 'string') return ''
  if (src.startsWith('./assets/')) return src

  try {
    const url = new URL(src, window.location.origin)
    const match = url.pathname.match(/^\/assets\/([^/]+)$/)
    const assetName = match?.[1] ? decodeURIComponent(match[1]) : ''
    if (AUTHORED_ASSET_NAME_RE.test(assetName)) {
      return `./assets/${assetName}`
    }
  } catch {}

  return src
}

function normalizeAuthoredAssetMarkdown(markdown) {
  if (typeof markdown !== 'string' || !markdown) return markdown || ''

  return markdown
    .replace(/https?:\/\/[^\s)"']+\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)/g, './assets/$1')
    .replace(/(?<!\.)\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)/g, './assets/$1')
}

/**
 * Toast UI Editor wrapper for DOREA-X
 *
 * All @toast-ui/editor imports are DYNAMIC (loaded inside useEffect)
 * to avoid Vite production bundle initialization order issues.
 *
 * Imperative bridge methods exposed via ref:
 * - getMarkdown()                    → string
 * - setMarkdown(md)                  → void
 * - getSelection()                   → [start, end] or null
 * - replaceSelection(text, start?, end?) → void
 * - insertText(text)                 → void
 * - exec(command, ...payload)        → void
 * - getHTML()                        → string
 * - focus()                          → void
 * - blur()                           → void
 * - getRevisionHash()               → string (content hash for conflict detection)
 * - getInstance()                    → raw ToastUIEditor instance (escape hatch)
 */
const ToastEditor = forwardRef(function ToastEditor(
  {
    initialValue = '',
    initialEditType = 'wysiwyg',
    previewStyle = 'tab',
    height = '100%',
    placeholder = '문서 내용을 입력하세요...',
    plugins,
    toolbarItems,
    onChange,
    onFocus,
    onBlur,
    readOnly = false,
    className = '',
    resolveImageSrc,
    onImageInsert,
  },
  ref
) {
  const containerRef = useRef(null)
  const editorInstanceRef = useRef(null)
  const onChangeRef = useRef(onChange)
  const onFocusRef = useRef(onFocus)
  const onBlurRef = useRef(onBlur)
  const resolveImageSrcRef = useRef(resolveImageSrc)
  const resolveImageSrcScopeRef = useRef(0)
  const onImageInsertRef = useRef(onImageInsert)
  const initConfigRef = useRef({
    initialValue,
    initialEditType,
    previewStyle,
    height,
    placeholder,
    plugins,
    toolbarItems,
  })
  const [loading, setLoading] = useState(true)

  // Keep callback refs fresh without re-creating editor
  useEffect(() => { onChangeRef.current = onChange }, [onChange])
  useEffect(() => { onFocusRef.current = onFocus }, [onFocus])
  useEffect(() => { onBlurRef.current = onBlur }, [onBlur])
  useEffect(() => {
    resolveImageSrcRef.current = resolveImageSrc
    resolveImageSrcScopeRef.current += 1
  }, [resolveImageSrc])
  useEffect(() => { onImageInsertRef.current = onImageInsert }, [onImageInsert])

  // --- Mount / Unmount editor instance (DYNAMIC IMPORTS) ---
  useEffect(() => {
    if (!containerRef.current) return

    let destroyed = false

    async function initEditor() {
      // Dynamically inject CSS (idempotent — won't duplicate)
      await Promise.all([
        import('@toast-ui/editor/dist/toastui-editor.css'),
        import('@toast-ui/editor-plugin-color-syntax/dist/toastui-editor-plugin-color-syntax.css'),
      ])

      // Dynamically load JS modules
      const [editorModule, colorSyntaxModule] = await Promise.all([
        import('@toast-ui/editor'),
        import('@toast-ui/editor-plugin-color-syntax'),
      ])

      if (destroyed) return

      const ToastUIEditor = editorModule.default
      const colorSyntax = colorSyntaxModule.default

      const defaultToolbar = [
        ['heading', 'bold', 'italic', 'strike'],
        ['hr', 'quote'],
        ['ul', 'ol', 'task', 'indent', 'outdent'],
        ['table', 'link'],
        ['code', 'codeblock'],
      ]

      const initConfig = initConfigRef.current

      const editor = new ToastUIEditor({
        el: containerRef.current,
        initialValue: initConfig.initialValue,
        initialEditType: initConfig.initialEditType,
        previewStyle: initConfig.previewStyle,
        height: initConfig.height,
        placeholder: initConfig.placeholder,
        plugins: initConfig.plugins || [colorSyntax],
        toolbarItems: initConfig.toolbarItems || defaultToolbar,
        usageStatistics: false,
        hideModeSwitch: true,
        events: {
          change: () => {
            if (onChangeRef.current) {
              onChangeRef.current(normalizeAuthoredAssetMarkdown(editor.getMarkdown()))
            }
          },
          focus: () => { if (onFocusRef.current) onFocusRef.current() },
          blur: () => { if (onBlurRef.current) onBlurRef.current() },
        },
      })

      const assetBlobCache = new Map()
      let resolveRunId = 0

      const markAssetFailed = (img) => {
        img.dataset.assetResolved = 'failed'
        img.alt = '이미지 로드 실패'
        img.style.opacity = '0.3'
      }

      const buildClipboardPayloadFromSelection = () => {
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null

        const fragmentRoot = document.createElement('div')
        for (let index = 0; index < selection.rangeCount; index += 1) {
          fragmentRoot.appendChild(selection.getRangeAt(index).cloneContents())
        }

        const selectedImages = Array.from(fragmentRoot.querySelectorAll('img'))
        let hasCanonicalAssetImage = false
        selectedImages.forEach((img) => {
          const canonicalSrc = normalizeAuthoredAssetSrc(img.getAttribute('data-asset-original-src') || img.getAttribute('src') || '')
          if (!canonicalSrc.startsWith('./assets/')) return
          hasCanonicalAssetImage = true
          img.setAttribute('src', canonicalSrc)
        })

        if (!hasCanonicalAssetImage) return null

        return {
          html: fragmentRoot.innerHTML,
          text: fragmentRoot.textContent || '',
        }
      }

      const getSelectedRenderedAssetImages = () => {
        if (!pmEl) return []
        const selection = window.getSelection()
        if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return []

        const ranges = Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index))
        return Array.from(pmEl.querySelectorAll('img')).filter((img) => {
          const canonicalSrc = normalizeAuthoredAssetSrc(img.getAttribute('data-asset-original-src') || img.getAttribute('src') || '')
          if (!canonicalSrc.startsWith('./assets/')) return false
          return ranges.some((range) => {
            try {
              return range.intersectsNode(img)
            } catch {
              return false
            }
          })
        })
      }

      const preserveCanonicalAssetSrcForNativeCut = () => {
        const selectedImages = getSelectedRenderedAssetImages()
        if (!selectedImages.length) return

        const restoreEntries = selectedImages.map((img) => {
          const renderedSrc = img.getAttribute('src') || ''
          const canonicalSrc = normalizeAuthoredAssetSrc(img.getAttribute('data-asset-original-src') || renderedSrc)
          if (canonicalSrc.startsWith('./assets/')) {
            img.setAttribute('src', canonicalSrc)
          }
          return { img, renderedSrc }
        })

        window.setTimeout(() => {
          restoreEntries.forEach(({ img, renderedSrc }) => {
            if (renderedSrc) img.setAttribute('src', renderedSrc)
            else img.removeAttribute('src')
          })
        }, 0)
      }

      const resolveAssetImages = async () => {
        const resolver = resolveImageSrcRef.current
        if (!resolver || !containerRef.current) return

        const runId = ++resolveRunId
        const imgs = containerRef.current.querySelectorAll('img')

        for (const img of imgs) {
          if (!containerRef.current || runId !== resolveRunId) return

          const currentSrc = normalizeAuthoredAssetSrc(img.getAttribute('src') || '')

          if (!img.dataset.assetOriginalSrc && currentSrc.startsWith('./assets/')) {
            img.dataset.assetOriginalSrc = currentSrc
          }

          const assetSrc = normalizeAuthoredAssetSrc(img.dataset.assetOriginalSrc || '')
          if (!assetSrc.startsWith('./assets/')) continue
          if (img.dataset.assetResolved === 'done') continue
          if (img.dataset.assetResolved === 'pending') continue

          const cacheScope = resolveImageSrcScopeRef.current
          const cacheKey = `${cacheScope}:${assetSrc}`

          const cachedBlobUrl = assetBlobCache.get(cacheKey)
          if (cachedBlobUrl) {
            img.src = cachedBlobUrl
            img.dataset.assetResolved = 'done'
            img.style.opacity = ''
            continue
          }

          img.dataset.assetResolved = 'pending'

          try {
            const blobUrl = await resolver(assetSrc)
            if (!containerRef.current || runId !== resolveRunId) return

            if (blobUrl) {
              assetBlobCache.set(cacheKey, blobUrl)
              img.src = blobUrl
              img.dataset.assetResolved = 'done'
              img.style.opacity = ''
            } else {
              markAssetFailed(img)
            }
          } catch {
            if (!containerRef.current || runId !== resolveRunId) return
            markAssetFailed(img)
          }
        }
      }

      const wwContainer =
        containerRef.current.querySelector('.toastui-editor-ww-container')
        || containerRef.current.querySelector('.ProseMirror')
        || containerRef.current

      const observer = new MutationObserver(() => {
        resolveAssetImages().catch((err) => {
          console.error('[ToastEditor] Authored asset scan failed:', err)
        })
      })

      observer.observe(wwContainer, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src'],
      })

      resolveAssetImages().catch((err) => {
        console.error('[ToastEditor] Initial authored asset resolve failed:', err)
      })

      editor._assetObserver = observer
      editor._assetBlobCache = assetBlobCache

      const insertUploadedImage = (uploadResult) => {
        const imageUrl = uploadResult?.imageUrl || (uploadResult?.asset_name ? `./assets/${uploadResult.asset_name}` : '')
        if (!imageUrl) return
        const altText = uploadResult?.altText || 'image'
        editor.exec('addImage', {
          imageUrl,
          altText,
        })
      }

      // --- Image paste / drop interception ---
      const pmEl = containerRef.current?.querySelector('.toastui-editor-ww-container .ProseMirror')
        || containerRef.current?.querySelector('.ProseMirror')

      let removePmListeners = null

      if (pmEl) {
        const handleCopy = (e) => {
          const payload = buildClipboardPayloadFromSelection()
          if (!payload || !e.clipboardData) return
          e.preventDefault()
          e.clipboardData.setData('text/html', payload.html)
          e.clipboardData.setData('text/plain', payload.text)
        }

        const handlePaste = async (e) => {
          const cb = onImageInsertRef.current
          if (!cb) return
          const items = e.clipboardData?.items
          if (!items) return
          for (const item of items) {
            if (item.type.startsWith('image/')) {
              e.preventDefault()
              e.stopPropagation()
              e.stopImmediatePropagation()
              const file = item.getAsFile()
              if (!file) continue
              try {
                const result = await cb(file)
                if (result) {
                  insertUploadedImage(result)
                }
              } catch (err) {
                  console.error('[ToastEditor] Image paste upload failed:', err)
                }
                return
              }
            }
        }

        const handleCut = () => {
          preserveCanonicalAssetSrcForNativeCut()
        }

        const handleDrop = async (e) => {
          const cb = onImageInsertRef.current
          if (!cb) return
          const files = e.dataTransfer?.files
          if (!files || files.length === 0) return
          const imageFile = Array.from(files).find(f => f.type.startsWith('image/'))
          if (!imageFile) return
          e.preventDefault()
          e.stopPropagation()
          try {
            const result = await cb(imageFile)
            if (result) {
              insertUploadedImage(result)
            }
            } catch (err) {
              console.error('[ToastEditor] Image drop upload failed:', err)
            }
        }

        pmEl.addEventListener('copy', handleCopy)
        pmEl.addEventListener('cut', handleCut)
        pmEl.addEventListener('paste', handlePaste, true)
        pmEl.addEventListener('drop', handleDrop)

        removePmListeners = () => {
          pmEl.removeEventListener('copy', handleCopy)
          pmEl.removeEventListener('cut', handleCut)
          pmEl.removeEventListener('paste', handlePaste, true)
          pmEl.removeEventListener('drop', handleDrop)
        }
      }

      // Disable browser spellcheck on the contentEditable ProseMirror elements
      // to prevent red underlines on Korean/non-English text
      const editorEl = containerRef.current
      if (editorEl) {
        const proseMirrorEls = editorEl.querySelectorAll('.ProseMirror')
        proseMirrorEls.forEach((el) => {
          el.setAttribute('spellcheck', 'false')
        })
      }

      editorInstanceRef.current = editor
      setLoading(false)
    }

    initEditor().catch((err) => {
      console.error('[ToastEditor] Failed to load editor:', err)
      setLoading(false)
    })

      return () => {
        destroyed = true
        if (removePmListeners) {
          removePmListeners()
          removePmListeners = null
        }
        if (editorInstanceRef.current) {
          if (editorInstanceRef.current._assetBlobCache) {
          for (const url of editorInstanceRef.current._assetBlobCache.values()) {
            try { URL.revokeObjectURL(url) } catch {}
          }
          editorInstanceRef.current._assetBlobCache = null
        }
        if (editorInstanceRef.current._assetObserver) {
          editorInstanceRef.current._assetObserver.disconnect()
          editorInstanceRef.current._assetObserver = null
        }
        editorInstanceRef.current.destroy()
        editorInstanceRef.current = null
      }
    }
    // Intentionally NOT re-creating on prop changes — use bridge methods instead
  }, [])

  // --- Read-only toggle ---
  useEffect(() => {
    const editor = editorInstanceRef.current
    if (!editor) return
    if (readOnly) {
      editor.setHeight('100%')
      // Toast UI doesn't have a native read-only toggle; disable toolbar + contenteditable
      const el = editor.getEditorElements?.()?.wwEditor
        || editor.getEditorElements?.()?.mdEditor
        || containerRef.current?.querySelector('.toastui-editor-ww-container .ProseMirror')
        || containerRef.current?.querySelector('.toastui-editor-md-container .ProseMirror')
      if (el) el.contentEditable = String(!readOnly)
    }
  }, [readOnly])

  // --- Simple content hash for revision conflict detection ---
  const computeHash = useCallback((content) => {
    let hash = 0
    for (let i = 0; i < content.length; i++) {
      const chr = content.charCodeAt(i)
      hash = ((hash << 5) - hash) + chr
      hash |= 0 // Convert to 32bit integer
    }
    return hash.toString(36)
  }, [])

  // --- Imperative bridge ---
  useImperativeHandle(ref, () => ({
    getMarkdown() {
      return normalizeAuthoredAssetMarkdown(editorInstanceRef.current?.getMarkdown() ?? '')
    },
    setMarkdown(md) {
      const editor = editorInstanceRef.current
      if (!editor) return
      editor.setMarkdown(md, false)
    },
    getSelection() {
      const editor = editorInstanceRef.current
      if (!editor) return null
      try {
        return editor.getSelection()
      } catch {
        return null
      }
    },
    replaceSelection(text, start, end) {
      const editor = editorInstanceRef.current
      if (!editor) return
      if (start !== undefined && end !== undefined) {
        editor.replaceSelection(text, [start[0], start[1]], [end[0], end[1]])
      } else {
        editor.replaceSelection(text)
      }
    },
    insertText(text) {
      const editor = editorInstanceRef.current
      if (!editor) return
      editor.insertText(text)
    },
    exec(command, ...payload) {
      const editor = editorInstanceRef.current
      if (!editor) return
      editor.exec(command, ...payload)
    },
    getHTML() {
      return editorInstanceRef.current?.getHTML() ?? ''
    },
    focus() {
      editorInstanceRef.current?.focus()
    },
    blur() {
      editorInstanceRef.current?.blur()
    },
    getRevisionHash() {
      const md = editorInstanceRef.current?.getMarkdown() ?? ''
      return computeHash(md)
    },
    getInstance() {
      return editorInstanceRef.current
    },
    triggerImagePicker() {
      const cb = onImageInsertRef.current
      if (!cb) return
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/png,image/jpeg,image/jpg,image/webp,image/gif'
      input.onchange = async (e) => {
        const file = e.target.files?.[0]
        if (!file) return
        try {
          const result = await cb(file)
          if (result && editorInstanceRef.current) {
            const imageUrl = result.imageUrl || (result.asset_name ? `./assets/${result.asset_name}` : '')
            if (imageUrl) {
              editorInstanceRef.current.exec('addImage', {
                imageUrl,
                altText: result.altText || 'image',
              })
            }
          }
        } catch (err) {
          console.error('[ToastEditor] Image picker upload failed:', err)
        }
      }
      input.click()
    },
  }), [computeHash])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <style>{`
        .dorea-toast-editor .ProseMirror img,
        .dorea-toast-editor .toastui-editor-contents img,
        .dorea-toast-editor .toastui-editor-md-preview img {
          width: 100% !important;
          max-width: 100% !important;
          height: auto !important;
          display: block;
        }
      `}</style>
      <div
        ref={containerRef}
        className={`dorea-toast-editor ${className}`}
        style={{ width: '100%', height: '100%', display: loading ? 'none' : 'block' }}
      />
      {loading && (
        <div style={{
          position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: '#888',
          fontSize: '14px',
        }}>
          에디터 로딩 중...
        </div>
      )}
    </div>
  )
})

export default ToastEditor
