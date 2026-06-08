import { createRequire } from 'node:module'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { createReadStream, existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const require = createRequire(import.meta.url)
const rhwp = require('/app/rhwp/pkg-node/rhwp.js')

const PORT = Number(process.env.PORT || 7700)
const PUBLIC_ROOT = '/app/public'

globalThis.measureTextWidth = globalThis.measureTextWidth || (() => 0)

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  })
  res.end(body)
}

function getDocumentFormat(rawFilename, rawFormat) {
  const requestedFormat = String(rawFormat || '').trim().toLowerCase()
  if (requestedFormat === 'hwp' || requestedFormat === 'hwpx') return requestedFormat
  const filename = String(rawFilename || '').trim().toLowerCase()
  return filename.endsWith('.hwp') ? 'hwp' : 'hwpx'
}

function normalizeHwpFilename(rawFilename, format) {
  const suffix = format === 'hwp' ? '.hwp' : '.hwpx'
  const fallback = `새 한글 문서${suffix}`
  const value = String(rawFilename || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  const filename = value || fallback
  return filename.toLowerCase().endsWith(suffix) ? filename : `${filename.replace(/\.[^.]+$/, '')}${suffix}`
}

function createBlankDocumentBytes(format) {
  const doc = rhwp.HwpDocument.createEmpty()
  try {
    doc.createBlankDocument()
    return Buffer.from(format === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
  } finally {
    doc.free?.()
  }
}

function createDocumentFromTextBytes(format, text) {
  const doc = rhwp.HwpDocument.createEmpty()
  try {
    doc.createBlankDocument()
    const content = String(text || '').trim()
    if (content) {
      // 줄바꿈(\n)을 한 문단 안의 line-break가 아니라 실제 문단 분리로 처리한다.
      // (insertText만 쓰면 전체가 1개 문단 + lineBreak로 들어가 렌더가 깨진다)
      const lines = content.replace(/\r\n/g, '\n').split('\n')
      doc.insertText(0, 0, 0, lines[0])
      for (let i = 1; i < lines.length; i += 1) {
        doc.insertParagraph(0, i)
        if (lines[i]) doc.insertText(0, i, 0, lines[i])
      }
      // 기본 문단 정렬이 양쪽 정렬(justify)이라 본문이 늘어나 보이는 문제 → 왼쪽 정렬로 고정
      const paraCount = doc.getParagraphCount(0)
      for (let p = 0; p < paraCount; p += 1) {
        try {
          doc.applyParaFormat(0, p, JSON.stringify({ alignment: 'left' }))
        } catch {
          /* 정렬 적용 실패는 본문 생성을 막지 않는다 */
        }
      }
    }
    return Buffer.from(format === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
  } finally {
    doc.free?.()
  }
}

function parseRhwpResult(jsonString, contextLabel) {
  let parsed
  try {
    parsed = JSON.parse(jsonString)
  } catch {
    throw new Error(`${contextLabel}: invalid JSON returned (${jsonString})`)
  }
  if (!parsed || parsed.ok !== true) {
    throw new Error(`${contextLabel}: ${jsonString}`)
  }
  return parsed
}

function normalizeTablePayload(payload) {
  const headers = Array.isArray(payload?.headers)
    ? payload.headers.map((cell) => String(cell ?? ''))
    : null
  const bodyRows = Array.isArray(payload?.rows)
    ? payload.rows.map((row) =>
        Array.isArray(row) ? row.map((cell) => String(cell ?? '')) : []
      )
    : []

  const allRows = []
  if (headers && headers.length) allRows.push(headers)
  for (const row of bodyRows) allRows.push(row)

  if (!allRows.length) {
    throw new Error('headers or rows must be non-empty')
  }

  const colCount = Math.max(...allRows.map((r) => r.length), 1)
  const rowCount = allRows.length
  const padded = allRows.map((row) => {
    const out = row.slice(0, colCount)
    while (out.length < colCount) out.push('')
    return out
  })
  return { rowCount, colCount, padded }
}

function createDocumentFromTableBytes(format, payload) {
  const { rowCount, colCount, padded } = normalizeTablePayload(payload)
  const title = String(payload?.title || '').trim()

  const doc = rhwp.HwpDocument.createEmpty()
  try {
    doc.createBlankDocument()

    const tableSec = 0
    let tableParaIdx = 0
    let tableCharOffset = 0
    if (title) {
      doc.insertText(0, 0, 0, title)
      tableCharOffset = title.length
    }

    const created = parseRhwpResult(
      doc.createTable(tableSec, tableParaIdx, tableCharOffset, rowCount, colCount),
      'createTable',
    )
    const parentParaIdx = created.paraIdx
    const controlIdx = created.controlIdx ?? 0

    for (let r = 0; r < rowCount; r += 1) {
      for (let c = 0; c < colCount; c += 1) {
        const cellText = padded[r][c]
        if (!cellText) continue
        const cellIdx = r * colCount + c
        parseRhwpResult(
          doc.insertTextInCell(tableSec, parentParaIdx, controlIdx, cellIdx, 0, 0, cellText),
          `insertTextInCell(row=${r}, col=${c})`,
        )
      }
    }

    return Buffer.from(format === 'hwp' ? doc.exportHwp() : doc.exportHwpx())
  } finally {
    doc.free?.()
  }
}

async function handleBlankDocument(req, res) {
  let body = ''
  req.setEncoding('utf8')
  for await (const chunk of req) body += chunk

  let parsed = {}
  if (body.trim()) {
    try {
      parsed = JSON.parse(body)
    } catch {
      sendJson(res, 400, { error_code: 'RHWP_INVALID_JSON', message: 'Invalid JSON body' })
      return
    }
  }

  const format = getDocumentFormat(parsed.filename, parsed.format)
  const filename = normalizeHwpFilename(parsed.filename, format)
  const contentType = format === 'hwp' ? 'application/x-hwp' : 'application/vnd.hancom.hwpx'
  try {
    const bytes = createBlankDocumentBytes(format)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-DOREA-Document-Format': format,
    })
    res.end(bytes)
  } catch (error) {
    sendJson(res, 500, {
      error_code: 'RHWP_BLANK_GENERATION_FAILED',
      message: error?.message || 'Failed to create blank HWP/HWPX document',
    })
  }
}

async function handleDocumentFromTable(req, res) {
  let body = ''
  req.setEncoding('utf8')
  for await (const chunk of req) body += chunk

  let parsed = {}
  if (body.trim()) {
    try {
      parsed = JSON.parse(body)
    } catch {
      sendJson(res, 400, { error_code: 'RHWP_INVALID_JSON', message: 'Invalid JSON body' })
      return
    }
  }

  const hasHeaders = Array.isArray(parsed.headers) && parsed.headers.length > 0
  const hasRows = Array.isArray(parsed.rows) && parsed.rows.length > 0
  if (!hasHeaders && !hasRows) {
    sendJson(res, 400, {
      error_code: 'RHWP_EMPTY_TABLE',
      message: 'Either headers or rows must be provided',
    })
    return
  }

  const format = getDocumentFormat(parsed.filename, parsed.format)
  const filename = normalizeHwpFilename(parsed.filename, format)
  const contentType = format === 'hwp' ? 'application/x-hwp' : 'application/vnd.hancom.hwpx'
  try {
    const bytes = createDocumentFromTableBytes(format, parsed)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-DOREA-Document-Format': format,
    })
    res.end(bytes)
  } catch (error) {
    sendJson(res, 500, {
      error_code: 'RHWP_TABLE_GENERATION_FAILED',
      message: error?.message || 'Failed to create HWP/HWPX document from table',
    })
  }
}

