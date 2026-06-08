import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react'

// DOREA-XP RHWP wrapper — upstream @rhwp/editor v0.7.x 순정 + 단일 insertText
// 미니 패치(rhwp-service/patches/rhwp-insert-text.patch)만 가정한다.
// 인스턴스는 마운트 시 한 번만 만들고 언마운트 시에만 destroy한다. 그렇지 않으면
// @rhwp/editor가 등록한 글로벌 window message 리스너가 누수되어 탭 전환 시
// "blank editor / crash" 증상이 누적된다 (dorea-xp CLAUDE.md 참고).

const DEFAULT_RHWP_STUDIO_URL = '/rhwp/'

function buildDownloadName(filename) {
  const base = String(filename || 'document').trim() || 'document'
  return base.toLowerCase().endsWith('.hwpx') ? base : `${base.replace(/\.[^.]+$/, '')}.hwpx`
}

const RhwpEditor = forwardRef(function RhwpEditor(
  {
    studioUrl = import.meta.env.VITE_RHWP_STUDIO_URL || DEFAULT_RHWP_STUDIO_URL,
    onReady,
    onError,
  },
  ref,
) {
  const containerRef = useRef(null)
  const editorRef = useRef(null)
  const readyPromiseRef = useRef(null)
  const [status, setStatus] = useState('initializing')
  const [message, setMessage] = useState('한글 에디터를 초기화하는 중...')

  const ensureEditor = useCallback(() => {
    if (readyPromiseRef.current) return readyPromiseRef.current
    readyPromiseRef.current = (async () => {
      if (!containerRef.current) throw new Error('컨테이너가 준비되지 않았습니다.')
      const { createEditor } = await import('@rhwp/editor')
      const editor = await createEditor(containerRef.current, {
        studioUrl,
        width: '100%',
        height: '100%',
      })
      // 상위 @rhwp/editor의 _request 기본 타임아웃(10s)이 WASM cold-start +
      // 대용량 HWPX 검증/리플로우에는 빠듯해 60s로 늘려준다 (dorea-x 패턴).
      if (typeof editor._request === 'function' && !editor._requestPatched) {
        let localId = 1_000_000
        editor._request = function patchedRequest(method, params = {}) {
          return new Promise((resolve, reject) => {
            const id = ++localId
            editor._pending.set(id, { resolve, reject })
            try {
              editor._iframe.contentWindow.postMessage(
                { type: 'rhwp-request', id, method, params },
                '*',
              )
            } catch (err) {
              editor._pending.delete(id)
              reject(err)
              return
            }
            setTimeout(() => {
              if (editor._pending.has(id)) {
                editor._pending.delete(id)
                reject(new Error(`Request timeout: ${method}`))
              }
            }, 60_000)
          })
        }
        editor._requestPatched = true
      }
      editorRef.current = editor
      setStatus('ready')
      setMessage('')
      onReady?.()
      return editor
    })()
    readyPromiseRef.current.catch((err) => {
      console.error('[RhwpEditor] init failed:', err)
      setStatus('error')
      setMessage(err?.message || '한글 에디터 초기화에 실패했습니다.')
      readyPromiseRef.current = null
      onError?.(err)
    })
    return readyPromiseRef.current
  }, [studioUrl, onReady, onError])

  useEffect(() => {
    ensureEditor().catch(() => {})
  }, [ensureEditor])

  useEffect(() => () => {
    const editor = editorRef.current
    if (editor) {
      try { editor.destroy() } catch (err) { console.warn('[RhwpEditor] destroy failed:', err) }
      editorRef.current = null
    }
    if (containerRef.current) containerRef.current.innerHTML = ''
    readyPromiseRef.current = null
  }, [])

  const notifyLayoutChange = useCallback(() => {
    const iframe = containerRef.current?.querySelector('iframe')
    if (!iframe) return
    iframe.style.width = '100%'
    iframe.style.height = '100%'
    const ping = () => {
      try { iframe.contentWindow?.dispatchEvent(new Event('resize')) } catch {}
      try { iframe.contentWindow?.postMessage({ type: 'rhwp-host-resize' }, '*') } catch {}
    }
    ping()
    requestAnimationFrame(ping)
    window.setTimeout(ping, 120)
  }, [])

  useEffect(() => {
    if (status !== 'ready' || !containerRef.current) return undefined
    notifyLayoutChange()
    const observer = new ResizeObserver(() => notifyLayoutChange())
    observer.observe(containerRef.current)
    return () => observer.disconnect()
  }, [status, notifyLayoutChange])

  useImperativeHandle(ref, () => ({
    getEditorKind() { return 'rhwp' },
    getInstance() { return editorRef.current },
    isReady() { return status === 'ready' && !!editorRef.current },
    async waitReady() { await ensureEditor() },
    async loadHwpx(bytes, filename = 'document.hwpx') {
      const editor = await ensureEditor()
      const buffer = bytes instanceof ArrayBuffer ? bytes
        : bytes instanceof Blob ? await bytes.arrayBuffer()
        : bytes?.buffer instanceof ArrayBuffer ? bytes.buffer
        : null
      if (!buffer) throw new Error('HWPX 바이트가 필요합니다.')
      const result = await editor.loadFile(buffer, filename)
      notifyLayoutChange()
      return result
    },
    async insertText(text, { sec = 0 } = {}) {
      const editor = await ensureEditor()
      const str = String(text ?? '')
      if (!str) return { ok: false, reason: 'empty text' }
      const r = await editor._request('insertText', { text: str, sec })
      notifyLayoutChange()
      return r
    },
    async exportHwpxBytes() {
      const editor = await ensureEditor()
      return editor.exportHwpx()
    },
    async exportHwpxBlob() {
      const bytes = await this.exportHwpxBytes()
      return new Blob([bytes], { type: 'application/vnd.hancom.hwpx' })
    },
    async downloadHwpx(downloadName = 'document.hwpx') {
      const blob = await this.exportHwpxBlob()
      const url = URL.createObjectURL(blob)
      try {
        const a = document.createElement('a')
        a.href = url
        a.download = buildDownloadName(downloadName)
        a.click()
      } finally {
        URL.revokeObjectURL(url)
      }
      return blob
    },
    notifyLayoutChange,
  }), [ensureEditor, notifyLayoutChange, status])

  return (
    <div className="relative h-full w-full bg-background">
      <div ref={containerRef} className="h-full w-full" />
      {status !== 'ready' && (
        <div className="absolute inset-0 flex items-center justify-center bg-background/90 px-4 text-center text-sm text-muted-foreground">
          <div className="space-y-2">
            <div>{message}</div>
            {status === 'error' && (
              <div className="text-xs text-muted-foreground">studioUrl: {studioUrl}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
})

export default RhwpEditor
