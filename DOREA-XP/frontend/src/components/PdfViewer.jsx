import React, { useEffect, useMemo, useRef, useState } from 'react'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import { filesAPI, myDocumentsAPI } from '@/services/api'
import { toast } from '@/services/toast'

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
  ArrowLeftRight,
  ArrowUpDown,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Columns2,
  Camera,
  Copy,
} from 'lucide-react'

// Use locally bundled worker (no CDN dependency)
pdfjsLib.GlobalWorkerOptions.workerSrc = `${pdfWorkerUrl}?v=1`

const VIEW_MARGIN_PX = 16
const SPREAD_GAP_PX = 16

const ZOOM_PERCENT_PRESETS = [50, 75, 100, 125, 150, 200]
const MIN_SCALE = 0.01
const SINGLE_VIEW_PRIORITY_OFFSETS = [0, 1, -1, 2, -2]
const TWO_UP_PRIORITY_SPREAD_OFFSETS = [0, 2, -2]
const INITIAL_SINGLE_RENDER_COUNT = 3
const INITIAL_TWO_UP_RENDER_COUNT = 4
const IDLE_RENDER_TIMEOUT_MS = 200
const IDLE_RENDER_FALLBACK_MS = 32

const ICON_BUTTON_CLASS =
  'inline-flex h-9 w-9 items-center justify-center rounded-md border border-input bg-background text-foreground hover:bg-accent hover:text-accent-foreground disabled:pointer-events-none disabled:opacity-50'
const ICON_BUTTON_ACTIVE_CLASS = 'bg-accent text-accent-foreground'
const ICON_BUTTON_TOGGLE_ACTIVE_CLASS = 'bg-primary text-primary-foreground hover:bg-primary/90'
const ICON_BUTTON_TOGGLE_INACTIVE_CLASS = 'opacity-60'

/**
 * Drag box overlay component - renders outside useMemo for real-time updates
 */
function DragBoxOverlay({ drag, dragStyle, pageRefs, wrapperRef, isCaptureMode }) {
  if (!drag || !dragStyle) return null
  
  const pageEl = pageRefs.current?.[drag.pageNum]
  const wrapper = wrapperRef.current
  if (!pageEl || !wrapper) return null

  const pageRect = pageEl.getBoundingClientRect()
  const wrapperRect = wrapper.getBoundingClientRect()

  // Position relative to wrapper (accounting for scroll)
  const left = pageRect.left - wrapperRect.left + wrapper.scrollLeft + dragStyle.left
  const top = pageRect.top - wrapperRect.top + wrapper.scrollTop + dragStyle.top

  return (
    <div
      style={{
        position: 'absolute',
        left,
        top,
        width: dragStyle.width,
        height: dragStyle.height,
        border: isCaptureMode ? '2px dashed #B91C1C' : '2px dashed #6b7280',
        backgroundColor: isCaptureMode ? 'rgba(185, 28, 28, 0.15)' : 'rgba(107, 114, 128, 0.15)',
        pointerEvents: 'none',
        zIndex: 20,
        borderRadius: '4px',
        boxSizing: 'border-box',
      }}
    />
  )
}


function clampScale(nextScale) {
  if (!Number.isFinite(nextScale)) return 1.0
  return Math.max(MIN_SCALE, nextScale)
}

function clampPage(pageNum, totalPages) {
  if (!Number.isFinite(pageNum)) return 1
  if (totalPages <= 0) return 1
  return Math.max(1, Math.min(totalPages, pageNum))
}

function normalizeTwoUpStart(pageNum, totalPages) {
  const clamped = clampPage(pageNum, totalPages)
  if (clamped <= 1) return 1

  const normalized = clamped % 2 === 0 ? clamped - 1 : clamped

  // If total pages is even, last spread starts at totalPages - 1.
  if (totalPages > 0 && totalPages % 2 === 0) {
    return Math.min(normalized, totalPages - 1)
  }

  return normalized
}

function normalizeNavPage(pageNum, viewMode, totalPages) {
  if (viewMode === 'twoUp') return normalizeTwoUpStart(pageNum, totalPages)
  return clampPage(pageNum, totalPages)
}

function getLastNavPage(viewMode, totalPages) {
  if (totalPages <= 0) return 1
  if (viewMode === 'twoUp') return totalPages % 2 === 0 ? Math.max(1, totalPages - 1) : totalPages
  return totalPages
}

function formatZoomLabelFromPercent(percent) {
  return `${percent}%`
}

function isEditableElement(el) {
  if (!el) return false
  const tag = el.tagName?.toLowerCase?.()
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return true
  if (el.isContentEditable) return true
  return false
}

function getSegmentDisplayText(segment) {
  if (!segment) return ''
  const enriched = segment.enriched_text
  if (enriched && String(enriched).trim()) return String(enriched).trim()
  const rag = segment.rag_text
  if (rag && String(rag).trim()) return String(rag).trim()
  return String(segment.text || '').trim()
}

function isCopyableSegment(segment) {
  const type = String(segment?.type || segment?.segment_type || '').trim().toLowerCase()
  return ['figure', 'picture', 'image', 'photo', 'table'].some((keyword) => type.includes(keyword))
}

function canvasToBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob)
        return
      }
      reject(new Error('Failed to create capture image blob'))
    }, 'image/png')
  })
}

function imageBitmapToBlob(bitmap) {
  const canvas = document.createElement('canvas')
  canvas.width = bitmap.width
  canvas.height = bitmap.height
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    return Promise.reject(new Error('Failed to create canvas context for clipboard conversion'))
  }
  ctx.drawImage(bitmap, 0, 0)
  bitmap.close()
  return canvasToBlob(canvas)
}

function canUseAsyncImageClipboard() {
  return window.isSecureContext && typeof ClipboardItem !== 'undefined' && Boolean(navigator?.clipboard?.write)
}

function getImageClipboardFailureMessage() {
  if (!window.isSecureContext) {
    return '현재 HTTP 접속에서는 브라우저가 이미지 클립보드 복사를 차단합니다. HTTPS 또는 localhost로 접속해 주세요.'
  }
  if (typeof ClipboardItem === 'undefined' || !navigator?.clipboard?.write) {
    return '현재 브라우저가 이미지 클립보드 복사를 지원하지 않습니다.'
  }
  return '이미지를 클립보드에 복사하지 못했습니다.'
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error || new Error('Failed to read clipboard image blob'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsDataURL(blob)
  })
}

async function fallbackCopyImageViaExecCommand(blobOrPromise) {
  if (typeof document?.execCommand !== 'function') {
    return false
  }

  let container = null
  try {
    const blob = await Promise.resolve(blobOrPromise).then((value) => convertBlobToClipboardPng(value))
    const dataUrl = await blobToDataUrl(blob)
    if (!dataUrl) return false

    const activeEl = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const selection = window.getSelection()
    const savedRanges = []
    if (selection) {
      for (let i = 0; i < selection.rangeCount; i += 1) {
        savedRanges.push(selection.getRangeAt(i).cloneRange())
      }
    }

    container = document.createElement('div')
    container.contentEditable = 'true'
    container.setAttribute('aria-hidden', 'true')
    container.style.position = 'fixed'
    container.style.left = '-9999px'
    container.style.top = '0'
    container.style.pointerEvents = 'none'
    container.style.opacity = '0'

    const img = document.createElement('img')
    img.src = dataUrl
    img.alt = 'clipboard copy'
    container.appendChild(img)
    document.body.appendChild(container)

    const range = document.createRange()
    range.selectNode(img)
    selection?.removeAllRanges()
    selection?.addRange(range)
    container.focus({ preventScroll: true })
    const copied = document.execCommand('copy')

    selection?.removeAllRanges()
    savedRanges.forEach((savedRange) => selection?.addRange(savedRange))
    activeEl?.focus?.({ preventScroll: true })
    document.body.removeChild(container)
    return copied
  } catch (err) {
    console.warn('Fallback image copy failed:', err)
    if (container?.parentNode) {
      container.parentNode.removeChild(container)
    }
    return false
  }
}