async function handleDocumentFromText(req, res) {
  let body = ''
  req.setEncoding('utf8')
  for await (const chunk of req) body += chunk

  let parsed = {}
  if (body.trim()) {
    try {
      parsed = JSON.parse(body)
    } catch {
      sendJson(res, 400, { error_code: 'RHWP_INVALID_JSON', message: 'Invalid JSON body' })
      return
    }
  }

  const text = String(parsed.text || '').trim()
  if (!text) {
    sendJson(res, 400, { error_code: 'RHWP_EMPTY_TEXT', message: 'Document text is required' })
    return
  }

  const format = getDocumentFormat(parsed.filename, parsed.format)
  const filename = normalizeHwpFilename(parsed.filename, format)
  const contentType = format === 'hwp' ? 'application/x-hwp' : 'application/vnd.hancom.hwpx'
  try {
    const bytes = createDocumentFromTextBytes(format, text)
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
      'Content-Length': bytes.length,
      'Cache-Control': 'no-store',
      'X-DOREA-Document-Format': format,
    })
    res.end(bytes)
  } catch (error) {
    sendJson(res, 500, {
      error_code: 'RHWP_TEXT_GENERATION_FAILED',
      message: error?.message || 'Failed to create HWP/HWPX document from text',
    })
  }
}

function resolveStaticPath(urlPath) {
  const safePath = normalize(decodeURIComponent(urlPath)).replace(/^\.\.(?:\/|$)/, '')
  let filePath = join(PUBLIC_ROOT, safePath)
  if (urlPath === '/' || urlPath === '/rhwp') filePath = join(PUBLIC_ROOT, 'rhwp/index.html')
  if (urlPath.endsWith('/')) filePath = join(PUBLIC_ROOT, safePath, 'index.html')
  if (!existsSync(filePath) && urlPath.startsWith('/rhwp/')) filePath = join(PUBLIC_ROOT, 'rhwp/index.html')
  return filePath
}

function serveStatic(req, res) {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
  if (requestUrl.pathname === '/') {
    res.writeHead(302, { Location: '/rhwp/' })
    res.end()
    return
  }

  const filePath = resolveStaticPath(requestUrl.pathname)
  if (!filePath.startsWith(PUBLIC_ROOT) || !existsSync(filePath)) {
    res.writeHead(404)
    res.end('Not found')
    return
  }

  const contentType = CONTENT_TYPES[extname(filePath)] || 'application/octet-stream'
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': contentType.startsWith('text/html') ? 'no-cache' : 'public, max-age=31536000, immutable',
  })
  createReadStream(filePath).pipe(res)
}

createServer(async (req, res) => {
  try {
    const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    if (req.method === 'GET' && requestUrl.pathname === '/health') {
      sendJson(res, 200, { ok: true })
      return
    }
    if (req.method === 'POST' && (requestUrl.pathname === '/api/blank-document' || requestUrl.pathname === '/api/blank-hwpx')) {
      await handleBlankDocument(req, res)
      return
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/document-from-text') {
      await handleDocumentFromText(req, res)
      return
    }
    if (req.method === 'POST' && requestUrl.pathname === '/api/document-from-table') {
      await handleDocumentFromTable(req, res)
      return
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res)
      return
    }
    res.writeHead(405)
    res.end('Method not allowed')
  } catch (error) {
    sendJson(res, 500, { error_code: 'RHWP_SERVICE_ERROR', message: error?.message || 'Unexpected error' })
  }
}).listen(PORT, '0.0.0.0', () => {
  console.log(`[rhwp-service] listening on ${PORT}`)
})