async function convertBlobToClipboardPng(blob) {
  if (!(blob instanceof Blob) || blob.size === 0) {
    throw new Error('Clipboard image blob is empty')
  }
  if (blob.type === 'image/png') {
    return blob
  }
  const bitmap = await createImageBitmap(blob)
  return imageBitmapToBlob(bitmap)
}

async function writeImageBlobToClipboard(blobOrPromise) {
  if (!canUseAsyncImageClipboard()) {
    return fallbackCopyImageViaExecCommand(blobOrPromise)
  }

  try {
    const pngBlobPromise = Promise.resolve(blobOrPromise).then((blob) => convertBlobToClipboardPng(blob))
    await navigator.clipboard.write([
      new ClipboardItem({ 'image/png': pngBlobPromise })
    ])
    return true
  } catch (err) {
    console.warn('Failed to copy image to clipboard:', err)
    return fallbackCopyImageViaExecCommand(blobOrPromise)
  }
}

function pushUniquePage(queue, seen, pageNum, totalPages) {
  if (pageNum < 1 || pageNum > totalPages || seen.has(pageNum)) return
  seen.add(pageNum)
  queue.push(pageNum)
}

function pushSpreadPages(queue, seen, spreadStart, totalPages) {
  const leftPage = normalizeTwoUpStart(spreadStart, totalPages)
  pushUniquePage(queue, seen, leftPage, totalPages)
  pushUniquePage(queue, seen, leftPage + 1, totalPages)
}

function getPriorityPages(totalPages, viewMode, navPage) {
  const queue = []
  const seen = new Set()

  if (viewMode === 'twoUp') {
    const currentSpread = normalizeTwoUpStart(navPage, totalPages)

    for (const offset of TWO_UP_PRIORITY_SPREAD_OFFSETS) {
      pushSpreadPages(queue, seen, currentSpread + offset, totalPages)
    }

    return queue
  }

  const currentPage = clampPage(navPage, totalPages)

  for (const offset of SINGLE_VIEW_PRIORITY_OFFSETS) {
    pushUniquePage(queue, seen, currentPage + offset, totalPages)
  }

  return queue
}

function getRenderQueue(totalPages, viewMode, navPage) {
  const queue = getPriorityPages(totalPages, viewMode, navPage)
  const seen = new Set(queue)

  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    pushUniquePage(queue, seen, pageNum, totalPages)
  }

  return queue
}

function scheduleIdleRender(callback) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    return {
      type: 'idle',
      id: window.requestIdleCallback(callback, { timeout: IDLE_RENDER_TIMEOUT_MS }),
    }
  }

  return {
    type: 'timeout',
    id: window.setTimeout(() => {
      callback({ didTimeout: true, timeRemaining: () => 0 })
    }, IDLE_RENDER_FALLBACK_MS),
  }
}

function cancelScheduledIdleRender(handle) {
  if (!handle) return

  if (handle.type === 'idle' && typeof window !== 'undefined' && typeof window.cancelIdleCallback === 'function') {
    window.cancelIdleCallback(handle.id)
    return
  }

  if (handle.type === 'timeout' && typeof window !== 'undefined') {
    window.clearTimeout(handle.id)
  }
}

export default function PdfViewer({
  fileId,
  fileDomain = 'analysis',
  pdfUrl,
  segments = [],
  selectedSegments = [],
  onSegmentClick,
  focusSegmentId,
  onInsertImageToEditor,
  onCaptureImage,
  onCaptureText,
  onSegmentBoxSelect,
  isVisionCapable = false,
  onPageChange,
}) {
  const containerRef = useRef(null)
  const wrapperRef = useRef(null)

  const canvasRefs = useRef({})
  const pageRefs = useRef({})
  const renderTasksRef = useRef({})
  const renderCycleRef = useRef(0)
  const pageBaseSizesRef = useRef({})
  const focusScrollStateRef = useRef({ segmentId: null, pageNum: null, didFallback: false, didRefine: false })
  const activeNavPageRef = useRef(1)

  const [pdf, setPdf] = useState(null)
  const [totalPages, setTotalPages] = useState(0)
  const [scale, setScale] = useState(1.0)
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [preferPageImages, setPreferPageImages] = useState(false)

  const [pageShells, setPageShells] = useState({})
  const [pageViewports, setPageViewports] = useState({})
  const [pageRenderStatus, setPageRenderStatus] = useState({})
  const [pageImageUrls, setPageImageUrls] = useState({})
  const [activePageRaw, setActivePageRaw] = useState(1)
  const pageImageUrlsRef = useRef({})

  const [viewMode, setViewMode] = useState('single') // 'single' | 'twoUp'
  const [fitMode, setFitMode] = useState('width') // null | 'width' | 'height' (default: width)

  const [pageInput, setPageInput] = useState('1')
  const [isViewerFocused, setIsViewerFocused] = useState(false)

  // Capture mode state
  const [captureMode, setCaptureMode] = useState(false)
  const [captureDrag, setCaptureDrag] = useState(null) // { startX, startY, currentX, currentY, pageNum }

  // Temporary captured regions persist as image crop overlays.
  const [capturedRegions, setCapturedRegions] = useState([])

  // Normal mode drag selection state (for box-selecting segments)
  const [selectionDrag, setSelectionDrag] = useState(null) // { startX, startY, currentX, currentY, pageNum, startClientX, startClientY, isAdditive }
  const DRAG_THRESHOLD = 8 // pixels - to distinguish click from drag

  const activeNavPage = useMemo(
    () => normalizeNavPage(activePageRaw, viewMode, totalPages),
    [activePageRaw, viewMode, totalPages]
  )

  const lastNavPage = useMemo(() => getLastNavPage(viewMode, totalPages), [viewMode, totalPages])

  const activeRightPage = useMemo(() => {
    if (viewMode !== 'twoUp') return null
    const r = activeNavPage + 1
    return r <= totalPages ? r : null
  }, [viewMode, activeNavPage, totalPages])

  const viewerApi = fileDomain === 'my_documents' ? myDocumentsAPI : filesAPI

  function revokePageImageUrl(pageNum) {
    const existingUrl = pageImageUrlsRef.current[pageNum]
    if (!existingUrl) return
    URL.revokeObjectURL(existingUrl)
    delete pageImageUrlsRef.current[pageNum]
  }

  function revokeAllPageImageUrls() {
    for (const pageNum of Object.keys(pageImageUrlsRef.current)) {
      revokePageImageUrl(pageNum)
    }
  }

  const zoomPercent = useMemo(() => Math.round(clampScale(scale) * 100), [scale])

  const zoomOptions = useMemo(() => {
    const preset = ZOOM_PERCENT_PRESETS
    const inPreset = preset.includes(zoomPercent)

    const modeLabel = fitMode === 'width' ? '폭맞춤' : fitMode === 'height' ? '높이맞춤' : null
    const currentLabel = modeLabel ? `${zoomPercent}% (${modeLabel})` : `${zoomPercent}%`

    const base = preset
      .filter((p) => p !== zoomPercent)
      .map((p) => ({ value: p, label: `${p}%` }))

    if (!inPreset || modeLabel) {
      return [{ value: zoomPercent, label: currentLabel, dynamic: true }, ...base]
    }

    return preset.map((p) => ({ value: p, label: `${p}%` }))
  }, [zoomPercent, fitMode])

  useEffect(() => {
    activeNavPageRef.current = activeNavPage
  }, [activeNavPage])

  // Keep page input in sync with the toolbar page
  useEffect(() => {
    setPageInput(String(activeNavPage))
    onPageChange?.({ page: activeNavPage, totalPages })
  }, [activeNavPage, totalPages])

  async function getPageBaseSize(pageNum) {
    const cached = pageBaseSizesRef.current[pageNum]
    if (cached?.width && cached?.height) return cached

    if (!pdf) return null

    try {
      const page = await pdf.getPage(pageNum)
      const viewport = page.getViewport({ scale: 1.0 })
      const size = { width: viewport.width, height: viewport.height }
      pageBaseSizesRef.current[pageNum] = size
      return size
    } catch (err) {
      return null
    }
  }

  async function applyFitScale(nextFitMode) {
    if (!nextFitMode) return
    if (!pdf || totalPages <= 0) return

    const wrapper = wrapperRef.current
    if (!wrapper) return

    const effectivePage = normalizeNavPage(activePageRaw, viewMode, totalPages)
    const baseSize = await getPageBaseSize(effectivePage)
    if (!baseSize) return

    const availableWidth = Math.max(0, wrapper.clientWidth - VIEW_MARGIN_PX * 2)
    const availableHeight = Math.max(0, wrapper.clientHeight - VIEW_MARGIN_PX * 2)

    let nextScale = 1.0

    if (nextFitMode === 'width') {
      if (viewMode === 'twoUp') {
        const hasRight = effectivePage + 1 <= totalPages
        const pagesInRow = hasRight ? 2 : 1
        const gap = pagesInRow === 2 ? SPREAD_GAP_PX : 0
        const totalWidth = baseSize.width * pagesInRow + gap
        nextScale = totalWidth > 0 ? availableWidth / totalWidth : 1.0
      } else {
        nextScale = baseSize.width > 0 ? availableWidth / baseSize.width : 1.0
      }
    } else if (nextFitMode === 'height') {
      nextScale = baseSize.height > 0 ? availableHeight / baseSize.height : 1.0
    }

    const finalScale = clampScale(nextScale)

    setScale((prev) => {
      if (Math.abs(prev - finalScale) < 0.002) return prev
      return finalScale
    })
  }

  function getPageLayout(pageNum) {
    return pageShells[pageNum] || pageViewports[pageNum] || null
  }

  function getSpreadLayout(leftPage, rightPage = null) {
    const leftLayout = getPageLayout(leftPage)
    const rightLayout = rightPage ? getPageLayout(rightPage) : null
    const gap = rightLayout ? SPREAD_GAP_PX : 0

    const width = (leftLayout?.width || 0) + (rightLayout?.width || 0) + gap
    const height = Math.max(leftLayout?.height || 0, rightLayout?.height || 0)

    if (width <= 0 && height <= 0) return null

    return { width, height }
  }

  function resetCanvasElement(canvas) {
    if (!canvas) return

    canvas.width = 0
    canvas.height = 0
    canvas.style.width = ''
    canvas.style.height = ''
  }

  function resetAllCanvases() {
    for (const canvas of Object.values(canvasRefs.current)) {
      resetCanvasElement(canvas)
    }
  }

  useEffect(() => {
    let cancelled = false

    revokeAllPageImageUrls()
    setPageImageUrls({})
    setPreferPageImages(false)

    if (!fileId) {
      return () => {
        cancelled = true
      }
    }

    viewerApi
      .getViewerProfile(fileId)
      .then((profile) => {
        if (cancelled) return
        setPreferPageImages(Boolean(profile?.prefer_page_images))
      })
      .catch(() => {
        if (cancelled) return
        setPreferPageImages(false)
      })

    return () => {
      cancelled = true
      revokeAllPageImageUrls()
    }
  }, [fileId, fileDomain])

  // Load PDF when URL changes
  useEffect(() => {
    if (!pdfUrl) {
      setPdf(null)
      setTotalPages(0)
      setPageShells({})
      setPageViewports({})
      setPageRenderStatus({})
      setActivePageRaw(1)
      setScale(1.0)
      setFitMode('width')
      setViewMode('single')
      pageBaseSizesRef.current = {}
      focusScrollStateRef.current = { segmentId: null, pageNum: null, didFallback: false, didRefine: false }
      resetAllCanvases()
      return
    }

    let isCancelled = false

    setPdf(null)
    setTotalPages(0)
    setPageShells({})
    setPageViewports({})
    setPageRenderStatus({})
    setActivePageRaw(1)
    setScale(1.0)
    setFitMode('width')
    setViewMode('single')
    pageBaseSizesRef.current = {}
    focusScrollStateRef.current = { segmentId: null, pageNum: null, didFallback: false, didRefine: false }
    resetAllCanvases()

    async function loadPdf() {
      setIsLoading(true)
      setError(null)

      try {
        const token = localStorage.getItem('access_token')
        const loadingTask = pdfjsLib.getDocument({
          url: pdfUrl,
          httpHeaders: token ? { Authorization: `Bearer ${token}` } : undefined,
        })

        const pdfDoc = await loadingTask.promise
        if (!isCancelled) {
          setPdf(pdfDoc)
          setTotalPages(pdfDoc.numPages)
          setPageShells({})
          setPageViewports({})
          setPageRenderStatus({})
          setActivePageRaw(1)
          setScale(1.0)
          setFitMode('width')
          setViewMode('single')
          pageBaseSizesRef.current = {}
          focusScrollStateRef.current = { segmentId: null, pageNum: null, didFallback: false, didRefine: false }
          requestAnimationFrame(() => {
            if (wrapperRef.current) wrapperRef.current.scrollTop = 0
          })
        }
      } catch (err) {
        if (!isCancelled) {
          console.error('PDF Load Error:', err)
          const msg = String(err?.message || err)
          const m = msg.match(/Unexpected server response \((\d+)\)/)
          const status = m ? parseInt(m[1], 10) : null

          if (msg.includes('Setting up fake worker failed')) {
            setError('PDF 렌더러 초기화에 실패했습니다.')
          } else if (status === 401 || status === 403) {
            setError('로그인이 필요합니다.')
          } else if (status === 404) {
            setError('PDF가 아직 준비되지 않았습니다.')
          } else {
            setError('PDF를 불러올 수 없습니다.')
          }
        }
      } finally {
        if (!isCancelled) setIsLoading(false)
      }
    }

    loadPdf()
    return () => {
      isCancelled = true
    }
  }, [pdfUrl])

  // Render all pages when pdf/scale changes
  useEffect(() => {
    if (!pdf || !totalPages) return

    let cancelled = false
    const renderCycleId = renderCycleRef.current + 1
    renderCycleRef.current = renderCycleId
    let idleHandle = null
    let finishRenderQueue = () => {}
    let isRenderQueueFinished = false

    function isStale() {
      return cancelled || renderCycleRef.current !== renderCycleId
    }

    function completeRenderQueue() {
      if (isRenderQueueFinished) return
      isRenderQueueFinished = true
      finishRenderQueue()
    }

    async function renderAll() {
      setIsLoading(true)
      setError(null)

      const renderQueueDone = new Promise((resolve) => {
        finishRenderQueue = resolve
      })

      for (const task of Object.values(renderTasksRef.current)) {
        try {
          task?.cancel?.()
        } catch (_) {}
      }
      renderTasksRef.current = {}

      const nextStatus = {}
      for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
        nextStatus[pageNum] = 'pending'
      }

      setPageViewports({})
      setPageRenderStatus(nextStatus)
      resetAllCanvases()

      const nextShells = {}
      const pageCache = {}
      const pendingPages = new Set()
      const baseScale = scale
      const initialRenderBudget = viewMode === 'twoUp' ? INITIAL_TWO_UP_RENDER_COUNT : INITIAL_SINGLE_RENDER_COUNT

      function setPageViewport(pageNum, viewport) {
        setPageViewports((prev) => {
          if (renderCycleRef.current !== renderCycleId) return prev
          return {
            ...prev,
            [pageNum]: { width: viewport.width, height: viewport.height },
          }
        })
      }

      function setPageStatus(pageNum, status) {
        setPageRenderStatus((prev) => {
          if (renderCycleRef.current !== renderCycleId) return prev
          return { ...prev, [pageNum]: status }
        })
      }

      function getNextPendingPage() {
        const queue = getRenderQueue(totalPages, viewMode, activeNavPageRef.current)

        for (const pageNum of queue) {
          if (pendingPages.has(pageNum)) return pageNum
        }

        return null
      }

      async function renderPageByNumber(pageNum) {
        if (!pendingPages.has(pageNum) || isStale()) return false

        const page = pageCache[pageNum] || await pdf.getPage(pageNum)
        if (isStale()) return false

        const viewport = page.getViewport({ scale: baseScale })

        pageBaseSizesRef.current[pageNum] = {
          width: viewport.width / baseScale,
          height: viewport.height / baseScale,
        }

        const canvas = canvasRefs.current[pageNum]
        if (preferPageImages && fileId) {
          setPageStatus(pageNum, 'rendering')
          try {
            const imageBlob = await viewerApi.fetchPagePreviewBlob(fileId, pageNum)
            if (isStale()) return false

            const nextUrl = URL.createObjectURL(imageBlob)
            revokePageImageUrl(pageNum)
            pageImageUrlsRef.current[pageNum] = nextUrl
            setPageImageUrls((prev) => ({ ...prev, [pageNum]: nextUrl }))

            pendingPages.delete(pageNum)
            setPageViewport(pageNum, viewport)
            setPageStatus(pageNum, 'rendered')
            return true
          } catch (pageImageError) {
            if (!isStale()) {
              console.warn('Page preview fallback failed, using canvas render:', pageImageError)
            }
          }
        }

        if (!canvas) {
          pendingPages.delete(pageNum)
          setPageViewport(pageNum, viewport)
          setPageStatus(pageNum, 'rendered')
          return true
        }

        const ctx = canvas.getContext('2d')
        const dpr = window.devicePixelRatio || 1
        canvas.width = Math.ceil(viewport.width * dpr)
        canvas.height = Math.ceil(viewport.height * dpr)
        canvas.style.width = `${viewport.width}px`
        canvas.style.height = `${viewport.height}px`

        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        setPageStatus(pageNum, 'rendering')

        const renderTask = page.render({ canvasContext: ctx, viewport })
        renderTasksRef.current[pageNum] = renderTask

        try {
          await renderTask.promise
        } finally {
          if (renderTasksRef.current[pageNum] === renderTask) {
            delete renderTasksRef.current[pageNum]
          }
        }

        if (isStale()) return false

        pendingPages.delete(pageNum)
        setPageViewport(pageNum, viewport)
        setPageStatus(pageNum, 'rendered')
        return true
      }

      function scheduleBackgroundRender() {
        if (isStale()) {
          completeRenderQueue()
          return
        }

        if (idleHandle || pendingPages.size === 0) {
          if (pendingPages.size === 0) completeRenderQueue()
          return
        }

        idleHandle = scheduleIdleRender(async () => {
          idleHandle = null
          if (isStale()) {
            completeRenderQueue()
            return
          }

          const nextPage = getNextPendingPage()
          if (!nextPage) {
            completeRenderQueue()
            return
          }

          try {
            await renderPageByNumber(nextPage)
          } catch (err) {
            if (!isStale() && err?.name !== 'RenderingCancelledException') {
              console.error('Page Render Error:', err)
            }
            completeRenderQueue()
            return
          }

          if (pendingPages.size === 0) {
            completeRenderQueue()
            return
          }

          scheduleBackgroundRender()
        })
      }

      try {
        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
          let page = null
          let baseSize = pageBaseSizesRef.current[pageNum]

          if (!baseSize?.width || !baseSize?.height) {
            page = await pdf.getPage(pageNum)
            const baseViewport = page.getViewport({ scale: 1.0 })
            baseSize = { width: baseViewport.width, height: baseViewport.height }
            pageBaseSizesRef.current[pageNum] = baseSize
          }

          nextShells[pageNum] = {
            width: baseSize.width * baseScale,
            height: baseSize.height * baseScale,
          }

          if (page) pageCache[pageNum] = page
        }

        if (isStale()) return

        setPageShells(nextShells)

        await new Promise((resolve) => {
          requestAnimationFrame(() => resolve())
        })

        for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
          pendingPages.add(pageNum)
        }

        for (let i = 0; i < initialRenderBudget; i++) {
          if (isStale()) {
            completeRenderQueue()
            return
          }

          const nextPage = getNextPendingPage()
          if (!nextPage) break

          await renderPageByNumber(nextPage)
        }

        if (pendingPages.size === 0) {
          completeRenderQueue()
        } else {
          scheduleBackgroundRender()
        }

        await renderQueueDone
      } catch (err) {
        if (!isStale() && err?.name !== 'RenderingCancelledException') {
          console.error('Page Render Error:', err)
        }
        completeRenderQueue()
      } finally {
        if (!isStale()) setIsLoading(false)
      }
    }

    renderAll()
    return () => {
      cancelled = true
      renderCycleRef.current += 1
      cancelScheduledIdleRender(idleHandle)
      idleHandle = null
      completeRenderQueue()
      for (const task of Object.values(renderTasksRef.current)) {
        try {
          task?.cancel?.()
        } catch (_) {}
      }
      renderTasksRef.current = {}
    }
  }, [pdf, totalPages, scale, pdfUrl, fitMode, viewMode, preferPageImages, fileId, fileDomain])

  // Track active page based on visibility (toolbar indicator)
  useEffect(() => {
    const root = wrapperRef.current
    if (!root || totalPages <= 0) return

    const observer = new IntersectionObserver(
      (entries) => {
        let best = null
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const pageNum = parseInt(e.target.getAttribute('data-page') || '1', 10)
          const ratio = e.intersectionRatio || 0
          if (!best || ratio > best.ratio) best = { pageNum, ratio }
        }
        if (best) setActivePageRaw(best.pageNum)
      },
      { root, threshold: [0.35, 0.5, 0.65] }
    )

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const el = pageRefs.current[pageNum]
      if (el) observer.observe(el)
    }

    return () => observer.disconnect()
  }, [totalPages, pdfUrl, scale, viewMode])

  // Keep fit mode scale updated on changes (page/view switch)
  // Also triggers when pdf is loaded (pdf dependency)
  useEffect(() => {
    if (!fitMode) return
    if (!pdf) return
    applyFitScale(fitMode)
  }, [fitMode, viewMode, activePageRaw, totalPages, pdfUrl, pdf])

  // Keep fit mode scale updated on resize
  useEffect(() => {
    const el = wrapperRef.current
    if (!el || !fitMode) return

    let rafId = 0
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(() => {
        applyFitScale(fitMode)
      })
    })

    ro.observe(el)

    return () => {
      cancelAnimationFrame(rafId)
      ro.disconnect()
    }
  }, [fitMode, viewMode, activePageRaw, pdfUrl])

  function scrollToPage(pageNum) {
    const el = pageRefs.current[pageNum]
    if (!el) return
    el.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  function goToPage(pageNum) {
    const next = normalizeNavPage(pageNum, viewMode, totalPages)
    scrollToPage(next)
  }

  function isPageGeometryReady(pageNum) {
    return pageRenderStatus[pageNum] === 'rendered' && Boolean(pageViewports[pageNum])
  }

  // Scroll to a specific segment (used by chat segment reference click)
  useEffect(() => {
    if (!focusSegmentId) {
      focusScrollStateRef.current = { segmentId: null, pageNum: null, didFallback: false, didRefine: false }
      return
    }

    const seg = segments?.find((s) => s.id === focusSegmentId)
    if (!seg) return

    const pageNum = seg.page || 1
    const wrapper = wrapperRef.current
    const pageEl = pageRefs.current[pageNum]

    if (!wrapper || !pageEl) {
      scrollToPage(pageNum)
      return
    }

    const focusState = focusScrollStateRef.current
    if (focusState.segmentId !== focusSegmentId || focusState.pageNum !== pageNum) {
      focusScrollStateRef.current = {
        segmentId: focusSegmentId,
        pageNum,
        didFallback: false,
        didRefine: false,
      }
    }

    const nextFocusState = focusScrollStateRef.current
    const pageReady = isPageGeometryReady(pageNum)

    if (!pageReady) {
      if (!nextFocusState.didFallback) {
        pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
        nextFocusState.didFallback = true
      }
      return
    }

    const bbox = seg.bbox
    const vp = pageViewports[pageNum]

    if (bbox && vp) {
      if (nextFocusState.didRefine) return

      const baseHeight = bbox.page_height || 841
      const scaleY = vp.height / baseHeight
      const y = pageEl.offsetTop + bbox.top * scaleY - 40
      wrapper.scrollTo({ top: Math.max(0, y), behavior: 'smooth' })
      nextFocusState.didRefine = true
    } else {
      if (nextFocusState.didFallback) return
      pageEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
      nextFocusState.didFallback = true
    }
  }, [focusSegmentId, segments, pageRenderStatus, pageViewports, pdfUrl, scale])

  function goFirstPage() {
    goToPage(1)
  }

  function goLastPage() {
    goToPage(lastNavPage)
  }

  function goPrevPage() {
    const step = viewMode === 'twoUp' ? 2 : 1
    goToPage(activeNavPage - step)
  }

  function goNextPage() {
    const step = viewMode === 'twoUp' ? 2 : 1
    goToPage(activeNavPage + step)
  }

  function zoomIn() {
    setFitMode(null)
    setScale((prev) => clampScale(prev * 1.1))
  }

  function zoomOut() {
    setFitMode(null)
    setScale((prev) => clampScale(prev / 1.1))
  }

  function zoomReset() {
    setFitMode(null)
    setScale(1.0)
  }

  function handleKeyDown(e) {
    if (!isViewerFocused) return
    if (isEditableElement(e.target)) return
    if (isLoading || totalPages <= 0) return

    const isCtrlOnly = e.ctrlKey && !e.metaKey && !e.altKey

    if (isCtrlOnly) {
      if (e.key === '-' || e.code === 'Minus') {
        e.preventDefault()
        zoomOut()
        return
      }

      // Some keyboard layouts send '/' for Ctrl+plus.
      if (e.key === '+' || e.key === '=' || e.key === '/' || e.code === 'Equal' || e.code === 'Slash') {
        e.preventDefault()
        zoomIn()
        return
      }

      if (e.key === '0' || e.code === 'Digit0') {
        e.preventDefault()
        zoomReset()
        return
      }

      return
    }

    if (e.key === 'PageDown' || e.key === 'ArrowRight') {
      e.preventDefault()
      goNextPage()
    } else if (e.key === 'PageUp' || e.key === 'ArrowLeft') {
      e.preventDefault()
      goPrevPage()
    } else if (e.key === 'Home') {
      e.preventDefault()
      goFirstPage()
    } else if (e.key === 'End') {
      e.preventDefault()
      goLastPage()
    }
  }

  function getBboxStyle(pageNum, segment) {
    const bbox = segment?.bbox
    const vp = pageViewports[pageNum]
    if (!bbox || !vp) return null

    const baseWidth = bbox.page_width || 595
    const baseHeight = bbox.page_height || 841

    const scaleX = vp.width / baseWidth
    const scaleY = vp.height / baseHeight

    return {
      left: `${bbox.left * scaleX}px`,
      top: `${bbox.top * scaleY}px`,
      width: `${bbox.width * scaleX}px`,
      height: `${bbox.height * scaleY}px`,
    }
  }

  function handleSegmentClick(e, segId) {
    e.stopPropagation()
    const isMulti = e.ctrlKey || e.metaKey || e.shiftKey
    onSegmentClick?.(segId, isMulti)
  }

  function findSegmentsInRect(pageNum, left, top, width, height) {
    const vp = pageViewports[pageNum]
    if (!vp || width <= 0 || height <= 0) return []

    const right = left + width
    const bottom = top + height

    return (segments || [])
      .filter((segment) => segment?.page === pageNum && segment?.bbox)
      .filter((segment) => {
        const bbox = segment.bbox
        const baseWidth = bbox.page_width || 595
        const baseHeight = bbox.page_height || 841
        const scaleX = vp.width / baseWidth
        const scaleY = vp.height / baseHeight
        const segLeft = bbox.left * scaleX
        const segTop = bbox.top * scaleY
        const segRight = segLeft + bbox.width * scaleX
        const segBottom = segTop + bbox.height * scaleY
        return segLeft < right && segRight > left && segTop < bottom && segBottom > top
      })
  }

  function getRenderedPageElement(pageNum) {
    const pageEl = pageRefs.current[pageNum]
    if (!pageEl) return null
    const renderEl = pageEl.querySelector('.pdf-canvas')
    return renderEl instanceof HTMLCanvasElement || renderEl instanceof HTMLImageElement ? renderEl : null
  }

  async function cropRenderedPageRegionToBlob(pageNum, region) {
    const renderEl = getRenderedPageElement(pageNum)
    if (!renderEl || region.width <= 0 || region.height <= 0) return null

    const displayWidth = renderEl.clientWidth || renderEl.getBoundingClientRect().width || 0
    const displayHeight = renderEl.clientHeight || renderEl.getBoundingClientRect().height || 0
    if (displayWidth <= 0 || displayHeight <= 0) return null

    const sourceWidth = renderEl instanceof HTMLCanvasElement
      ? renderEl.width
      : (renderEl.naturalWidth || renderEl.width)
    const sourceHeight = renderEl instanceof HTMLCanvasElement
      ? renderEl.height
      : (renderEl.naturalHeight || renderEl.height)
    if (!sourceWidth || !sourceHeight) return null

    const scaleX = sourceWidth / displayWidth
    const scaleY = sourceHeight / displayHeight
    const sx = Math.max(0, Math.round(region.left * scaleX))
    const sy = Math.max(0, Math.round(region.top * scaleY))
    const sw = Math.max(1, Math.round(region.width * scaleX))
    const sh = Math.max(1, Math.round(region.height * scaleY))

    const cropCanvas = document.createElement('canvas')
    cropCanvas.width = sw
    cropCanvas.height = sh
    const ctx = cropCanvas.getContext('2d')
    if (!ctx) return null

    ctx.drawImage(renderEl, sx, sy, sw, sh, 0, 0, sw, sh)
    return canvasToBlob(cropCanvas)
  }

  function buildAttachmentReference(pageNum, matchedSegments) {
    if (!fileId) return null
    const segmentIds = matchedSegments.map((segment) => String(segment?.id || '').trim()).filter(Boolean)
    const focusSegment = matchedSegments[0] || null

    return {
      file_id: String(fileId),
      segment_ids: segmentIds,
      focus_segment_id: focusSegment?.id ? String(focusSegment.id) : null,
      page: pageNum,
      segment_type: focusSegment?.type ? String(focusSegment.type) : null,
    }
  }

  function handleJumpCommit() {
    const parsed = parseInt(pageInput, 10)
    if (!Number.isFinite(parsed)) {
      setPageInput(String(activeNavPage))
      return
    }
    goToPage(parsed)
  }

  // ========== Capture Mode Drag Handlers ==========
  function getPageNumFromPoint(clientX, clientY) {
    // Find which page element contains this point
    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const pageEl = pageRefs.current[pageNum]
      if (!pageEl) continue
      const rect = pageEl.getBoundingClientRect()
      if (clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom) {
        return pageNum
      }
    }
    return null
  }

  function handleCaptureMouseDown(e) {
    if (!captureMode) return
    if (e.button !== 0) return // left click only

    const pageNum = getPageNumFromPoint(e.clientX, e.clientY)
    if (!pageNum) return

    const pageEl = pageRefs.current[pageNum]
    if (!pageEl) return

    const pageRect = pageEl.getBoundingClientRect()
    const startX = e.clientX - pageRect.left
    const startY = e.clientY - pageRect.top

    setCaptureDrag({
      startX,
      startY,
      currentX: startX,
      currentY: startY,
      pageNum,
      pageRect,
    })

    e.preventDefault()
  }

  function handleCaptureMouseMove(e) {
    if (!captureDrag) return

    const pageEl = pageRefs.current[captureDrag.pageNum]
    if (!pageEl) return

    const pageRect = pageEl.getBoundingClientRect()
    const currentX = Math.max(0, Math.min(pageRect.width, e.clientX - pageRect.left))
    const currentY = Math.max(0, Math.min(pageRect.height, e.clientY - pageRect.top))

    setCaptureDrag((prev) => ({ ...prev, currentX, currentY }))
  }

  function handleCaptureMouseUp(e) {
    if (!captureDrag) return

    const { startX, startY, currentX, currentY, pageNum } = captureDrag
    const width = Math.abs(currentX - startX)
    const height = Math.abs(currentY - startY)

    // Minimum size threshold (10px)
    if (width < 10 || height < 10) {
      setCaptureDrag(null)
      return
    }

    // Capture the region
    captureRegion(pageNum, startX, startY, currentX, currentY)
    setCaptureDrag(null)
  }

  useEffect(() => {
    if (!captureMode || !captureDrag) return undefined

    const handleWindowMouseMove = (event) => {
      handleCaptureMouseMove(event)
    }

    const handleWindowMouseUp = (event) => {
      handleCaptureMouseUp(event)
    }

    window.addEventListener('mousemove', handleWindowMouseMove)
    window.addEventListener('mouseup', handleWindowMouseUp)

    return () => {
      window.removeEventListener('mousemove', handleWindowMouseMove)
      window.removeEventListener('mouseup', handleWindowMouseUp)
    }
  }, [captureMode, captureDrag])

  async function captureRegion(pageNum, x1, y1, x2, y2) {
    const rectLeft = Math.min(x1, x2)
    const rectTop = Math.min(y1, y2)
    const rectWidth = Math.abs(x2 - x1)
    const rectHeight = Math.abs(y2 - y1)

    // Save as temporary captured region using fractional coordinates (0..1)
    // so the overlay resizes correctly when zoom/layout changes
    const vp = pageViewports[pageNum]
    const vpW = vp?.width || 1
    const vpH = vp?.height || 1
    const newRegion = {
      id: `capture-${Date.now()}`,
      pageNum,
      // Store as fractions of page viewport at capture time
      leftFrac: rectLeft / vpW,
      topFrac: rectTop / vpH,
      widthFrac: rectWidth / vpW,
      heightFrac: rectHeight / vpH,
    }
    setCapturedRegions((prev) => [...prev, newRegion])

    // Capture mode should behave as pure image cropping, not segment multi-select.
    onSegmentBoxSelect?.([], false)

    setCaptureMode(false)

    try {
      const blob = await cropRenderedPageRegionToBlob(pageNum, {
        left: rectLeft,
        top: rectTop,
        width: rectWidth,
        height: rectHeight,
      })
      if (!blob) throw new Error('Captured region blob unavailable')

      const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' })
      await onCaptureImage?.(file, {
        reference: {
          file_id: String(fileId || ''),
          page: pageNum,
          segment_type: 'capture',
        },
      })
    } catch (err) {
      console.warn('Failed to attach captured region image to chat:', err)
      toast.error('캡처 이미지를 채팅에 첨부하지 못했습니다.')
    }
  }

  async function insertCapturedRegionIntoEditor(region) {
    const vp = pageViewports[region.pageNum]
    if (!vp) return

    const cssLeft = region.leftFrac * vp.width
    const cssTop = region.topFrac * vp.height
    const cssWidth = region.widthFrac * vp.width
    const cssHeight = region.heightFrac * vp.height

    const blobPromise = cropRenderedPageRegionToBlob(region.pageNum, {
      left: cssLeft,
      top: cssTop,
      width: cssWidth,
      height: cssHeight,
    })
    try {
      const blob = await blobPromise
      if (!blob) throw new Error('Captured region blob unavailable')
      const file = new File([blob], `capture-${Date.now()}.png`, { type: 'image/png' })
      await onInsertImageToEditor?.(file)
      toast.success('캡처 이미지를 편집기에 붙여넣었습니다.')
    } catch (err) {
      console.warn('Failed to insert captured region image:', err)
      toast.error('캡처 이미지를 편집기에 붙여넣지 못했습니다.')
    }
  }

  async function insertSegmentAsImage(segment, pageNum, style) {
    try {
      let blobPromise = null
      if (typeof viewerApi.fetchSegmentPreviewBlob === 'function' && fileDomain !== 'my_documents') {
        blobPromise = viewerApi.fetchSegmentPreviewBlob(String(fileId), String(segment.id))
      }

      const blob = await (
        blobPromise || cropRenderedPageRegionToBlob(pageNum, {
          left: parseFloat(style.left),
          top: parseFloat(style.top),
          width: parseFloat(style.width),
          height: parseFloat(style.height),
        })
      )
      if (!blob) throw new Error('Segment image blob unavailable')

      const file = new File([blob], `segment-${segment.id || Date.now()}.png`, { type: 'image/png' })
      await onInsertImageToEditor?.(file)

      toast.success('이미지 세그먼트를 편집기에 붙여넣었습니다.')
    } catch (err) {
      console.warn('Failed to insert segment image:', err)
      toast.error('이미지 세그먼트를 편집기에 붙여넣지 못했습니다.')
    }
  }

  // Remove a captured region
  function removeCapturedRegion(regionId) {
    setCapturedRegions((prev) => prev.filter((r) => r.id !== regionId))
  }

  // Clear all captured regions when PDF changes
  useEffect(() => {
    setCapturedRegions([])
  }, [pdfUrl])

  // Capture drag selection rectangle style
  const captureDragStyle = useMemo(() => {
    if (!captureDrag) return null
    const { startX, startY, currentX, currentY } = captureDrag
    return {
      left: Math.min(startX, currentX),
      top: Math.min(startY, currentY),
      width: Math.abs(currentX - startX),
      height: Math.abs(currentY - startY),
    }
  }, [captureDrag])

  // ========== Normal Mode Drag Selection Handlers ==========
  function handleSelectionMouseDown(e) {
    if (captureMode) return // Capture mode has its own handler
    if (e.button !== 0) return // Left click only

    const pageNum = getPageNumFromPoint(e.clientX, e.clientY)
    if (!pageNum) return

    const pageEl = pageRefs.current[pageNum]
    if (!pageEl) return

    const pageRect = pageEl.getBoundingClientRect()
    const startX = e.clientX - pageRect.left
    const startY = e.clientY - pageRect.top
    const isAdditive = e.ctrlKey || e.metaKey

    setSelectionDrag({
      startX,
      startY,
      currentX: startX,
      currentY: startY,
      pageNum,
      startClientX: e.clientX,
      startClientY: e.clientY,
      isAdditive,
      isDragging: false, // Will become true when threshold exceeded
    })

    // Don't prevent default - allow normal click behavior initially
  }

  function handleSelectionMouseMove(e) {
    if (!selectionDrag) return

    const pageEl = pageRefs.current[selectionDrag.pageNum]
    if (!pageEl) return

    const pageRect = pageEl.getBoundingClientRect()
    const currentX = Math.max(0, Math.min(pageRect.width, e.clientX - pageRect.left))
    const currentY = Math.max(0, Math.min(pageRect.height, e.clientY - pageRect.top))

    // Check if drag threshold exceeded
    const dx = Math.abs(e.clientX - selectionDrag.startClientX)
    const dy = Math.abs(e.clientY - selectionDrag.startClientY)
    const isDragging = selectionDrag.isDragging || dx > DRAG_THRESHOLD || dy > DRAG_THRESHOLD

    setSelectionDrag((prev) => ({ ...prev, currentX, currentY, isDragging }))
  }

  function handleSelectionMouseUp(e) {
    if (!selectionDrag) return

    const { startX, startY, currentX, currentY, pageNum, isDragging, isAdditive } = selectionDrag

    // If not actually dragging (click), let segment click handler manage it
    if (!isDragging) {
      setSelectionDrag(null)
      return
    }

    const width = Math.abs(currentX - startX)
    const height = Math.abs(currentY - startY)

    // Minimum size threshold
    if (width < 10 || height < 10) {
      setSelectionDrag(null)
      return
    }

    // Find segments in the selection box
    const rectLeft = Math.min(startX, currentX)
    const rectTop = Math.min(startY, currentY)
    const matchedSegments = findSegmentsInRect(pageNum, rectLeft, rectTop, width, height)
    const segIds = matchedSegments.map((s) => s.id)

    // Notify parent
    if (segIds.length > 0) {
      onSegmentBoxSelect?.(segIds, isAdditive)
    }

    setSelectionDrag(null)
  }

  // Selection drag rectangle style
  const selectionDragStyle = useMemo(() => {
    if (!selectionDrag || !selectionDrag.isDragging) return null
    const { startX, startY, currentX, currentY } = selectionDrag
    return {
      left: Math.min(startX, currentX),
      top: Math.min(startY, currentY),
      width: Math.abs(currentX - startX),
      height: Math.abs(currentY - startY),
    }
  }, [selectionDrag])

  function renderPage(pageNum) {
    const pageLayout = getPageLayout(pageNum)
    const pageReady = isPageGeometryReady(pageNum)

    return (
      <div
        key={pageNum}
        className={`pdf-page ${captureMode ? 'capture-mode' : ''}`}
        data-page={pageNum}
        data-render-status={pageRenderStatus[pageNum] || 'pending'}
        ref={(el) => {
          if (el) pageRefs.current[pageNum] = el
        }}
        style={{
          position: 'relative',
          width: pageLayout?.width ? `${pageLayout.width}px` : undefined,
          height: pageLayout?.height ? `${pageLayout.height}px` : undefined,
          flex: '0 0 auto',
        }}
      >
        {preferPageImages ? (
          pageImageUrls[pageNum] ? (
            <img
              className="pdf-canvas"
              src={pageImageUrls[pageNum]}
              alt={`Page ${pageNum}`}
              style={{ display: 'block', width: '100%', height: '100%' }}
            />
          ) : (
            <div className="pdf-canvas" style={{ width: '100%', height: '100%', background: 'white' }} />
          )
        ) : (
          <canvas
            className="pdf-canvas"
            ref={(el) => {
              if (el) canvasRefs.current[pageNum] = el
            }}
          />
        )}

        {/* Segment overlays - hide during capture mode */}
        {!captureMode && pageReady && segments
          ?.filter((s) => s.page === pageNum)
          .map((segment) => {
            const style = getBboxStyle(pageNum, segment)
            if (!style) return null

            const isSelected = selectedSegments?.includes(segment.id)
            const typeClass = segment.type
              ? `type-${segment.type.toLowerCase().replace(/[^a-z0-9]/g, '-')}`
              : 'type-unknown'

            return (
              <div
                key={segment.id}
                className={`segment-overlay ${isSelected ? 'selected' : ''} ${typeClass}`}
                style={style}
                onClick={(e) => handleSegmentClick(e, segment.id)}
                title={(() => { const t = getSegmentDisplayText(segment); return t.length > 200 ? t.substring(0, 200) + '...' : t; })()}
              >
                {isSelected && isCopyableSegment(segment) ? (
                  <button
                    type="button"
                    onClick={(e) => {
                        e.stopPropagation()
                        void insertSegmentAsImage(segment, pageNum, style)
                      }}
                    style={{
                      position: 'absolute',
                      bottom: -10,
                      right: -10,
                      width: 24,
                      height: 24,
                      borderRadius: '50%',
                      backgroundColor: '#1d4ed8',
                      color: 'white',
                      border: '2px solid white',
                      cursor: 'pointer',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      zIndex: 21,
                      boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                    }}
                    title="편집기에 붙여넣기"
                  >
                    <Copy style={{ width: 12, height: 12 }} />
                  </button>
                ) : null}
              </div>
            )
          })}
      </div>
    )
  }

  const pagesContent = useMemo(() => {
    if (totalPages <= 0) return null

    if (viewMode === 'twoUp') {
      const spreadCount = Math.ceil(totalPages / 2)
      return Array.from({ length: spreadCount }, (_, i) => {
        const leftPage = i * 2 + 1
        const rightPage = leftPage + 1
        const hasRight = rightPage <= totalPages
        const spreadLayout = getSpreadLayout(leftPage, hasRight ? rightPage : null)
        const placeholderLayout = getPageLayout(leftPage)

        return (
          <div
            key={leftPage}
            className="pdf-spread"
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'center',
              gap: `${SPREAD_GAP_PX}px`,
              width: spreadLayout?.width ? `${spreadLayout.width}px` : undefined,
              height: spreadLayout?.height ? `${spreadLayout.height}px` : undefined,
              marginBottom: `${VIEW_MARGIN_PX}px`,
            }}
          >
            {renderPage(leftPage)}
            {hasRight ? (
              renderPage(rightPage)
            ) : (
              <div
                aria-hidden
                style={{
                  width: placeholderLayout?.width ? `${placeholderLayout.width}px` : undefined,
                  height: placeholderLayout?.height ? `${placeholderLayout.height}px` : undefined,
                  flex: '0 0 auto',
                  visibility: 'hidden',
                }}
              />
            )}
          </div>
        )
      })
    }

    return Array.from({ length: totalPages }, (_, i) => i + 1).map((pageNum) => {
      const pageLayout = getPageLayout(pageNum)

      return (
        <div
          key={pageNum}
          style={{
            display: 'flex',
            justifyContent: 'center',
            alignItems: 'flex-start',
            width: pageLayout?.width ? `${pageLayout.width}px` : undefined,
            minHeight: pageLayout?.height ? `${pageLayout.height}px` : undefined,
            marginBottom: `${VIEW_MARGIN_PX}px`,
          }}
        >
          {renderPage(pageNum)}
        </div>
      )
    })
  }, [totalPages, viewMode, segments, selectedSegments, pageShells, pageViewports, pageRenderStatus, pageImageUrls, scale, captureMode, preferPageImages])

  const canGoPrev = activeNavPage > 1
  const canGoNext = activeNavPage < lastNavPage

  if (!pdfUrl) return <div className="pdf-viewer-empty">문서를 선택해주세요.</div>

  return (
    <div className="pdf-viewer-container" ref={containerRef}>
      <div className="pdf-toolbar" style={{ flexWrap: 'wrap', overflow: 'hidden' }}>
        <div className="pdf-toolbar-group">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={goFirstPage}
                disabled={!canGoPrev || isLoading}
                className={ICON_BUTTON_CLASS}
                aria-label="첫 페이지"
              >
                <ChevronsLeft className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>첫 페이지 (Home)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={goPrevPage}
                disabled={!canGoPrev || isLoading}
                className={ICON_BUTTON_CLASS}
                aria-label={viewMode === 'twoUp' ? '이전 쪽' : '이전 페이지'}
              >
                <ChevronLeft className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{viewMode === 'twoUp' ? '이전 쪽 (PageUp / ←)' : '이전 페이지 (PageUp / ←)'}</TooltipContent>
          </Tooltip>

          <div className="pdf-page-indicator" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault()
                  handleJumpCommit()
                }
              }}
              onBlur={handleJumpCommit}
              disabled={isLoading || totalPages <= 0}
              style={{
                width: 64,
                padding: '4px 6px',
                borderRadius: 6,
                border: '1px solid rgba(0,0,0,0.15)',
                background: 'transparent',
              }}
            />
            {viewMode === 'twoUp' && activeRightPage && !isLoading && (
              <span>{`– ${activeRightPage}`}</span>
            )}
            <span>{isLoading ? '/ ...' : `/ ${totalPages}`}</span>
          </div>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={goNextPage}
                disabled={!canGoNext || isLoading}
                className={ICON_BUTTON_CLASS}
                aria-label={viewMode === 'twoUp' ? '다음 쪽' : '다음 페이지'}
              >
                <ChevronRight className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{viewMode === 'twoUp' ? '다음 쪽 (PageDown / →)' : '다음 페이지 (PageDown / →)'}</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={goLastPage}
                disabled={!canGoNext || isLoading}
                className={ICON_BUTTON_CLASS}
                aria-label="마지막 페이지"
              >
                <ChevronsRight className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>마지막 페이지 (End)</TooltipContent>
          </Tooltip>
        </div>

        <div className="pdf-toolbar-group" style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  setFitMode('width')
                  applyFitScale('width')
                }}
                className={`${ICON_BUTTON_CLASS} ${fitMode === 'width' ? ICON_BUTTON_ACTIVE_CLASS : ''}`}
                disabled={isLoading || totalPages <= 0}
                aria-label="폭에 맞춤"
                aria-pressed={fitMode === 'width'}
              >
                <ArrowLeftRight className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>폭에 맞춤</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  setFitMode('height')
                  applyFitScale('height')
                }}
                className={`${ICON_BUTTON_CLASS} ${fitMode === 'height' ? ICON_BUTTON_ACTIVE_CLASS : ''}`}
                disabled={isLoading || totalPages <= 0}
                aria-label="높이에 맞춤"
                aria-pressed={fitMode === 'height'}
              >
                <ArrowUpDown className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>높이에 맞춤</TooltipContent>
          </Tooltip>

          <select
            value={zoomPercent}
            onChange={(e) => {
              setFitMode(null)
              const nextPercent = parseInt(e.target.value, 10)
              if (!Number.isFinite(nextPercent)) return
              setScale(clampScale(nextPercent / 100))
            }}
            className="pdf-select"
            disabled={isLoading}
            title="확대/축소"
          >
            {zoomOptions.map((opt) => (
              <option key={`${opt.value}-${opt.label}`} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>

          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => {
                  const next = viewMode === 'single' ? 'twoUp' : 'single'
                  setViewMode(next)

                  if (next === 'twoUp') {
                    // Enter spread mode: fit to width, and align to odd-left page
                    setFitMode('width')
                    const normalized = normalizeTwoUpStart(activePageRaw, totalPages)
                    scrollToPage(normalized)
                  } else {
                    // Return to single page: fit to height
                    setFitMode('height')
                  }
                }}
                className={`${ICON_BUTTON_CLASS} ${viewMode === 'twoUp' ? ICON_BUTTON_TOGGLE_ACTIVE_CLASS : ICON_BUTTON_TOGGLE_INACTIVE_CLASS}`}
                disabled={isLoading || totalPages <= 0}
                aria-label={viewMode === 'twoUp' ? '1쪽 보기' : '2쪽 보기'}
                aria-pressed={viewMode === 'twoUp'}
              >
                <Columns2 className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>{viewMode === 'twoUp' ? '1쪽 보기' : '2쪽 보기'}</TooltipContent>
          </Tooltip>
        </div>

          {/* Capture mode toggle - next to 2-up control */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setCaptureMode((prev) => !prev)}
                className={`${ICON_BUTTON_CLASS} ${captureMode ? ICON_BUTTON_TOGGLE_ACTIVE_CLASS : ''}`}
                disabled={isLoading || totalPages <= 0}
                aria-label={captureMode ? '캡처 모드 끄기' : '영역 선택/캡처'}
                aria-pressed={captureMode}
              >
                <Camera className="h-5 w-5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {captureMode 
                ? '캡처 모드 끄기 (ESC)' 
                : '영역 선택/캡처 (드래그로 영역 선택)'}
            </TooltipContent>
          </Tooltip>
      </div>

      <div
        className={`pdf-page-wrapper ${captureMode ? 'capture-mode-active' : ''}`}
        ref={wrapperRef}
        tabIndex={0}
        onKeyDown={(e) => {
          // ESC to exit capture mode or cancel selection
          if (e.key === 'Escape') {
            if (captureMode) {
              setCaptureMode(false)
              setCaptureDrag(null)
            }
            if (selectionDrag) {
              setSelectionDrag(null)
            }
            return
          }
          handleKeyDown(e)
        }}
        onMouseDown={(e) => {
          wrapperRef.current?.focus()
          if (captureMode) {
            handleCaptureMouseDown(e)
          } else {
            handleSelectionMouseDown(e)
          }
        }}
        onMouseMove={captureMode ? handleCaptureMouseMove : handleSelectionMouseMove}
        onMouseUp={captureMode ? handleCaptureMouseUp : handleSelectionMouseUp}
        onMouseLeave={() => {
          if (captureMode) return
          else setSelectionDrag(null)
        }}
        onFocus={() => setIsViewerFocused(true)}
        onBlur={() => setIsViewerFocused(false)}
        style={{ padding: `${VIEW_MARGIN_PX}px`, cursor: captureMode ? 'crosshair' : undefined, position: 'relative' }}
      >
        {isLoading && (
          <div className="pdf-loading-overlay">
            <div className="spinner"></div>
            Loading...
          </div>
        )}

        {error && <div className="pdf-error-overlay">{error}</div>}

        {pagesContent}

        {/* Drag selection box overlay */}
        <DragBoxOverlay
          drag={captureMode ? captureDrag : selectionDrag}
          dragStyle={captureMode ? captureDragStyle : selectionDragStyle}
          pageRefs={pageRefs}
          wrapperRef={wrapperRef}
          isCaptureMode={captureMode}
        />

        {/* Captured regions overlay - rendered outside useMemo for real-time updates */}
        {/* Uses fractional coordinates so overlays resize with zoom/layout changes */}
        {capturedRegions.map((region) => {
          const pageEl = pageRefs.current?.[region.pageNum]
          const wrapper = wrapperRef.current
          if (!pageEl || !wrapper) return null

          const pageRect = pageEl.getBoundingClientRect()
          const wrapperRect = wrapper.getBoundingClientRect()

          // Convert fractional coordinates to current page pixel size
          const regionLeft = region.leftFrac * pageRect.width
          const regionTop = region.topFrac * pageRect.height
          const regionWidth = region.widthFrac * pageRect.width
          const regionHeight = region.heightFrac * pageRect.height

          const left = pageRect.left - wrapperRect.left + wrapper.scrollLeft + regionLeft
          const top = pageRect.top - wrapperRect.top + wrapper.scrollTop + regionTop

          return (
            <div
              key={region.id}
              style={{
                position: 'absolute',
                left,
                top,
                width: regionWidth,
                height: regionHeight,
                border: '2px solid #B91C1C',
                backgroundColor: 'rgba(185, 28, 28, 0.18)',
                boxShadow: '0 0 0 0.2rem rgba(185, 28, 28, 0.35)',
                cursor: 'default',
                zIndex: 20,
                borderRadius: '4px',
                boxSizing: 'border-box',
              }}
              title="캡처된 이미지"
            >
              {/* Close button (top-right) */}
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  removeCapturedRegion(region.id)
                }}
                style={{
                  position: 'absolute',
                  top: -10,
                  right: -10,
                  width: 20,
                  height: 20,
                  borderRadius: '50%',
                  backgroundColor: '#ef4444',
                  color: 'white',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: 'bold',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 21,
                  lineHeight: 1,
                }}
                title="삭제"
              >
                ×
              </button>
              {/* Copy as image button (bottom-right) */}
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      void insertCapturedRegionIntoEditor(region)
                    }}
                style={{
                  position: 'absolute',
                  bottom: -10,
                  right: -10,
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  backgroundColor: '#1d4ed8',
                  color: 'white',
                  border: '2px solid white',
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 21,
                  boxShadow: '0 1px 3px rgba(0,0,0,0.3)',
                }}
                 title="편집기에 붙여넣기"
               >
                 <Copy style={{ width: 12, height: 12 }} />
               </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
