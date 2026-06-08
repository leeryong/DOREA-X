import React, { useEffect, useRef, useState, useCallback, useMemo, lazy, Suspense } from 'react'
import { useNavigate } from 'react-router-dom'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkBreaks from 'remark-breaks'
import { normalizeMarkdown } from '@/lib/normalizeMarkdown'
import SettingsModal from '../components/SettingsModal'
// MyInfoModal removed — now integrated into SettingsModal > 내정보
import NotificationCenter from '../components/NotificationCenter'
import DarkModeToggle from '../components/DarkModeToggle'
import ConfirmDialog from '../components/ConfirmDialog'
import { useNotifications } from '../services/notification-center'
import api, { chatsAPI, filesAPI, myDocumentsAPI, quickActionsAPI, mcpAPI, settingsPublicAPI, userPersonaAPI, adminAiSettingsAPI, rhwpAPI } from '../services/api'
import { PERSONA_SECTIONS, parseMarkdownToSections } from '@/lib/persona/personaConfig'
import PdfViewer from '../components/PdfViewer'
const ToastEditor = lazy(() => import('../components/Editor/ToastEditor'))
const RhwpEditor = lazy(() => import('../components/Editor/RhwpEditor'))
import { handleProposalApply, checkRevisionConflict } from '../components/Editor/proposalEngine'
import { getDocumentEditorKind, getEditorCapabilities, isMarkdownDocument, isRhwpDocument } from '@/lib/editorModes'
import { getFileIconUrl } from '@/lib/utils'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { Popover, PopoverTrigger, PopoverContent } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { Switch } from "@/components/ui/switch"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
  DropdownMenuSeparator,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from "@/components/ui/dropdown-menu"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  IconContext,
  ArrowClockwiseIcon,
  ArrowCircleDownIcon,
  ArrowCircleUpIcon,
  ArrowCounterClockwiseIcon,
  ArrowLeftIcon,
  ArrowRightIcon,
  ArrowUpIcon,
  BrainIcon,
  CaretDownIcon,
  ChatCircleTextIcon,
  CheckCircleIcon,
  CheckIcon,
  CircleNotchIcon,
  CopyIcon,
  CpuIcon,
  DatabaseIcon,
  DotsThreeIcon,
  EraserIcon,
  FileTextIcon,
  FinnTheHumanIcon,
  FloppyDiskIcon,
  GearIcon,
  GlobeIcon,
  GridFourIcon,
  HouseLineIcon,
  ImageIcon,
  LightningIcon,
  MagnifyingGlassIcon,
  NotePencilIcon,
  PencilLineIcon,
  PencilSimpleIcon,
  PlusIcon,
  PlusCircleIcon,
  SignOutIcon,
  TrashIcon,
  UploadSimpleIcon,
  WarningIcon,
  XIcon,
  WarningIcon as AlertTriangle,
  CheckIcon as Check,
  MagnifyingGlassIcon as Search,
  DotsThreeIcon as DotsThreeHorizontalIcon,
  TrashIcon as Trash2,
  PlusCircleIcon as MessageSquarePlus,
  GlobeIcon as Globe,
  CpuIcon as Cpu,
  LightningIcon as Zap,
  BrainIcon as Brain,
  CaretDownIcon as ChevronDown,
} from '@phosphor-icons/react'
import { toast } from '../services/toast'
import { clearProcessingHistorySession, getOrCreateProcessingHistorySessionStart } from '../services/processingHistorySession'

// ========== Panel Visibility Defaults ==========
// Panels: 1=left(문서목록/대화), 2=center(뷰어/웹), 3=editor(편집기), 4=chat(채팅)
// Default: 1,2,4 visible with ratio 1:2:2
const DEFAULT_PANEL_VISIBILITY = { left: true, center: true, editor: false, chat: true }
const DEFAULT_FILE_LIST_SORT = Object.freeze({ field: 'registeredAt', direction: 'desc' })

function getDefaultSortDirection(field) {
  // 이름·유형은 오름차순 기본, 크기·등록일은 내림차순 기본 (Explorer 관습)
  if (field === 'filename' || field === 'type') return 'asc'
  return 'desc'
}

function getFileExtension(filename) {
  const name = String(filename || '')
  const dot = name.lastIndexOf('.')
  if (dot < 0) return ''
  return name.slice(dot + 1).toLowerCase()
}

function getFileSizeBytes(file) {
  const raw = file?.size ?? file?.file_size ?? file?.bytes ?? 0
  const n = Number(raw)
  return Number.isFinite(n) ? n : 0
}

function getNextFileListSort(currentSort, field) {
  if (currentSort?.field === field) {
    return {
      field,
      direction: currentSort.direction === 'asc' ? 'desc' : 'asc',
    }
  }

  return {
    field,
    direction: getDefaultSortDirection(field),
  }
}

function getRegisteredAtTime(file) {
  const raw = file?.uploaded_at || file?.created_at || file?.updated_at || ''
  const time = new Date(raw).getTime()
  return Number.isFinite(time) ? time : 0
}

function compareFileNames(a, b) {
  return String(a?.filename || '').localeCompare(String(b?.filename || ''), 'ko', {
    sensitivity: 'base',
    numeric: true,
  })
}

function sortFileList(items, sortState) {
  const { field, direction } = sortState || DEFAULT_FILE_LIST_SORT
  const directionFactor = direction === 'asc' ? 1 : -1

  return [...items].sort((a, b) => {
    if (field === 'filename') {
      const byName = compareFileNames(a, b)
      if (byName !== 0) return byName * directionFactor
      return (getRegisteredAtTime(b) - getRegisteredAtTime(a)) || compareFileNames(a, b)
    }

    if (field === 'type') {
      const extA = getFileExtension(a?.filename)
      const extB = getFileExtension(b?.filename)
      if (extA !== extB) return (extA < extB ? -1 : 1) * directionFactor
      // 동일 유형 내에서는 이름 오름차순 (정렬 방향 무관)
      return compareFileNames(a, b)
    }

    if (field === 'size') {
      const diff = getFileSizeBytes(a) - getFileSizeBytes(b)
      if (diff !== 0) return diff * directionFactor
      return compareFileNames(a, b)
    }

    const byRegisteredAt = getRegisteredAtTime(a) - getRegisteredAtTime(b)
    if (byRegisteredAt !== 0) return byRegisteredAt * directionFactor
    return compareFileNames(a, b)
  })
}

function FileListSortControls({ sortState, onToggle }) {
  const options = [
    { field: 'filename', label: '파일명순' },
    { field: 'registeredAt', label: '등록순' },
  ]

  return (
    <div className="flex flex-wrap items-center gap-1 px-2 pb-1">
      {options.map((option) => {
        const isActive = sortState.field === option.field
        const direction = isActive ? sortState.direction : getDefaultSortDirection(option.field)
        const directionLabel = direction === 'asc' ? '오름차순' : '내림차순'

        return (
          <Button
            key={option.field}
            type="button"
            variant={isActive ? 'secondary' : 'outline'}
            size="sm"
            className={isActive ? 'h-7 gap-1.5 px-2 text-xs' : 'h-7 gap-1.5 px-2 text-xs bg-muted/70 hover:bg-muted'}
            title={`${option.label} ${directionLabel}`}
            onClick={() => onToggle(option.field)}
          >
            <span>{option.label}</span>
            <ArrowUpIcon
              weight="thin"
              className={`size-3.5 transition-transform ${direction === 'desc' ? 'rotate-180' : ''}`}
            />
          </Button>
        )
      })}
    </div>
  )
}

function WorkspaceDocIcon({ size = 28, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M18 10H36L48 22V50C48 53.3137 45.3137 56 42 56H18C14.6863 56 12 53.3137 12 50V16C12 12.6863 14.6863 10 18 10Z" fill="#90CAF9" />
      <path d="M36 10V18C36 21.3137 38.6863 24 42 24H48" fill="#E3F2FD" />
      <path d="M22 28H40" stroke="#1E88E5" strokeWidth="4" strokeLinecap="round" />
      <path d="M22 36H40" stroke="#42A5F5" strokeWidth="4" strokeLinecap="round" />
      <path d="M22 44H34" stroke="#64B5F6" strokeWidth="4" strokeLinecap="round" />
      <rect x="14" y="14" width="34" height="42" rx="6" stroke="#546E7A" strokeWidth="2.5" />
    </svg>
  )
}

function ViewerEyeIcon({ size = 28, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <path d="M8 32C12.5 22 21 16 32 16C43 16 51.5 22 56 32C51.5 42 43 48 32 48C21 48 12.5 42 8 32Z" fill="#B2EBF2" />
      <path d="M8 32C12.5 22 21 16 32 16C43 16 51.5 22 56 32C51.5 42 43 48 32 48C21 48 12.5 42 8 32Z" stroke="#00838F" strokeWidth="3" />
      <circle cx="32" cy="32" r="11" fill="#4DD0E1" />
      <circle cx="32" cy="32" r="6" fill="#006064" />
      <circle cx="35.5" cy="28.5" r="2.5" fill="#E0F7FA" />
    </svg>
  )
}

function EditorPenIcon({ size = 28, className = '' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" className={className} aria-hidden="true">
      <rect x="10" y="12" width="32" height="40" rx="8" fill="#FFE082" />
      <rect x="10" y="12" width="32" height="40" rx="8" stroke="#8D6E63" strokeWidth="2.5" />
      <path d="M18 24H34" stroke="#FFB300" strokeWidth="4" strokeLinecap="round" />
      <path d="M18 32H30" stroke="#FFCA28" strokeWidth="4" strokeLinecap="round" />
      <path d="M18 40H28" stroke="#FFD54F" strokeWidth="4" strokeLinecap="round" />
      <path d="M39 39L49.5 28.5L55.5 34.5L45 45L37 47L39 39Z" fill="#F06292" />
      <path d="M49.5 28.5L52 26C53.6569 24.3431 56.3431 24.3431 58 26C59.6569 27.6569 59.6569 30.3431 58 32L55.5 34.5" stroke="#6D4C41" strokeWidth="2.5" strokeLinecap="round" />
      <path d="M39 39L55.5 22.5" stroke="#6D4C41" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  )
}

function AgentRobotIcon({ size = 28, className = '' }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <rect x="14" y="18" width="36" height="28" rx="10" fill="#4FC3F7" />
      <rect x="18" y="22" width="28" height="20" rx="8" fill="#E1F5FE" />
      <path d="M32 10V18" stroke="#546E7A" strokeWidth="4" strokeLinecap="round" />
      <circle cx="32" cy="8" r="4" fill="#FFB300" />
      <path d="M10 30H14" stroke="#546E7A" strokeWidth="4" strokeLinecap="round" />
      <path d="M50 30H54" stroke="#546E7A" strokeWidth="4" strokeLinecap="round" />
      <path d="M22 46V54" stroke="#546E7A" strokeWidth="4" strokeLinecap="round" />
      <path d="M42 46V54" stroke="#546E7A" strokeWidth="4" strokeLinecap="round" />
      <circle cx="26" cy="31" r="4" fill="#7E57C2" />
      <circle cx="38" cy="31" r="4" fill="#7E57C2" />
      <path d="M24 39C26.5 41 29 42 32 42C35 42 37.5 41 40 39" stroke="#00ACC1" strokeWidth="3" strokeLinecap="round" />
      <rect x="27" y="14" width="10" height="4" rx="2" fill="#26A69A" />
    </svg>
  )
}

const MAX_PENDING_IMAGES = 5
const PROCESSING_FILE_STATUSES = new Set(['uploading', 'queued', 'converting', 'analyzing'])
const DEFAULT_UPLOAD_POLICY = {
  max_queued_files_per_user: 100,
  max_upload_size_bytes: 100 * 1024 * 1024,
  allowed_extensions: ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.hwp', '.hwpx', '.txt', '.csv', '.md'],
}

const PANEL_TOGGLE_ITEMS = [
  { id: 'left', icon: HouseLineIcon, label: '워크스페이스', iconProps: { weight: 'duotone' } },
  { id: 'center', icon: FileTextIcon, label: '뷰어', iconProps: { weight: 'regular' } },
  { id: 'editor', icon: NotePencilIcon, label: '편집기', iconProps: { weight: 'regular' } },
  { id: 'chat', icon: FinnTheHumanIcon, label: '에이전트', iconProps: { weight: 'duotone' } },
]

function PanelHeaderLabel({ icon: Icon, label, iconProps = {} }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase">
      <Icon size={14} {...iconProps} />
      <span>{label}</span>
    </span>
  )
}
// ========== Editor Intent Detection (keyword-based, NOT panel-based) ==========
// 편집기 패널이 열려 있어도 일반 채팅은 일반 응답으로 처리한다.
// 사용자가 메시지에서 편집기를 명시적으로 언급했을 때만 editor_command를 전송한다.
// DOREA-XP RHWP minimal: 채팅에서 "한글편집기에 ... 넣어줘" 패턴을 감지해
// RhwpEditor.insertText로 라우팅한다. 동사가 함께 있을 때만 매칭한다 ("한글편집기"
// 같은 단순 언급은 일반 채팅으로 흘려보낸다).
const RHWP_TARGET_KEYWORDS = ['한글편집기에', '한글 편집기에', '한글에디터에', '한글 에디터에', '한글에', 'hwp에', 'hwpx에']
const RHWP_VERB_KEYWORDS = ['넣어줘', '넣어주세요', '넣어', '추가해', '추가해줘', '입력해', '입력해줘', '써줘', '써넣어']
function hasRhwpInsertIntent(text) {
  if (!text) return false
  const lower = String(text).toLowerCase()
  if (!RHWP_TARGET_KEYWORDS.some(kw => lower.includes(kw.toLowerCase()))) return false
  return RHWP_VERB_KEYWORDS.some(kw => lower.includes(kw))
}
// 메시지에서 RHWP에 삽입할 본문을 뽑아낸다. 우선순위:
//   1) 큰따옴표("..."), 작은따옴표('...'), 한국어 인용부호("..."/「...」/『...』) 안 내용
//   2) 끝의 동사를 제거하고 타깃 키워드 뒷부분 전체
function extractRhwpInsertText(message) {
  if (!message) return ''
  const m = String(message)
  const quote = m.match(/"([^"]+)"|'([^']+)'|"([^"]+)"|「([^」]+)」|『([^』]+)』/)
  if (quote) return (quote[1] || quote[2] || quote[3] || quote[4] || quote[5] || '').trim()
  let s = m
  for (const kw of RHWP_TARGET_KEYWORDS) {
    const idx = s.toLowerCase().indexOf(kw.toLowerCase())
    if (idx >= 0) { s = s.slice(idx + kw.length); break }
  }
  for (const v of RHWP_VERB_KEYWORDS) {
    const idx = s.lastIndexOf(v)
    if (idx >= 0) { s = s.slice(0, idx); break }
  }
  return s.replace(/^[\s,:、]+|[\s,。.]+$/g, '').trim()
}

const EDITOR_INTENT_KEYWORDS = [
  '에디터에', '편집기에', '편집창에',
  '에디터로', '편집기로', '편집창으로',
]
function hasEditorIntent(text) {
  if (!text) return false
  const lower = text.toLowerCase()
  return EDITOR_INTENT_KEYWORDS.some(kw => lower.includes(kw))
}

const UPLOAD_ALLOWED_MIMES_BY_EXT = {
  '.pdf': new Set(['application/pdf']),
  '.doc': new Set(['application/msword']),
  '.docx': new Set(['application/vnd.openxmlformats-officedocument.wordprocessingml.document']),
  '.xls': new Set(['application/vnd.ms-excel']),
  '.xlsx': new Set(['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet']),
  '.ppt': new Set(['application/vnd.ms-powerpoint']),
  '.pptx': new Set(['application/vnd.openxmlformats-officedocument.presentationml.presentation']),
  '.hwp': new Set(['application/x-hwp', 'application/haansofthwp', 'application/octet-stream']),
  '.hwpx': new Set(['application/x-hwpx', 'application/haansofthwpx', 'application/octet-stream', 'application/zip']),
  '.txt': new Set(['text/plain']),
  '.csv': new Set(['text/csv', 'application/csv']),
  '.md': new Set(['text/markdown', 'text/plain', 'application/octet-stream']),
}

function getSegmentDisplayText(seg) {
  if (!seg) return ''
  const enriched = (seg.enriched_text || '').trim()
  if (enriched) return enriched
  const rag = (seg.rag_text || '').trim()
  if (rag) return rag
  return (seg.text || '').trim()
}

function getSegmentType(seg) {
  return String(seg?.type || seg?.segment_type || '').trim()
}

const NON_TEXT_SEGMENT_TYPE_KEYWORDS = ['figure', 'picture', 'image', 'table', 'formula', 'equation']
const PROPOSAL_IMAGE_PLACEHOLDER_RE = /!\[([^\]]*)\]\(([^)]+)\)/g

function isNonTextSegment(seg) {
  const type = getSegmentType(seg).toLowerCase()
  if (NON_TEXT_SEGMENT_TYPE_KEYWORDS.some((keyword) => type.includes(keyword))) return true
  const displayText = getSegmentDisplayText(seg)
  return !displayText
}

function isProposalImagePlaceholderTarget(target) {
  const normalized = String(target || '').trim()
  return /^p\.\d+\s*이미지$/i.test(normalized) || /^이미지$/i.test(normalized)
}

function getImageExtensionFromMime(mimeType) {
  switch (String(mimeType || '').toLowerCase()) {
    case 'image/jpeg':
    case 'image/jpg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return '.png'
  }
}

function getNonTextSegmentTileLabel(seg) {
  const type = getSegmentType(seg).toLowerCase()
  if (type.includes('table')) return 'TBL'
  if (type.includes('formula') || type.includes('equation')) return 'FX'
  if (type.includes('figure') || type.includes('picture') || type.includes('image')) return 'IMG'
  const rawType = getSegmentType(seg)
  return rawType ? rawType.slice(0, 3).toUpperCase() : 'SEG'
}

function truncateSegmentPreviewText(text, maxChars = 20) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return '(텍스트 없음)'
  const chars = Array.from(normalized)
  if (chars.length <= maxChars) return normalized
  return `${chars.slice(0, maxChars).join('')}...`
}

function getSegmentPreviewCacheKey(seg) {
  const fileId = String(seg?.file_id || '').trim()
  const segmentId = String(seg?.id || seg?.seg_id || '').trim()
  if (!fileId || !segmentId) return null
  return `${fileId}:${segmentId}`
}
const _EVIDENCE_LINE_RE = /^\s*(?:[-*]\s*)?(?:\*\*\s*)?(?:근거|출처|근거\/출처|evidence|source|citation)\s*[:：]/i

function stripEvidenceFooter(text) {
  if (!text) return text
  const lines = text.split('\n')
  let tail = lines.length - 1
  while (tail >= 0 && !lines[tail].trim()) tail--
  if (tail < 0) return text
  if (!_EVIDENCE_LINE_RE.test(lines[tail])) return text
  let start = tail
  while (start - 1 >= 0) {
    const prev = lines[start - 1]
    if (!prev.trim() || _EVIDENCE_LINE_RE.test(prev)) { start--; continue }
    break
  }
  const trimmed = lines.slice(0, start)
  while (trimmed.length > 0 && !trimmed[trimmed.length - 1].trim()) trimmed.pop()
  return trimmed.join('\n')
}

function getMessageRagSources(message) {
  if (Array.isArray(message?._ragSources) && message._ragSources.length > 0) {
    return message._ragSources
  }
  return Array.isArray(message?.model_metadata?.rag_sources) ? message.model_metadata.rag_sources : []
}

function normalizeAttachmentReference(reference) {
  if (!reference || typeof reference !== 'object') return null
  const fileId = String(reference.file_id || '').trim()
  if (!fileId) return null

  const segmentIds = Array.isArray(reference.segment_ids)
    ? reference.segment_ids.map((id) => String(id || '').trim()).filter(Boolean)
    : []

  const focusSegmentId = String(reference.focus_segment_id || '').trim() || null
  const pageNumber = Number(reference.page)
  const segmentType = String(reference.segment_type || '').trim() || null

  return {
    file_id: fileId,
    segment_ids: segmentIds,
    focus_segment_id: focusSegmentId,
    page: Number.isFinite(pageNumber) && pageNumber > 0 ? pageNumber : null,
    segment_type: segmentType,
  }
}

function getAttachmentMetadata(message, attachmentId) {
  if (!attachmentId) return null

  const persistedAttachment = Array.isArray(message?.attachments)
    ? message.attachments.find((attachment) => attachment?.attachment_id === attachmentId)
    : null
  if (persistedAttachment) return persistedAttachment

  return Array.isArray(message?._localAttachments)
    ? message._localAttachments.find((attachment) => attachment?.attachmentId === attachmentId) || null
    : null
}

const DRAFT_KEY_PREFIX = 'dorea-x.chat.draft.'
const DRAFT_TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 days

/**
 * Draft persistence helpers — localStorage with per-user, per-chat scoping
 * Draft shape: { text, attachments: [{attachmentId, filename, size}], updatedAt }
 */
function getDraftKey(userId, chatId) {
  return `${DRAFT_KEY_PREFIX}${userId}_${chatId}`
}

function saveDraft(userId, chatId, text, pendingImages) {
  if (!userId || !chatId) return
  const attachments = pendingImages
    .filter((img) => img.status === 'uploaded' && img.attachmentId)
    .map((img) => ({ attachmentId: img.attachmentId, filename: img.file?.name || 'image', size: img.file?.size || 0 }))
  // Only save if there's something to save
  if (!text?.trim() && attachments.length === 0) {
    try { localStorage.removeItem(getDraftKey(userId, chatId)) } catch {}
    return
  }
  const draft = { text: text || '', attachments, updatedAt: Date.now() }
  try { localStorage.setItem(getDraftKey(userId, chatId), JSON.stringify(draft)) } catch {}
}

function loadDraft(userId, chatId) {
  if (!userId || !chatId) return null
  try {
    const raw = localStorage.getItem(getDraftKey(userId, chatId))
    if (!raw) return null
    const draft = JSON.parse(raw)
    // TTL check
    if (Date.now() - draft.updatedAt > DRAFT_TTL_MS) {
      localStorage.removeItem(getDraftKey(userId, chatId))
      return null
    }
    return draft
  } catch {
    return null
  }
}

function clearDraft(userId, chatId) {
  if (!userId || !chatId) return
  try { localStorage.removeItem(getDraftKey(userId, chatId)) } catch {}
}

/** Prune all draft keys older than TTL or belonging to deleted chats */
function pruneExpiredDrafts(userId, validChatIds) {
  try {
    const now = Date.now()
    const keysToRemove = []
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i)
      if (!key || !key.startsWith(DRAFT_KEY_PREFIX)) continue
      // Only prune keys for this user (or orphaned keys with no user match)
      const suffix = key.slice(DRAFT_KEY_PREFIX.length) // "userId_chatId"
      const parts = suffix.split('_')
      if (parts.length < 2) { keysToRemove.push(key); continue }
      const keyUserId = parts[0]
      const keyChatId = parts.slice(1).join('_')
      // Skip other users' drafts
      if (userId && keyUserId !== String(userId)) continue
      try {
        const raw = localStorage.getItem(key)
        if (!raw) { keysToRemove.push(key); continue }
        const draft = JSON.parse(raw)
        // TTL expired
        if (now - draft.updatedAt > DRAFT_TTL_MS) { keysToRemove.push(key); continue }
        // Chat no longer exists (if validChatIds provided)
        if (validChatIds && !validChatIds.has(Number(keyChatId)) && !validChatIds.has(keyChatId)) {
          keysToRemove.push(key)
        }
      } catch { keysToRemove.push(key) }
    }
    keysToRemove.forEach((k) => localStorage.removeItem(k))
  } catch {}
}


/**
 * AttachmentImage component - renders attachment image using blob URL
 * Handles loading state, error state, and lightbox click
 */
function AttachmentImage({ sessionId, attachmentId, localPreviewUrl, getAttachmentBlobUrl, attachmentLoadingState, onActivate }) {
  const [blobUrl, setBlobUrl] = useState(localPreviewUrl || null)
  const cacheKey = `${sessionId}:${attachmentId}`
  const loadingState = attachmentLoadingState[cacheKey]
  
  useEffect(() => {
    // If we have a local preview (optimistic), use it
    if (localPreviewUrl) {
      setBlobUrl(localPreviewUrl)
      return
    }
    
    // Otherwise, fetch the blob
    let cancelled = false
    ;(async () => {
      const url = await getAttachmentBlobUrl(sessionId, attachmentId)
      if (!cancelled && url) {
        setBlobUrl(url)
      }
    })()
    
    return () => { cancelled = true }
  }, [sessionId, attachmentId, localPreviewUrl, getAttachmentBlobUrl])
  
  if (loadingState === 'loading' && !blobUrl) {
    return (
      <div className="w-[200px] h-[150px] rounded-md border bg-muted flex items-center justify-center">
        <CircleNotchIcon weight="thin" className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }
  
  if (loadingState === 'error' && !blobUrl) {
    return (
      <div className="w-[200px] h-[150px] rounded-md border bg-muted flex items-center justify-center">
        <div className="text-xs text-muted-foreground text-center px-2">
          <AlertTriangle className="h-5 w-5 mx-auto mb-1 text-destructive" />
          이미지 로드 실패
        </div>
      </div>
    )
  }
  
  if (!blobUrl) {
    return (
      <div className="w-[200px] h-[150px] rounded-md border bg-muted flex items-center justify-center">
        <CircleNotchIcon weight="thin" className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  return (
    <img
      src={blobUrl}
      alt="첨부 이미지"
      className="max-w-[200px] max-h-[150px] rounded-md border object-cover cursor-pointer hover:opacity-90 transition-opacity"
      onClick={() => onActivate(blobUrl)}
    />
  )
}

export default function MainShell() {
  const navigate = useNavigate()
  const { clearAll: clearNotifications } = useNotifications()
  const fileInputRef = useRef(null)
  const myDocFileInputRef = useRef(null)
  const imageInputRef = useRef(null)
  const chatTextareaRef = useRef(null)
  const sessionCreationPromises = useRef(new Map()).current
  const [isCreatingSession, setIsCreatingSession] = useState(false)
  const skipNextMessageLoadRef = useRef(false)
  const [viewerPage, setViewerPage] = useState({ page: 1, totalPages: 0 })
  const messagesContainerRef = useRef(null)
  const messagesEndRef = useRef(null)
  const prevGeneratingRef = useRef(false)
  // Per-editor instance refs. Both editors stay mounted once activated, so
  // these accumulate handles independently. `editorRef` is a stable proxy whose
  // `.current` getter returns whichever instance matches the active kind, so
  // every existing `editorRef.current?.foo()` call site keeps working.
  const markdownEditorInstanceRef = useRef(null)
  const rhwpEditorInstanceRef = useRef(null)
  const activeEditorKindRef = useRef('markdown')
  const editorRef = useMemo(() => {
    const proxy = {}
    Object.defineProperty(proxy, 'current', {
      configurable: true,
      enumerable: true,
      get() {
        return activeEditorKindRef.current === 'rhwp'
          ? rhwpEditorInstanceRef.current
          : markdownEditorInstanceRef.current
      },
      set() {
        // No-op: child editors set their own instance refs via callback refs.
      },
    })
    return proxy
  }, [])
  const setMarkdownEditorInstance = useCallback((instance) => {
    markdownEditorInstanceRef.current = instance
  }, [])
  const setRhwpEditorInstance = useCallback((instance) => {
    rhwpEditorInstanceRef.current = instance
  }, [])
  const editorProvisionPromiseRef = useRef(null)
  const editorProvisionVersionRef = useRef(0)
  const requestedEditorKindRef = useRef('markdown')
  const authoredAssetSyncTimerRef = useRef(null)
  const handleSaveEditorDocumentRef = useRef(null)
  const pendingApplyRef = useRef(null)

  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState('myDocuments')
  const EDITOR_SESSION_KEY = 'dokv.ui.editorSession'

  // ========== Panel Visibility State (toggle group) ==========
  const LEFT_VIS_KEY = 'dokv.ui.leftPanelVisible'
  const CENTER_VIS_KEY = 'dokv.ui.centerPanelVisible'
  const EDITOR_VIS_KEY = 'dokv.ui.editorPanelVisible'
  const CHAT_VIS_KEY = 'dokv.ui.chatPanelVisible'

  const [leftPanelVisible, setLeftPanelVisible] = useState(() => {
    try { const v = localStorage.getItem(LEFT_VIS_KEY); return v !== null ? v === '1' : DEFAULT_PANEL_VISIBILITY.left } catch { return DEFAULT_PANEL_VISIBILITY.left }
  })
  const [centerPanelVisible, setCenterPanelVisible] = useState(() => {
    try { const v = localStorage.getItem(CENTER_VIS_KEY); return v !== null ? v === '1' : DEFAULT_PANEL_VISIBILITY.center } catch { return DEFAULT_PANEL_VISIBILITY.center }
  })
  const [editorPanelVisible, setEditorPanelVisible] = useState(() => {
    try { const v = localStorage.getItem(EDITOR_VIS_KEY); return v !== null ? v === '1' : DEFAULT_PANEL_VISIBILITY.editor } catch { return DEFAULT_PANEL_VISIBILITY.editor }
  })
  const [chatPanelVisible, setChatPanelVisible] = useState(() => {
    try { const v = localStorage.getItem(CHAT_VIS_KEY); return v !== null ? v === '1' : DEFAULT_PANEL_VISIBILITY.chat } catch { return DEFAULT_PANEL_VISIBILITY.chat }
  })

  useEffect(() => { try { localStorage.setItem(LEFT_VIS_KEY, leftPanelVisible ? '1' : '0') } catch {} }, [leftPanelVisible])
  useEffect(() => { try { localStorage.setItem(CENTER_VIS_KEY, centerPanelVisible ? '1' : '0') } catch {} }, [centerPanelVisible])
  useEffect(() => { try { localStorage.setItem(EDITOR_VIS_KEY, editorPanelVisible ? '1' : '0') } catch {} }, [editorPanelVisible])
  useEffect(() => { try { localStorage.setItem(CHAT_VIS_KEY, chatPanelVisible ? '1' : '0') } catch {} }, [chatPanelVisible])

  // Determine which panel gets flex-1 (fills remaining space). Priority: center > editor > chat > left
  const flexPanel = useMemo(() => {
    if (centerPanelVisible) return 'center'
    if (editorPanelVisible) return 'editor'
    if (chatPanelVisible) return 'chat'
    return 'left'
  }, [centerPanelVisible, editorPanelVisible, chatPanelVisible])

  // Toggle a panel on/off — enforces minimum 1 panel visible, auto-redistributes
  const needsRedistributeRef = useRef(false)
  const togglePanel = useCallback((panelId) => {
    const current = { left: leftPanelVisible, center: centerPanelVisible, editor: editorPanelVisible, chat: chatPanelVisible }
    const setters = { left: setLeftPanelVisible, center: setCenterPanelVisible, editor: setEditorPanelVisible, chat: setChatPanelVisible }
    if (current[panelId]) {
      // Turning OFF — block if it's the last visible panel
      const othersOn = Object.entries(current).some(([k, v]) => k !== panelId && v)
      if (!othersOn) return
    }
    needsRedistributeRef.current = true
    setters[panelId](prev => !prev)
  }, [leftPanelVisible, centerPanelVisible, editorPanelVisible, chatPanelVisible])

  // ========== Resizable Panel Width State ==========
  const LEFT_WIDTH_KEY = 'dokv.ui.leftPanelWidth'
  const CENTER_WIDTH_KEY = 'dokv.ui.centerPanelWidth'
  const CHAT_WIDTH_KEY = 'dokv.ui.chatPanelWidth'
  const EDITOR_WIDTH_KEY = 'dokv.ui.editorPanelWidth'
  const MIN_LEFT_WIDTH = 330
  const MIN_PANEL_WIDTH = 200
  // RHWP studio iframe needs much more horizontal room than markdown for its
  // toolbar and ruler. dorea-x 운영값: 770 (메뉴 collapse 감수) / 800+ (메뉴 보장).
  // 200은 dorea-x의 일시적 테스트값이었음 — 우리는 운영 권장값을 채택.
  const RHWP_STUDIO_MIN_WIDTH = 770
  const MAX_PANEL_WIDTH = 600
  const MIN_CENTER_WIDTH = 300
  // Compute initial widths for 1:2:2 ratio (panels 1,2,4) based on viewport
  // No MAX clamp — layout computation sets exact pixel ratios
  const _vw = typeof window !== 'undefined' ? window.innerWidth : 1280
  const _unit = (_vw - 8) / 5 // 8px = 2 resize handles × 4px; 5 parts for 1:2:2
  const DEFAULT_LEFT_WIDTH = Math.max(MIN_LEFT_WIDTH, Math.round(_unit))
  const DEFAULT_CENTER_WIDTH = Math.max(MIN_CENTER_WIDTH, Math.round(_unit * 2))
  const DEFAULT_CHAT_WIDTH = Math.max(MIN_PANEL_WIDTH, Math.round(_unit * 2))
  const DEFAULT_EDITOR_WIDTH = Math.max(MIN_PANEL_WIDTH, Math.round(_unit * 2))

  const [leftPanelWidth, setLeftPanelWidth] = useState(() => {
    try { const v = parseInt(localStorage.getItem(LEFT_WIDTH_KEY)); return (v >= MIN_LEFT_WIDTH) ? v : DEFAULT_LEFT_WIDTH } catch { return DEFAULT_LEFT_WIDTH }
  })
  const [centerPanelWidth, setCenterPanelWidth] = useState(() => {
    try { const v = parseInt(localStorage.getItem(CENTER_WIDTH_KEY)); return (v >= MIN_CENTER_WIDTH) ? v : DEFAULT_CENTER_WIDTH } catch { return DEFAULT_CENTER_WIDTH }
  })
  const [chatPanelWidth, setChatPanelWidth] = useState(() => {
    try { const v = parseInt(localStorage.getItem(CHAT_WIDTH_KEY)); return (v >= MIN_PANEL_WIDTH) ? v : DEFAULT_CHAT_WIDTH } catch { return DEFAULT_CHAT_WIDTH }
  })
  const [editorPanelWidth, setEditorPanelWidth] = useState(() => {
    try { const v = parseInt(localStorage.getItem(EDITOR_WIDTH_KEY)); return (v >= MIN_PANEL_WIDTH) ? v : DEFAULT_EDITOR_WIDTH } catch { return DEFAULT_EDITOR_WIDTH }
  })
  const isResizingRef = useRef(false)

  useEffect(() => { try { localStorage.setItem(LEFT_WIDTH_KEY, String(leftPanelWidth)) } catch {} }, [leftPanelWidth])
  useEffect(() => { try { localStorage.setItem(CENTER_WIDTH_KEY, String(centerPanelWidth)) } catch {} }, [centerPanelWidth])
  useEffect(() => { try { localStorage.setItem(CHAT_WIDTH_KEY, String(chatPanelWidth)) } catch {} }, [chatPanelWidth])
  useEffect(() => { try { localStorage.setItem(EDITOR_WIDTH_KEY, String(editorPanelWidth)) } catch {} }, [editorPanelWidth])

  // ========== Font Size State (Chat & Editor) ==========
  const CHAT_FONT_SIZE_KEY = 'dokv.ui.chatFontSize'
  const EDITOR_FONT_SIZE_KEY = 'dokv.ui.editorFontSize'
  const FONT_SIZE_MIN = 10
  const FONT_SIZE_MAX = 24
  const FONT_SIZE_STEP = 1
  const FONT_SIZE_DEFAULT = 13

  const [chatFontSize, setChatFontSize] = useState(() => {
    try { const v = parseInt(localStorage.getItem(CHAT_FONT_SIZE_KEY)); return (v >= FONT_SIZE_MIN && v <= FONT_SIZE_MAX) ? v : FONT_SIZE_DEFAULT } catch { return FONT_SIZE_DEFAULT }
  })
  const [editorFontSize, setEditorFontSize] = useState(() => {
    try { const v = parseInt(localStorage.getItem(EDITOR_FONT_SIZE_KEY)); return (v >= FONT_SIZE_MIN && v <= FONT_SIZE_MAX) ? v : FONT_SIZE_DEFAULT } catch { return FONT_SIZE_DEFAULT }
  })

  useEffect(() => {
    try { localStorage.setItem(CHAT_FONT_SIZE_KEY, String(chatFontSize)) } catch {}
  }, [chatFontSize])
   useEffect(() => {
     try { localStorage.setItem(EDITOR_FONT_SIZE_KEY, String(editorFontSize)) } catch {}
   }, [editorFontSize])

   // Apply font size to editor's ProseMirror element
  useEffect(() => {
    if (!editorPanelVisible) return
    if (activeEditorKind !== 'markdown') return
    const applyEditorFontSize = () => {
      // Target all ProseMirror contenteditable elements inside the editor wrapper
      const container = document.querySelector('.dorea-toast-editor')
      if (!container) return
      container.querySelectorAll('.ProseMirror').forEach((el) => {
        el.style.fontSize = `${editorFontSize}px`
      })
      // Also set on the wrapper so toolbar previews inherit
      container.style.fontSize = `${editorFontSize}px`
    }
    // Retry a few times to handle lazy-loaded editor mount
    let attempts = 0
    const interval = setInterval(() => {
      applyEditorFontSize()
      attempts++
      if (attempts >= 5) clearInterval(interval)
    }, 200)
    return () => clearInterval(interval)
  }, [editorFontSize, editorPanelVisible])

  // ========== Editor Document State ==========
  const readPersistedEditorSession = () => {
    try {
      return JSON.parse(localStorage.getItem(EDITOR_SESSION_KEY) || 'null') || {}
    } catch {
      return {}
    }
  }
  const [activeEditorDocId, setActiveEditorDocId] = useState(() => readPersistedEditorSession().activeEditorDocId || null)
  const [activeEditorDraftId, setActiveEditorDraftId] = useState(() => readPersistedEditorSession().activeEditorDraftId || null)
  const [editingDocDomain, setEditingDocDomain] = useState(() => readPersistedEditorSession().editingDocDomain || null)
  const [editingMyDocFileId, setEditingMyDocFileId] = useState(() => readPersistedEditorSession().editingMyDocFileId || null)
  const [editorDocFilename, setEditorDocFilename] = useState(() => readPersistedEditorSession().editorDocFilename || null)
  const [activeEditorKind, setActiveEditorKind] = useState('markdown')
  // Keep the ref in sync at render time so editorRef.current resolves to the
  // active editor synchronously inside event handlers fired right after a kind change.
  activeEditorKindRef.current = activeEditorKind
  const activeEditorCapabilities = useMemo(() => getEditorCapabilities(activeEditorKind), [activeEditorKind])
  const [hasMountedMarkdownEditor, setHasMountedMarkdownEditor] = useState(true)
  // RHWP는 첫 사용 시점(채팅 의도 매칭이 'rhwp'를 활성화하거나 사용자가 hwp/hwpx
  // 파일을 열 때)까지 마운트를 미룬다. 한번 마운트되면 iframe leak 회피를 위해
  // 언마운트하지 않고 visibility만 토글한다 (RhwpEditor 컴포넌트 주석 참고).
  const [hasMountedRhwpEditor, setHasMountedRhwpEditor] = useState(false)
  const [viewerStateByDocId, setViewerStateByDocId] = useState(() => {
    try { return JSON.parse(localStorage.getItem('dokv.ui.viewerStateByDocId')) || {} } catch { return {} }
  })
  const [proposalPanelState, setProposalPanelState] = useState({})
  const [pendingProposals, setPendingProposals] = useState([])
  const editorPanelMinWidth = activeEditorKind === 'rhwp' ? RHWP_STUDIO_MIN_WIDTH : MIN_PANEL_WIDTH

  useEffect(() => {
    if (!editorPanelVisible) return
    if (activeEditorKind === 'markdown') setHasMountedMarkdownEditor(true)
    if (activeEditorKind === 'rhwp') setHasMountedRhwpEditor(true)
  }, [editorPanelVisible, activeEditorKind])

  // 패널 최소폭이 RHWP 모드로 전환되며 커지면 현재 폭을 새 최소값으로 클램프.
  useEffect(() => {
    if (!editorPanelVisible) return
    setEditorPanelWidth((w) => Math.max(editorPanelMinWidth, w))
  }, [editorPanelMinWidth, editorPanelVisible])

  useEffect(() => {
    try { localStorage.setItem('dokv.ui.viewerStateByDocId', JSON.stringify(viewerStateByDocId)) } catch {}
  }, [viewerStateByDocId])

  useEffect(() => {
    try {
      const hasEditorSession = Boolean(activeEditorDocId || activeEditorDraftId || editingMyDocFileId || editorDocFilename || editingDocDomain)
      if (!hasEditorSession) {
        localStorage.removeItem(EDITOR_SESSION_KEY)
        return
      }

      localStorage.setItem(EDITOR_SESSION_KEY, JSON.stringify({
        activeEditorDocId,
        activeEditorDraftId,
        editingDocDomain,
        editingMyDocFileId,
        editorDocFilename,
      }))
    } catch {}
  }, [activeEditorDocId, activeEditorDraftId, editingDocDomain, editingMyDocFileId, editorDocFilename])

  const clearScratchEditorState = useCallback(() => {
    setActiveEditorDraftId(null)
    setViewerStateByDocId((prev) => {
      if (!prev || !prev.__scratch__) return prev
      const next = { ...prev }
      delete next.__scratch__
      return next
    })
    if (!activeEditorDocId && editorRef.current) {
      editorRef.current.setMarkdown('')
    }
  }, [activeEditorDocId])

  const ensureEditorDocument = useCallback(async () => {
    if (activeEditorDocId) return activeEditorDocId
    if (requestedEditorKindRef.current !== 'markdown') return null
    if (editorProvisionPromiseRef.current) return editorProvisionPromiseRef.current
    const provisionVersion = editorProvisionVersionRef.current

    const pendingPromise = (async () => {
      const currentMarkdown = editorRef.current?.getMarkdown?.() || ''
      const result = await filesAPI.saveAuthored(currentMarkdown, editorDocFilename || 'Untitled')
      const fileId = result?.file_id
      if (!fileId) throw new Error('Authored document provisioning failed')

      if (provisionVersion !== editorProvisionVersionRef.current || requestedEditorKindRef.current !== 'markdown') {
        await loadMyDocFiles({ silent: true })
        return fileId
      }

      setActiveEditorKind('markdown')
      setActiveEditorDocId(fileId)
      setActiveEditorDraftId(null)
      setEditingDocDomain('my_documents')
      setEditingMyDocFileId(fileId)
      setEditorDocFilename(result?.filename || 'Untitled.md')
      setViewerStateByDocId((prev) => ({
        ...prev,
        [fileId]: { markdown: currentMarkdown, updatedAt: Date.now() },
      }))
      await loadMyDocFiles({ silent: true })
      return fileId
    })()

    editorProvisionPromiseRef.current = pendingPromise
    try {
      return await pendingPromise
    } finally {
      editorProvisionPromiseRef.current = null
    }
  }, [activeEditorDocId, editorDocFilename, loadMyDocFiles])

  useEffect(() => {
    if (!editorPanelVisible || activeEditorKind !== 'markdown' || !activeEditorDocId) return
    const cachedMarkdown = viewerStateByDocId?.[activeEditorDocId]?.markdown
    if (typeof cachedMarkdown !== 'string') return

    let attempts = 0
    const maxAttempts = 50
    const intervalId = setInterval(() => {
      attempts += 1
      if (editorRef.current) {
        if ((editorRef.current.getMarkdown?.() || '') !== cachedMarkdown) {
          editorRef.current.setMarkdown(cachedMarkdown)
        }
        clearInterval(intervalId)
      } else if (attempts >= maxAttempts) {
        clearInterval(intervalId)
      }
    }, 100)

    return () => clearInterval(intervalId)
  }, [activeEditorKind, editorPanelVisible, activeEditorDocId, viewerStateByDocId])

  useEffect(() => {
    return () => {
      if (authoredAssetSyncTimerRef.current) {
        clearTimeout(authoredAssetSyncTimerRef.current)
        authoredAssetSyncTimerRef.current = null
      }
    }
  }, [])

  const getPanelMinWidth = useCallback((panelId) => {
    if (panelId === 'left') return MIN_LEFT_WIDTH
    if (panelId === 'center') return MIN_CENTER_WIDTH
    if (panelId === 'editor') return editorPanelMinWidth
    return MIN_PANEL_WIDTH
  }, [editorPanelMinWidth])

  const getPanelMaxWidth = useCallback((panelId) => {
    if (panelId !== 'editor') return MAX_PANEL_WIDTH
    const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : editorPanelMinWidth
    return Math.max(MAX_PANEL_WIDTH, editorPanelMinWidth, viewportWidth)
  }, [editorPanelMinWidth])

  const clampPanelWidth = useCallback((panelId, newWidth) => {
    return Math.max(getPanelMinWidth(panelId), Math.min(getPanelMaxWidth(panelId), newWidth))
  }, [getPanelMinWidth, getPanelMaxWidth])

  useEffect(() => {
    if (!editorPanelVisible) return
    setEditorPanelWidth((width) => Math.max(editorPanelMinWidth, width))
  }, [editorPanelMinWidth, editorPanelVisible])

  // Distribute visible panels equally
  const distributeEqual = useCallback(() => {
    const vis = { left: leftPanelVisible, center: centerPanelVisible, editor: editorPanelVisible, chat: chatPanelVisible }
    const visibleIds = ['left', 'center', 'editor', 'chat'].filter(id => vis[id])
    if (visibleIds.length === 0) return
    const vw = window.innerWidth
    const handleCount = Math.max(0, visibleIds.length - 1)
    const available = vw - handleCount * 4 // 4px per resize handle
    const each = Math.floor(available / visibleIds.length)
    const setters = { left: setLeftPanelWidth, center: setCenterPanelWidth, chat: setChatPanelWidth, editor: setEditorPanelWidth }
    // Determine flex panel locally (same priority as flexPanel memo)
    const fp = visibleIds.includes('center') ? 'center' : visibleIds.includes('editor') ? 'editor' : visibleIds.includes('chat') ? 'chat' : 'left'
for (const id of visibleIds) {
        if (id !== fp) setters[id](Math.max(getPanelMinWidth(id), each))
      }
  }, [leftPanelVisible, centerPanelVisible, editorPanelVisible, chatPanelVisible, getPanelMinWidth])

  // Auto-redistribute when panel visibility changes via toggle
  // 3 panels with left visible → 1:2:2, otherwise equal
  useEffect(() => {
    if (!needsRedistributeRef.current) return
    needsRedistributeRef.current = false
    const vis = { left: leftPanelVisible, center: centerPanelVisible, editor: editorPanelVisible, chat: chatPanelVisible }
    const visibleIds = ['left', 'center', 'editor', 'chat'].filter(id => vis[id])
    if (visibleIds.length === 0) return
    const vw = window.innerWidth
    const handleCount = Math.max(0, visibleIds.length - 1)
    const available = vw - handleCount * 4
    const widthSetters = { left: setLeftPanelWidth, center: setCenterPanelWidth, chat: setChatPanelWidth, editor: setEditorPanelWidth }
    const fp = visibleIds.includes('center') ? 'center' : visibleIds.includes('editor') ? 'editor' : visibleIds.includes('chat') ? 'chat' : 'left'

    if (visibleIds.length === 3 && vis.left) {
      // 1:2:2 ratio — left gets 1/5, others get 2/5 each
      const unit = available / 5
      for (const id of visibleIds) {
        if (id !== fp) widthSetters[id](Math.round(Math.max(getPanelMinWidth(id), id === 'left' ? unit : unit * 2)))
      }
    } else {
      // Equal distribution
      const each = Math.floor(available / visibleIds.length)
      for (const id of visibleIds) {
          if (id !== fp) widthSetters[id](Math.max(getPanelMinWidth(id), each))
        }
      }
  }, [leftPanelVisible, centerPanelVisible, editorPanelVisible, chatPanelVisible, getPanelMinWidth])

  // Generic resize: targetPanelId = which panel's width to change, direction = 1 (drag right → grow) or -1
  const handleResizePointerDown = useCallback((targetPanelId, direction, e) => {
    e.preventDefault()
    e.target.setPointerCapture(e.pointerId)
    isResizingRef.current = true
    const startX = e.clientX

    const widths = { left: leftPanelWidth, center: centerPanelWidth, chat: chatPanelWidth, editor: editorPanelWidth }
    const setters = { left: setLeftPanelWidth, center: setCenterPanelWidth, chat: setChatPanelWidth, editor: setEditorPanelWidth }
    const startWidth = widths[targetPanelId]
    const setter = setters[targetPanelId]
    const minW = getPanelMinWidth(targetPanelId)

    // Snapshot visibility for consistent calculation during drag
    const vis = { left: leftPanelVisible, center: centerPanelVisible, chat: chatPanelVisible, editor: editorPanelVisible }
    const fp = vis.center ? 'center' : vis.editor ? 'editor' : vis.chat ? 'chat' : 'left'

    const onMove = (ev) => {
      const delta = (ev.clientX - startX) * direction
      const newW = clampPanelWidth(targetPanelId, startWidth + delta)
      // Ensure flex panel doesn't shrink below its minimum
      const currentWidths = { ...widths, [targetPanelId]: newW }
      const totalFixed = Object.entries(currentWidths).filter(([id]) => vis[id] && id !== fp).reduce((sum, [_, w]) => sum + w, 0)
      const handleSpace = (Object.values(vis).filter(Boolean).length - 1) * 4
      const flexWidth = window.innerWidth - totalFixed - handleSpace
      const minFlexWidth = getPanelMinWidth(fp)
      if (flexWidth < minFlexWidth) return
      setter(newW)
    }

    const onUp = (ev) => {
      isResizingRef.current = false
      ev.target.removeEventListener('pointermove', onMove)
      ev.target.removeEventListener('pointerup', onUp)
    }

    e.target.addEventListener('pointermove', onMove)
    e.target.addEventListener('pointerup', onUp)
  }, [leftPanelWidth, centerPanelWidth, chatPanelWidth, editorPanelWidth, leftPanelVisible, centerPanelVisible, chatPanelVisible, editorPanelVisible, clampPanelWidth, getPanelMinWidth])

  const handleResizeKeyDown = useCallback((targetPanelId, direction, e) => {
    const widths = { left: leftPanelWidth, center: centerPanelWidth, chat: chatPanelWidth, editor: editorPanelWidth }
    const setters = { left: setLeftPanelWidth, center: setCenterPanelWidth, chat: setChatPanelWidth, editor: setEditorPanelWidth }
    const currentWidth = widths[targetPanelId]
    const setter = setters[targetPanelId]
    const minW = getPanelMinWidth(targetPanelId)
    const step = e.shiftKey ? 48 : 16
    let newW = currentWidth
    switch (e.key) {
      case 'ArrowRight':
        e.preventDefault()
        newW = direction === 1 ? currentWidth + step : currentWidth - step
        break
      case 'ArrowLeft':
        e.preventDefault()
        newW = direction === 1 ? currentWidth - step : currentWidth + step
        break
      case 'Home':
        e.preventDefault()
        newW = minW
        break
      case 'End':
        e.preventDefault()
        newW = getPanelMaxWidth(targetPanelId)
        break
      default:
        return
    }
    newW = clampPanelWidth(targetPanelId, newW)
    const vis = { left: leftPanelVisible, center: centerPanelVisible, chat: chatPanelVisible, editor: editorPanelVisible }
    const fp = vis.center ? 'center' : vis.editor ? 'editor' : vis.chat ? 'chat' : 'left'
    const testWidths = { left: leftPanelWidth, center: centerPanelWidth, chat: chatPanelWidth, editor: editorPanelWidth, [targetPanelId]: newW }
    const totalFixed = Object.entries(testWidths).filter(([id]) => vis[id] && id !== fp).reduce((sum, [_, w]) => sum + w, 0)
    const handleSpace = (Object.values(vis).filter(Boolean).length - 1) * 4
    const flexWidth = window.innerWidth - totalFixed - handleSpace
    const minFlexWidth = getPanelMinWidth(fp)
    if (flexWidth < minFlexWidth) return
    setter(newW)
  }, [leftPanelWidth, centerPanelWidth, chatPanelWidth, editorPanelWidth, leftPanelVisible, centerPanelVisible, chatPanelVisible, editorPanelVisible, clampPanelWidth, getPanelMaxWidth, getPanelMinWidth])

  // Window resize: shrink non-flex panels proportionally when viewport narrows
  useEffect(() => {
    const onResize = () => {
      const vw = window.innerWidth
      const vis = { left: leftPanelVisible, center: centerPanelVisible, chat: chatPanelVisible, editor: editorPanelVisible }
      const widths = { left: leftPanelWidth, center: centerPanelWidth, chat: chatPanelWidth, editor: editorPanelWidth }
      const fp = vis.center ? 'center' : vis.editor ? 'editor' : vis.chat ? 'chat' : 'left'
      const visibleIds = ['left', 'center', 'editor', 'chat'].filter(id => vis[id])
      const handleSpace = Math.max(0, visibleIds.length - 1) * 4
      const totalFixed = visibleIds.filter(id => id !== fp).reduce((sum, id) => sum + widths[id], 0)
      const flexWidth = vw - totalFixed - handleSpace
      const minFlexWidth = getPanelMinWidth(fp)

      if (flexWidth < minFlexWidth) {
        // Shrink non-flex panels proportionally
        const nonFlexIds = visibleIds.filter(id => id !== fp)
        const target = vw - minFlexWidth - handleSpace
        if (target > 0 && nonFlexIds.length > 0) {
          const ratio = target / totalFixed
          const setters = { left: setLeftPanelWidth, center: setCenterPanelWidth, chat: setChatPanelWidth, editor: setEditorPanelWidth }
          for (const id of nonFlexIds) {
            const minW = getPanelMinWidth(id)
            setters[id](Math.max(minW, Math.floor(widths[id] * ratio)))
          }
        }
      }
    }
    onResize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [leftPanelWidth, centerPanelWidth, chatPanelWidth, editorPanelWidth, leftPanelVisible, centerPanelVisible, chatPanelVisible, editorPanelVisible, getPanelMinWidth])
  const [files, setFiles] = useState([])
  const [filesLoading, setFilesLoading] = useState(true)
  const [filesError, setFilesError] = useState(false)
  const [filesFilter, setFilesFilter] = useState('')
  const [analysisSortByKb, setAnalysisSortByKb] = useState({})
  const [myDocFiles, setMyDocFiles] = useState([])
  const [myDocFilesLoading, setMyDocFilesLoading] = useState(true)
  const [myDocFilesError, setMyDocFilesError] = useState(false)
  const [myDocFilesFilter, setMyDocFilesFilter] = useState('')
  const [myDocSort, setMyDocSort] = useState(DEFAULT_FILE_LIST_SORT)

  const [openDocuments, setOpenDocuments] = useState([])
  const [activeDocumentId, setActiveDocumentId] = useState(null)
  const [segments, setSegments] = useState([])
  const [selectedSegmentIds, setSelectedSegmentIds] = useState([])

  const [chatSessions, setChatSessions] = useState([])
  const [chatsLoading, setChatsLoading] = useState(true)
  const [chatsError, setChatsError] = useState(false)
  const [chatsFilter, setChatsFilter] = useState('')
  const [activeChatId, setActiveChatId] = useState(null)
  const [messages, setMessages] = useState([])
  const [inputText, setInputText] = useState('')
  const [isGenerating, setIsGenerating] = useState(false)
  const [chatKnowledgeDbBySession, setChatKnowledgeDbBySession] = useState({})
  const [knowledgeDb, setKnowledgeDb] = useState('none') // "none" | "{kb_id}"
  const [preferredKnowledgeDb, setPreferredKnowledgeDb] = useState('none') // last user-selected KB, reused for new chats
  const [userKnowledgeDbs, setUserKnowledgeDbs] = useState([])


  // ========== Document-wide Context ==========
  const [includeDocContent, setIncludeDocContent] = useState(false)

  // ========== MCP/Skills (chat reflection) ==========
  const [enabledMcpSkills, setEnabledMcpSkills] = useState([])
  const [mcpActive, setMcpActive] = useState(true) // MCP 도구 활성 토글 (기본 ON)

  // ========== Persona summary for Agent Status panel ==========
  const [personaSummary, setPersonaSummary] = useState([]) // tag labels for status panel
  const [personaTooltipText, setPersonaTooltipText] = useState('') // full persona for tooltip

  // ========== Agent Status (floating status panel) ==========
  // status: 'idle' | 'thinking' | 'tool_use' | 'tool_result' | 'editing' | 'streaming'
  const [agentStatus, setAgentStatus] = useState({ status: 'idle', message: '', toolName: '', serverName: '', label: '', stage: '' })
  const agentStatusImageByState = {
    idle: '/AGENT-Idle.png',
    thinking: '/AGENT-Thinking.png',
    tool_use: '/AGENT-Tool_Use.png',
    tool_result: '/AGENT-Tool_Result.png',
    editing: '/AGENT-Editing.png',
    streaming: '/AGENT-Streaming.png',
  }
  const [agentStatusHistory, setAgentStatusHistory] = useState([])
  const agentStatusHistoryRef = useRef(null)
  const [activeLabel, setActiveLabel] = useState(null) // 'memory' | 'mcp' | 'skill' | 'rag'
  const streamSettlingTimerRef = useRef(null)
  const preserveComposerStateOnSessionSwitchRef = useRef(false)
  const lastPersistedEditorMarkdownRef = useRef('')
  const editorAutosaveInFlightRef = useRef(false)
  const personaBadgesRef = useRef(null)
  const mcpBadgesRef = useRef(null)
  const skillBadgesRef = useRef(null)
  const [personaOverflow, setPersonaOverflow] = useState(false)
  const [mcpOverflow, setMcpOverflow] = useState(false)
  const [skillOverflow, setSkillOverflow] = useState(false)
  const [focusSegmentId, setFocusSegmentId] = useState(null)
  const [pendingReference, setPendingReference] = useState(null)
  const [segmentPreviewDismissed, setSegmentPreviewDismissed] = useState(false)

  const canEditComposer = !isGenerating || agentStatus.stage === 'settling'

  const clearStreamSettlingTimer = useCallback(() => {
    if (streamSettlingTimerRef.current) {
      clearTimeout(streamSettlingTimerRef.current)
      streamSettlingTimerRef.current = null
    }
  }, [])

  const scheduleStreamSettling = useCallback(() => {
    clearStreamSettlingTimer()
    streamSettlingTimerRef.current = setTimeout(() => {
      setAgentStatus((prev) => {
        if (prev.status !== 'streaming') return prev
        return {
          ...prev,
          message: '응답 마무리중입니다...',
          stage: 'settling',
        }
      })
    }, 900)
  }, [clearStreamSettlingTimer])

  useEffect(() => {
    if (!canEditComposer || agentStatus.stage !== 'settling') return
    requestAnimationFrame(() => {
      const textarea = chatTextareaRef.current
      if (!textarea) return
      textarea.focus()
      const valueLength = textarea.value?.length ?? 0
      textarea.setSelectionRange(valueLength, valueLength)
    })
  }, [agentStatus.stage, canEditComposer])

  const rememberKnowledgeDbForSession = useCallback((sessionId, nextKnowledgeDb) => {
    if (!sessionId) return
    const normalized = typeof nextKnowledgeDb === 'string' && nextKnowledgeDb.trim() ? nextKnowledgeDb : 'none'
    setChatKnowledgeDbBySession((prev) => (
      prev[sessionId] === normalized
        ? prev
        : { ...prev, [sessionId]: normalized }
    ))
  }, [])

  const bindCurrentKnowledgeDbToSession = useCallback((sessionId, nextKnowledgeDb = knowledgeDb) => {
    rememberKnowledgeDbForSession(sessionId, nextKnowledgeDb)
  }, [knowledgeDb, rememberKnowledgeDbForSession])

  const handleKnowledgeDbChange = useCallback((nextKnowledgeDb) => {
    const normalized = typeof nextKnowledgeDb === 'string' && nextKnowledgeDb.trim() ? nextKnowledgeDb : 'none'
    setKnowledgeDb(normalized)
    setPreferredKnowledgeDb(normalized)
    if (activeChatId) {
      rememberKnowledgeDbForSession(activeChatId, normalized)
    }
  }, [activeChatId, rememberKnowledgeDbForSession])

  // ========== Agent Status History ==========
  useEffect(() => {
    if (agentStatus.status !== 'idle' && agentStatus.message) {
      setAgentStatusHistory(prev => [...prev, { ...agentStatus, timestamp: Date.now() }])
    }

    if (agentStatus.status === 'idle' || agentStatus.status === 'streaming') {
      setActiveLabel(null)
      return
    }

    if (agentStatus.label) {
      setActiveLabel(agentStatus.label)
      return
    }

    if (agentStatus.status === 'tool_use' && agentStatus.serverName) {
      const server = enabledMcpSkills.find(s => s.name === agentStatus.serverName)
      const label = server?.server_type === 'skill' ? 'skill' : server ? 'mcp' : null
      if (label) {
        setActiveLabel(label)
      }
    }
  }, [agentStatus, enabledMcpSkills])

  useEffect(() => () => clearStreamSettlingTimer(), [clearStreamSettlingTimer])

  useEffect(() => {
    if (agentStatusHistoryRef.current) {
      agentStatusHistoryRef.current.scrollTop = agentStatusHistoryRef.current.scrollHeight
    }
  }, [agentStatusHistory, agentStatus])

  // Detect overflow on badge rows
  useEffect(() => {
    const check = (ref, setter) => {
      if (ref.current) setter(ref.current.scrollWidth > ref.current.clientWidth)
    }
    check(personaBadgesRef, setPersonaOverflow)
    check(mcpBadgesRef, setMcpOverflow)
    check(skillBadgesRef, setSkillOverflow)
  })

  const [showSettings, setShowSettings] = useState(false)
  const [settingsInitialMenu, setSettingsInitialMenu] = useState(null)
  const [username, setUsername] = useState('')
  const [userRole, setUserRole] = useState('user')
  const [userId, setUserId] = useState(null)
  const [currentAIModel, setCurrentAIModel] = useState(null)
  const [chatModelOptions, setChatModelOptions] = useState([])
  const [selectedChatModelKey, setSelectedChatModelKey] = useState(null)
  const [fileContextMenu, setFileContextMenu] = useState(null) // { x, y, file }
  // layoutMenuOpen removed — replaced by panel toggle group in header

  // ========== Capture/Image Attachment State ==========
  // pendingImages: [{ localId, file, previewUrl, status: 'uploading'|'uploaded'|'error', progress, attachmentId }]
  const [pendingImages, setPendingImages] = useState([])
  
  // ========== File Upload Queue State ==========
  // uploadQueue: [{ localId, file, knowledgeDbId, status: 'pending'|'uploading'|'success'|'error', progress, error }]
  const [uploadQueue, setUploadQueue] = useState([])
  const uploadQueueRef = useRef([])
  const isUploadingRef = useRef(false)
  const dragDepthRef = useRef(0)
  const [isUploadDragActive, setIsUploadDragActive] = useState(false)
  const myDocDragDepthRef = useRef(0)
  const [isMyDocUploadDragActive, setIsMyDocUploadDragActive] = useState(false)
  const [isMyDocUploading, setIsMyDocUploading] = useState(false)
  const [uploadPolicy, setUploadPolicy] = useState(DEFAULT_UPLOAD_POLICY)
  const [uploadKbId, setUploadKbId] = useState(null) // null = default KB (서버에서 자동 할당)
  const [quickKbDialogOpen, setQuickKbDialogOpen] = useState(false)
  const [quickKbName, setQuickKbName] = useState('')
  const [renameDialog, setRenameDialog] = useState({ open: false, sessionId: null, value: '' })
  
  // Attachment image cache for rendering (attachmentId -> objectURL)
  // Key: `${sessionId}:${attachmentId}`, Value: objectURL (blob:...)
  const attachmentCacheRef = useRef(new Map())
  
  // Track loading state for attachments: Map<cacheKey, 'loading'|'loaded'|'error'>
  const [attachmentLoadingState, setAttachmentLoadingState] = useState({})
  
  // Image lightbox modal state
  const [lightboxImage, setLightboxImage] = useState(null) // { url, alt } or null
  const [segmentPreviewUrls, setSegmentPreviewUrls] = useState({})
  const segmentPreviewUrlsRef = useRef({})
  const segmentPreviewInFlightRef = useRef(new Set())

  // ========== Quick Actions (빠른 메뉴) ==========
  const [quickActions, setQuickActions] = useState([])

  const upsertSegmentPreviewUrl = useCallback((key, nextUrl) => {
    if (!key) return
    const prevUrl = segmentPreviewUrlsRef.current[key]
    if (typeof prevUrl === 'string' && prevUrl.startsWith('blob:') && prevUrl !== nextUrl) {
      URL.revokeObjectURL(prevUrl)
    }
    segmentPreviewUrlsRef.current[key] = nextUrl
    setSegmentPreviewUrls((prev) => ({ ...prev, [key]: nextUrl }))
  }, [])

  const loadSegmentPreview = useCallback(async (seg, { force = false } = {}) => {
    const key = getSegmentPreviewCacheKey(seg)
    if (!key) return null

    const cached = segmentPreviewUrlsRef.current[key]
    if (!force && cached !== undefined) {
      return cached
    }

    if (segmentPreviewInFlightRef.current.has(key)) {
      return cached ?? null
    }

    segmentPreviewInFlightRef.current.add(key)
    try {
      const segmentId = String(seg?.id || seg?.seg_id || '')
      if (!segmentId) {
        upsertSegmentPreviewUrl(key, null)
        return null
      }

      const blob = await filesAPI.fetchSegmentPreviewBlob(String(seg.file_id), segmentId)
      if (!(blob instanceof Blob) || blob.size === 0) {
        upsertSegmentPreviewUrl(key, null)
        return null
      }

      const objectUrl = URL.createObjectURL(blob)
      upsertSegmentPreviewUrl(key, objectUrl)
      return objectUrl
    } catch {
      upsertSegmentPreviewUrl(key, null)
      return null
    } finally {
      segmentPreviewInFlightRef.current.delete(key)
    }
  }, [upsertSegmentPreviewUrl])

  const preloadSegmentPreviews = useCallback(async (segmentRefs = [], { force = false } = {}) => {
    const targets = segmentRefs.filter((seg) => seg && isNonTextSegment(seg) && getSegmentPreviewCacheKey(seg))
    if (!targets.length) return
    await Promise.allSettled(targets.map((seg) => loadSegmentPreview(seg, { force })))
  }, [loadSegmentPreview])

  useEffect(() => {
    return () => {
      Object.values(segmentPreviewUrlsRef.current).forEach((url) => {
        if (typeof url === 'string' && url.startsWith('blob:')) {
          URL.revokeObjectURL(url)
        }
      })
      segmentPreviewUrlsRef.current = {}
      segmentPreviewInFlightRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const refs = []
    messages.forEach((message) => {
      if (Array.isArray(message?.selected_segments)) {
        refs.push(...message.selected_segments)
      }
      refs.push(...getMessageRagSources(message))
    })
    preloadSegmentPreviews(refs)
  }, [messages, preloadSegmentPreviews])

  useEffect(() => {
    if (selectedSegmentIds.length > 0) {
      setSegmentPreviewDismissed(false)
    }
  }, [selectedSegmentIds])

  useEffect(() => {
    const selectedRefs = selectedSegmentIds
      .map((id) => segments.find((segment) => segment.id === id))
      .filter(Boolean)
    preloadSegmentPreviews(selectedRefs)
  }, [selectedSegmentIds, segments, preloadSegmentPreviews])

  // ========== Confirm Dialog State ==========
  const [confirmDialog, setConfirmDialog] = useState({
    open: false,
    title: 'DOREA-XP (공개용)',
    description: '',
    confirmText: '확인',
    cancelText: '취소',
    variant: 'default',
    onConfirm: null,
  })
  const [reprocessDialog, setReprocessDialog] = useState({
    open: false,
    fileId: null,
    filename: '',
    provider: 'opendataloader',
  })

  // Computed: is current AI model vision-capable? (backend-computed)
  const buildChatModelKey = useCallback((model) => {
    if (!model?.type || !model?.model) return null
    return `${model.type}:${model.model}`
  }, [])

  const selectedChatModel = useMemo(() => {
    if (!selectedChatModelKey) return null
    return chatModelOptions.find((model) => buildChatModelKey(model) === selectedChatModelKey) || null
  }, [buildChatModelKey, chatModelOptions, selectedChatModelKey])

  const effectiveChatModel = selectedChatModel || currentAIModel

  const isVisionCapable = effectiveChatModel?.vision_capable ?? false

  const currentAnalysisSortKey = useMemo(() => String(uploadKbId ?? 'default'), [uploadKbId])

  const currentAnalysisSort = analysisSortByKb[currentAnalysisSortKey] || DEFAULT_FILE_LIST_SORT

  const sortedFiles = useMemo(() => sortFileList(files, currentAnalysisSort), [files, currentAnalysisSort])

  const sortedMyDocFiles = useMemo(() => sortFileList(myDocFiles, myDocSort), [myDocFiles, myDocSort])

  // Derived filtered lists for sidebar search
  const filteredFiles = useMemo(() => {
    if (!filesFilter.trim()) return sortedFiles
    const q = filesFilter.trim().toLowerCase()
    return sortedFiles.filter((f) => (f.filename || '').toLowerCase().includes(q))
  }, [sortedFiles, filesFilter])

  const filteredMyDocFiles = useMemo(() => {
    if (!myDocFilesFilter.trim()) return sortedMyDocFiles
    const q = myDocFilesFilter.trim().toLowerCase()
    return sortedMyDocFiles.filter((f) => (f.filename || '').toLowerCase().includes(q))
  }, [sortedMyDocFiles, myDocFilesFilter])

  const handleAnalysisSortToggle = useCallback((field) => {
    setAnalysisSortByKb((prev) => {
      const currentSort = prev[currentAnalysisSortKey] || DEFAULT_FILE_LIST_SORT
      return {
        ...prev,
        [currentAnalysisSortKey]: getNextFileListSort(currentSort, field),
      }
    })
  }, [currentAnalysisSortKey])

  const handleMyDocSortToggle = useCallback((field) => {
    setMyDocSort((prev) => getNextFileListSort(prev, field))
  }, [])

  const activeOpenDocument = useMemo(
    () => openDocuments.find((doc) => doc.id === activeDocumentId) || null,
    [openDocuments, activeDocumentId]
  )

  const activeDocumentDomain = useMemo(() => {
    if (!activeDocumentId) return null
    if (activeOpenDocument?.domain) return activeOpenDocument.domain

    if (myDocFiles.some((file) => file.id === activeDocumentId)) {
      return 'my_documents'
    }

    return 'analysis'
  }, [activeDocumentId, activeOpenDocument, myDocFiles])

  function formatFileSize(bytes) {
    const n = Number(bytes)
    if (!Number.isFinite(n) || n < 0) return '-'
    if (n < 1024) return `${n} B`
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
    if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
    return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  }

  function normalizeAnalysisProvider(_provider) {
    return 'opendataloader'
  }

  function formatAnalysisProvider(_provider) {
    return 'OpenDataLoader'
  }

  function getAnalysisStatusSummary(file) {
    const status = String(file?.status || '').trim().toLowerCase()
    if (status === 'completed') return '분석완료'
    if (status === 'failed') return '분석실패'
    if (['uploading', 'queued', 'converting', 'analyzing'].includes(status)) return '분석중'
    return '분석전'
  }

  function getAnalysisTooltipText(file) {
    const filename = String(file?.filename || '문서')
    const status = String(file?.status || '').trim().toLowerCase()
    const lines = [filename, `분석 상태: ${getAnalysisStatusSummary(file)}`]

    if (['analyzing', 'completed'].includes(status)) {
      lines.push(`분석 Provider: ${formatAnalysisProvider(file?.analysis_provider)}`)
    }

    return lines.join('\n')
  }

  function formatUploadDate(value) {
    if (!value) return '-'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '-'
    return date.toLocaleString('ko-KR', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    })
  }

  function getFileTypeLabel(filename) {
    const ext = String(filename || '').split('.').pop()?.toUpperCase()
    return ext ? `.${ext}` : '파일'
  }

  function isMarkdownMyDocument(file) {
    return isMarkdownDocument(file)
  }

  function getMarkdownFolderLabel(file) {
    return String(file?.storage_folder || file?.id || file?.filename || 'md-folder').trim() || 'md-folder'
  }

  function getEditorStorageFilenameLabel() {
    if (editingDocDomain === 'my_documents' && activeEditorDocId) {
      return 'source.md'
    }
    if (editorDocFilename) return editorDocFilename
    if (activeEditorDocId) return `${activeEditorDocId.slice(0, 8)}...`
    return '새 문서'
  }

  const filteredChats = useMemo(() => {
    if (!chatsFilter.trim()) return chatSessions
    const q = chatsFilter.trim().toLowerCase()
    return chatSessions.filter((s) => (s.session_name || '').toLowerCase().includes(q))
  }, [chatSessions, chatsFilter])

  // Keyboard navigation handler for sidebar listbox
  const handleListKeyDown = useCallback((e) => {
    const container = e.currentTarget
    const items = Array.from(container.querySelectorAll('[role="option"]'))
    if (items.length === 0) return
    const currentIndex = items.indexOf(document.activeElement)
    let nextIndex = currentIndex

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        nextIndex = currentIndex < items.length - 1 ? currentIndex + 1 : 0
        break
      case 'ArrowUp':
        e.preventDefault()
        nextIndex = currentIndex > 0 ? currentIndex - 1 : items.length - 1
        break
      case 'Home':
        e.preventDefault()
        nextIndex = 0
        break
      case 'End':
        e.preventDefault()
        nextIndex = items.length - 1
        break
      case 'Enter':
        e.preventDefault()
        if (currentIndex >= 0) items[currentIndex].click()
        return
      default:
        return
    }
    items[nextIndex]?.focus()
  }, [])

  /**
   * Handle captured text from PdfViewer (when vision model is NOT available)
   * Inserts text into chat input + shows toast suggesting vision model
   */
  const handleCaptureText = useCallback((text, matchedSegments) => {
    if (text && text.trim()) {
      setInputText((prev) => {
        const trimmed = prev.trim()
        if (trimmed) {
          return `${trimmed}\n\n${text.trim()}`
        }
        return text.trim()
      })
      toast.info('비전 모델을 활성화하면 이미지 인식이 가능합니다', { duration: 4000 })
    } else if (matchedSegments && matchedSegments.length === 0) {
      toast.info('선택한 영역에 텍스트가 없습니다')
    } else {
      toast.info('선택한 세그먼트에 추출 가능한 텍스트가 없습니다')
    }
  }, [])

  /**
   * Handle segment box selection from PdfViewer (drag-to-select in normal mode)
   * @param {string[]} segIds - Array of segment IDs intersecting the drag box
   * @param {boolean} additive - If true (Ctrl/Cmd held), union with existing selection
   */
  const handleSegmentBoxSelect = useCallback((segIds, additive) => {
    // Ensure chat session exists (create if needed)
    ensureChatSession()

    if (additive) {
      // Union: add new segments to existing selection (avoid duplicates)
      setSelectedSegmentIds((prev) => {
        const set = new Set(prev)
        for (const id of segIds) set.add(id)
        return Array.from(set)
      })
    } else {
      // Replace: new selection replaces existing
      setSelectedSegmentIds(segIds)
    }
  }, [ensureChatSession])

  // ========== Centralized session creation with Promise coalescing ==========
  const getOrCreateSession = useCallback(async (fileId) => {
    const key = fileId ?? 'null'
    if (sessionCreationPromises.has(key)) {
      return sessionCreationPromises.get(key)
    }
    const promise = chatsAPI.createSession(fileId, null)
      .finally(() => {
        sessionCreationPromises.delete(key)
      })
    sessionCreationPromises.set(key, promise)
    return promise
  }, [])

  const buildSelectedSegmentData = useCallback((segmentIds = selectedSegmentIds) => {
    return segmentIds
      .map((id) => {
        const seg = segments.find((segment) => segment.id === id)
        if (!seg) return null
        const displayText = getSegmentDisplayText(seg)
        return {
          id: seg.id,
          text: displayText,
          raw_text: (seg.text || '').trim(),
          type: seg.type,
          file_id: seg.file_id || activeDocumentId,
          page: seg.page,
        }
      })
      .filter(Boolean)
  }, [activeDocumentId, segments, selectedSegmentIds])

  const materializeSelectedSegmentAttachments = useCallback(async (sessionId, segmentRefs = []) => {
    const imageSegments = segmentRefs.filter((seg) => seg && isNonTextSegment(seg))
    if (!imageSegments.length) return []

    const uploadedPendingCount = pendingImages.filter((img) => img.status === 'uploaded' && img.attachmentId).length
    if (uploadedPendingCount + imageSegments.length > MAX_PENDING_IMAGES) {
      throw new Error(`이미지는 최대 ${MAX_PENDING_IMAGES}장까지 첨부할 수 있습니다.`)
    }

    const uploadedAttachments = []

    for (let index = 0; index < imageSegments.length; index += 1) {
      const seg = imageSegments[index]
      const segmentId = String(seg.id || seg.seg_id || '').trim()
      const fileId = String(seg.file_id || '').trim()
      if (!segmentId || !fileId) continue

      const previewKey = getSegmentPreviewCacheKey(seg)
      const cachedPreviewUrl = previewKey ? segmentPreviewUrlsRef.current[previewKey] : null

      let blob = null
      if (typeof cachedPreviewUrl === 'string' && cachedPreviewUrl.startsWith('blob:')) {
        try {
          const cachedPreviewResponse = await fetch(cachedPreviewUrl)
          blob = await cachedPreviewResponse.blob()
        } catch (error) {
          console.warn('Failed to reuse cached segment preview blob:', error)
        }
      }

      if (!(blob instanceof Blob) || blob.size === 0) {
        blob = await filesAPI.fetchSegmentPreviewBlob(fileId, segmentId)
      }

      if (!(blob instanceof Blob) || blob.size === 0) {
        throw new Error('선택한 이미지 세그먼트를 첨부용 이미지로 만들지 못했습니다.')
      }

      const mimeType = blob.type || 'image/png'
      const file = new File(
        [blob],
        `segment-${segmentId}${getImageExtensionFromMime(mimeType)}`,
        { type: mimeType }
      )
      const reference = normalizeAttachmentReference({
        file_id: fileId,
        segment_ids: [segmentId],
        focus_segment_id: segmentId,
        page: seg.page,
        segment_type: getSegmentType(seg),
      })
      const result = await chatsAPI.uploadAttachment(
        sessionId,
        file,
        reference ? { reference } : null
      )

      uploadedAttachments.push({
        localId: `selected-segment-${segmentId}-${index}`,
        file,
        previewUrl: URL.createObjectURL(blob),
        status: 'uploaded',
        progress: 100,
        attachmentId: result.attachment_id,
        attachmentMeta: {
          attachment_id: result.attachment_id,
          filename: result.filename,
          size: result.size,
          mime_type: result.mime_type,
          reference: normalizeAttachmentReference(result.reference || reference),
        },
      })
    }

    return uploadedAttachments
  }, [pendingImages])

  /**
   * Handle captured image from PdfViewer or file input
   * Uploads to backend and adds to pendingImages
   */
  const handleCaptureImage = useCallback(async (file, attachmentMetadata = null) => {
    if (!file) return

    // Pre-upload validation: MIME type
    const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
    const MAX_ATTACH_SIZE = 5 * 1024 * 1024 // 5MB
    if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
      toast.error('이미지 파일만 첨부할 수 있습니다. (PNG, JPEG, WebP, GIF)')
      return
    }
    if (file.size > MAX_ATTACH_SIZE) {
      toast.error(`첨부 파일 크기가 ${MAX_ATTACH_SIZE / (1024*1024)}MB를 초과합니다.`)
      return
    }

    // Ensure chat session exists (create if needed)
    let sessionId = activeChatId
    if (!sessionId) {
      try {
        const newSession = await getOrCreateSession(activeDocumentId || null)
        setChatSessions((prev) => prev.some(x => x.id === newSession.id) ? prev : [newSession, ...prev])
        bindCurrentKnowledgeDbToSession(newSession.id)
        skipNextMessageLoadRef.current = true
        preserveComposerStateOnSessionSwitchRef.current = true
        setActiveChatId(newSession.id)
        setActiveWorkspaceTab('chat')
        sessionId = newSession.id
      } catch (e) {
        console.error('Failed to create chat session for image upload:', e)
        return
      }
    }

    // Check max pending images
    if (pendingImages.length >= MAX_PENDING_IMAGES) {
      toast.error(`이미지는 최대 ${MAX_PENDING_IMAGES}장까지 첨부할 수 있습니다.`)
      return
    }

    // Create local preview
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const previewUrl = URL.createObjectURL(file)
    const normalizedReference = normalizeAttachmentReference(attachmentMetadata?.reference)

    // Add to pending with uploading status
    setPendingImages((prev) => [
      ...prev,
      {
        localId,
        file,
        previewUrl,
        status: 'uploading',
        progress: 0,
        attachmentId: null,
        attachmentMeta: normalizedReference ? { reference: normalizedReference } : null,
      }
    ])

    try {
      // Upload to backend
      const result = await chatsAPI.uploadAttachment(
        sessionId,
        file,
        normalizedReference ? { reference: normalizedReference } : null,
        (progress) => {
        setPendingImages((prev) =>
          prev.map((img) => (img.localId === localId ? { ...img, progress } : img))
        )
        }
      )

      // Mark as uploaded
      setPendingImages((prev) =>
        prev.map((img) =>
          img.localId === localId
            ? {
                ...img,
                status: 'uploaded',
                progress: 100,
                attachmentId: result.attachment_id,
                attachmentMeta: {
                  attachment_id: result.attachment_id,
                  filename: result.filename,
                  size: result.size,
                  mime_type: result.mime_type,
                  reference: normalizeAttachmentReference(result.reference || normalizedReference),
                },
              }
            : img
        )
      )

      toast.success('이미지가 첨부되었습니다.')
      // Show info toast if non-vision model
      if (!isVisionCapable) {
        toast.info('비전 모델이 아니어서 AI가 이미지를 인식하지 못할 수 있습니다.', { duration: 4000 })
      }
    } catch (e) {
      console.error('Failed to upload image:', e)
      // Mark as error
      setPendingImages((prev) =>
        prev.map((img) => (img.localId === localId ? { ...img, status: 'error' } : img))
      )
    }
  }, [activeChatId, activeDocumentId, pendingImages.length, isVisionCapable])

  /**
   * Handle clipboard paste - extract images and route through handleCaptureImage
   */
  const handlePaste = useCallback((e) => {
    const items = e.clipboardData?.items
    if (!items) return

    const imageFiles = []
    for (let i = 0; i < items.length; i++) {
      const item = items[i]
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) imageFiles.push(file)
      }
    }

    if (imageFiles.length === 0) return // No images — let default text paste proceed

    e.preventDefault() // Prevent default only when images found

    // Route each image through existing capture pipeline (respects max limit)
    imageFiles.forEach((file) => {
      handleCaptureImage(file)
    })
  }, [handleCaptureImage])

  /**
   * Remove a pending image (before sending message)
   */
  const handleRemovePendingImage = useCallback((localId) => {
    setPendingImages((prev) => {
      const img = prev.find((i) => i.localId === localId)
      if (img?.previewUrl) {
        URL.revokeObjectURL(img.previewUrl)
      }
      return prev.filter((i) => i.localId !== localId)
    })
  }, [])

  /**
   * Fetch attachment blob and cache as objectURL
   * Uses attachmentCacheRef to avoid re-fetching
   */
  const getAttachmentBlobUrl = useCallback(async (sessionId, attachmentId) => {
    const cacheKey = `${sessionId}:${attachmentId}`
    
    // Return cached URL if available
    if (attachmentCacheRef.current.has(cacheKey)) {
      return attachmentCacheRef.current.get(cacheKey)
    }
    
    // Mark as loading
    setAttachmentLoadingState((prev) => ({ ...prev, [cacheKey]: 'loading' }))
    
    try {
      const blob = await chatsAPI.fetchAttachmentBlob(sessionId, attachmentId)
      const objectUrl = URL.createObjectURL(blob)
      attachmentCacheRef.current.set(cacheKey, objectUrl)
      setAttachmentLoadingState((prev) => ({ ...prev, [cacheKey]: 'loaded' }))
      return objectUrl
    } catch (e) {
      console.error('Failed to fetch attachment blob:', e)
      setAttachmentLoadingState((prev) => ({ ...prev, [cacheKey]: 'error' }))
      return null
    }
  }, [])
  
  /**
   * Cleanup attachment cache on unmount
   */
  useEffect(() => {
    return () => {
      // Revoke all cached objectURLs on component unmount
      for (const url of attachmentCacheRef.current.values()) {
        URL.revokeObjectURL(url)
      }
      attachmentCacheRef.current.clear()
    }
  }, [])

  /**
   * Render message content, replacing attachment://{id} with images
   * For user messages, also check _localAttachments for optimistic preview
   * Uses blob URLs fetched with Authorization header
   */
  const flashCopiedButton = useCallback((buttonId) => {
    const btn = document.getElementById(buttonId)
    if (!btn) return

    btn.dataset.copied = 'true'
    window.setTimeout(() => {
      btn.dataset.copied = 'false'
    }, 1500)
  }, [])

  const writeTextToClipboard = useCallback(async (text) => {
    const value = typeof text === 'string' ? text.trim() : ''
    if (!value) {
      throw new Error('empty_clipboard_text')
    }

    if (window.isSecureContext && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value)
      return
    }

    const textArea = document.createElement('textarea')
    textArea.value = value
    textArea.setAttribute('readonly', '')
    textArea.style.position = 'fixed'
    textArea.style.top = '0'
    textArea.style.left = '0'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    textArea.focus()
    textArea.select()

    try {
      const copied = document.execCommand('copy')
      if (!copied) {
        throw new Error('clipboard_exec_command_failed')
      }
    } finally {
      document.body.removeChild(textArea)
    }
  }, [])

  const getMessageCopyText = useCallback((message) => {
    const content = typeof message?.content === 'string' ? message.content : ''
    if (!content) return ''

    let displayText = content.replace(/\n*attachment:\/\/[A-Za-z0-9_-]+/g, '').trim()

    if (!message?.is_user) {
      displayText = normalizeMarkdown(displayText)
      displayText = stripEvidenceFooter(displayText)
    }

    return displayText.trim()
  }, [])

  const handleCopyProposalContent = useCallback(async (proposal) => {
    try {
      await writeTextToClipboard(proposal?.content || '')
      flashCopiedButton(`copy-proposal-${proposal.id}`)
      toast.success('제안 내용이 복사되었습니다.')
    } catch (error) {
      console.error('Failed to copy proposal content:', error)
      toast.error('제안 내용 복사에 실패했습니다.')
    }
  }, [flashCopiedButton, writeTextToClipboard])

  const handleCopyMessageContent = useCallback(async (message) => {
    try {
      await writeTextToClipboard(getMessageCopyText(message))
      flashCopiedButton(`copy-${message.id}`)
      toast.success('답변이 복사되었습니다.')
    } catch (error) {
      console.error('Failed to copy assistant message:', error)
      toast.error('답변 복사에 실패했습니다.')
    }
  }, [flashCopiedButton, getMessageCopyText, writeTextToClipboard])

  /**
   * Render a proposal card (reused inline after each linked message)
   */
  const renderProposalCard = useCallback((proposal) => (
    <div key={proposal.id} className="w-full">
      <div className="w-full rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm space-y-2">
        {/* Header: command type + risk tier */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400">
            {proposal.command}
          </Badge>
          <Badge variant="outline" className={`text-[10px] px-1.5 py-0 h-4 ${
            proposal.risk_tier === 'auto' ? 'border-green-300 text-green-600' :
            proposal.risk_tier === 'preview' ? 'border-yellow-300 text-yellow-600' :
            'border-red-300 text-red-600'
          }`}>
            {proposal.risk_tier}
          </Badge>
          {proposal.target && (
            <span className="text-[10px] text-muted-foreground">
              대상: {typeof proposal.target === 'string' ? proposal.target : JSON.stringify(proposal.target)}
            </span>
          )}
          <span className="text-[10px] text-muted-foreground ml-auto">
            {new Date(proposal.createdAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
          </span>
        </div>

        {/* Content preview */}
        {proposal.content && (
          <pre className="text-xs bg-muted/50 rounded p-2 max-h-[120px] overflow-auto whitespace-pre-wrap font-mono">
            {proposal.content}
          </pre>
        )}

        {/* Action buttons */}
        {proposal.status === 'pending' && (
          <div className="flex gap-2">
            <Button
              size="sm"
              variant="default"
              className="h-6 text-xs px-2"
              onClick={() => {
                const applyParams = {
                  proposal,
                  editorRef,
                  onConflict: ({ message }) => {
                    toast.warning(message)
                    setPendingProposals((prev) =>
                      prev.map((p) => p.id === proposal.id ? { ...p, status: 'conflict' } : p)
                    )
                  },
                  onConfirmRequired: ({ message, onConfirm }) => {
                    setConfirmDialog({
                      open: true,
                      title: '제안 적용 확인',
                      description: message,
                      confirmText: '적용',
                      cancelText: '취소',
                      variant: 'destructive',
                      onConfirm: () => {
                        onConfirm()
                        setPendingProposals((prev) =>
                          prev.map((p) => p.id === proposal.id ? { ...p, status: 'accepted' } : p)
                        )
                      },
                    })
                  },
                  onSuccess: () => {
                    setPendingProposals((prev) =>
                      prev.map((p) => p.id === proposal.id ? { ...p, status: 'accepted' } : p)
                    )
                    toast.success('제안이 적용되었습니다.')
                  },
                  onError: ({ message }) => {
                    toast.error(message || '적용에 실패했습니다.')
                  },
                }

                if (editorPanelVisible && editorRef.current) {
                  void applyProposalWithAssets(applyParams)
                } else {
                  pendingApplyRef.current = applyParams
                  setEditorPanelVisible(true)
                }
              }}
            >
              수락
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-xs px-2"
              onClick={() => {
                setPendingProposals((prev) =>
                  prev.map((p) => p.id === proposal.id ? { ...p, status: 'rejected' } : p)
                )
              }}
            >
              거절
            </Button>
          </div>
        )}
        {proposal.status === 'accepted' && (
          <span className="text-xs text-green-600">✓ 수락됨</span>
        )}
        {proposal.status === 'rejected' && (
          <span className="text-xs text-muted-foreground line-through">거절됨</span>
        )}
        {proposal.status === 'conflict' && (
          <span className="text-xs text-orange-600">⚠ 충돌 — 문서가 변경되었습니다</span>
        )}

        {/* Copy button at bottom */}
        {proposal.content && (
          <div className="flex justify-end pt-1 border-t border-primary/10">
            <button
              onClick={() => handleCopyProposalContent(proposal)}
              id={`copy-proposal-${proposal.id}`}
              data-copied="false"
              className="group/copy rounded p-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
              title="제안 내용 복사"
            >
              <CopyIcon weight="thin" className="h-3.5 w-3.5 group-data-[copied=true]/copy:hidden" />
              <Check className="h-3.5 w-3.5 text-emerald-500 hidden group-data-[copied=true]/copy:block" />
            </button>
          </div>
        )}
      </div>
    </div>
  ), [editorPanelVisible, handleCopyProposalContent, pendingProposals])

  const renderMessageContent = useCallback((message) => {
    const content = message.content || ''

    // If this assistant message has an associated proposal (completed), show brief notice
    if (message._hasProposal && !message.is_user) {
      return (
        <div className="text-muted-foreground italic" style={{ fontSize: 'inherit' }}>
          편집기 제안이 생성되었습니다. 아래에서 확인하세요.
        </div>
      )
    }

    // If proposal is being generated (streaming), show placeholder instead of streaming content
    if (message._isProposalStreaming && message._isStreaming && !message.is_user) {
      return (
        <div className="flex items-center gap-2 text-muted-foreground italic" style={{ fontSize: 'inherit' }}>
          <CircleNotchIcon weight="thin" className="h-3.5 w-3.5 animate-spin" />
          편집기 제안을 생성중입니다...
        </div>
      )
    }
    
    // Extract attachment IDs from content
    const attachmentPattern = /attachment:\/\/([A-Za-z0-9_-]+)/g
    const attachmentIds = []
    let match
    while ((match = attachmentPattern.exec(content)) !== null) {
      attachmentIds.push(match[1])
    }
    
    // Remove attachment tokens from display text
    let displayText = content.replace(/\n*attachment:\/\/[A-Za-z0-9_-]+/g, '').trim()

    // Normalize markdown for clean rendering (CJK bold fix, zero-width cleanup, etc.)
    if (!message.is_user) {
      displayText = normalizeMarkdown(displayText)
      displayText = stripEvidenceFooter(displayText)
    }

    const showThinkingPlaceholder = !message.is_user && message._isStreaming && !displayText && attachmentIds.length === 0
    
    return (
      <>
        {displayText && (
          <div className={'prose max-w-none dark:prose-invert' + (message.is_user ? ' !text-white' : '')} style={{ fontSize: 'inherit' }}>
            {message.is_user ? displayText : <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{displayText}</ReactMarkdown>}
          </div>
        )}
        {showThinkingPlaceholder && (
          <div className="flex items-center gap-1.5 text-muted-foreground" style={{ fontSize: 'inherit' }}>
            <CircleNotchIcon weight="thin" className="h-3.5 w-3.5 animate-spin" />
            <span className="tracking-wider">...</span>
          </div>
        )}
        {attachmentIds.length > 0 && (
          <div className={`flex flex-wrap gap-2 ${displayText ? 'mt-2' : ''}`}>
            {attachmentIds.map((attId) => {
              const attachmentMeta = getAttachmentMetadata(message, attId)
              return (
                <AttachmentImage
                  key={attId}
                  sessionId={activeChatId}
                  attachmentId={attId}
                  localPreviewUrl={attachmentMeta?.previewUrl || null}
                  getAttachmentBlobUrl={getAttachmentBlobUrl}
                  attachmentLoadingState={attachmentLoadingState}
                  onActivate={(url) => handleAttachmentThumbnailClick(attachmentMeta, url)}
                />
              )
            })}
          </div>
        )}
      </>
    )
  }, [activeChatId, getAttachmentBlobUrl, attachmentLoadingState, handleAttachmentThumbnailClick])

  async function loadCurrentAIModel({ syncSelectedToCurrent = false } = {}) {
    try {
      const [currentRes, optionsRes] = await Promise.all([
        api.get('/settings/system/ai-model/current', { _silent: true }),
        api.get('/settings/system/ai-model/options', { _silent: true }).catch(() => ({ data: { models: [] } })),
      ])

      const currentModel = currentRes?.data || null
      const nextOptions = Array.isArray(optionsRes?.data?.models) ? optionsRes.data.models.filter(Boolean) : []
      const currentKey = buildChatModelKey(currentModel)
      const mergedOptions = [...nextOptions]

      if (currentModel?.configured && currentKey && !mergedOptions.some((model) => buildChatModelKey(model) === currentKey)) {
        mergedOptions.unshift(currentModel)
      }

      setCurrentAIModel(currentModel)
      setChatModelOptions(mergedOptions)
      setSelectedChatModelKey((prev) => {
        if (syncSelectedToCurrent) {
          if (currentKey && mergedOptions.some((model) => buildChatModelKey(model) === currentKey)) {
            return currentKey
          }
          return buildChatModelKey(mergedOptions[0])
        }
        if (prev && mergedOptions.some((model) => buildChatModelKey(model) === prev)) {
          return prev
        }
        if (currentKey && mergedOptions.some((model) => buildChatModelKey(model) === currentKey)) {
          return currentKey
        }
        return buildChatModelKey(mergedOptions[0])
      })
    } catch {}
  }

  async function loadPersonaSummary(roleOverride = null) {
    try {
      const resolvedRole = String(roleOverride || userRole || '').toLowerCase()
      const canReadSystemPersona = resolvedRole === 'admin' || resolvedRole === 'super_admin'
      const [userSettings, aiModelSettings] = await Promise.all([
        api.get('/auth/me/settings', { _silent: true }).then(r => r.data).catch(() => ({})),
        canReadSystemPersona
          ? api.get('/settings/system/ai-model', { _silent: true }).then(r => r.data).catch(() => ({}))
          : Promise.resolve({}),
      ])
      const userMd = userSettings.persona_custom_markdown || ''
      const adminMd = aiModelSettings.persona_default_markdown || ''

      const adminParsed = parseMarkdownToSections(adminMd)
      const userParsed = parseMarkdownToSections(userMd)

      // Build tag list: short label per filled section
      const tags = []
      for (const sec of PERSONA_SECTIONS) {
        const val = (userParsed.sections[sec.key] || '').trim() || (adminParsed.sections[sec.key] || '').trim()
        if (val) tags.push(sec.heading)
      }
      const customVal = (userParsed.customText || '').trim() || (adminParsed.customText || '').trim()
      if (customVal) tags.push('추가 지시')

      setPersonaSummary(tags)

      // Build tooltip text from sections
      const tooltipParts = []
      for (const sec of PERSONA_SECTIONS) {
        const val = (userParsed.sections[sec.key] || '').trim() || (adminParsed.sections[sec.key] || '').trim()
        if (val) tooltipParts.push(`[${sec.heading}] ${val.slice(0, 80)}${val.length > 80 ? '...' : ''}`)
      }
      const customTip = (userParsed.customText || '').trim() || (adminParsed.customText || '').trim()
      if (customTip) tooltipParts.push(`[추가 지시] ${customTip.slice(0, 80)}${customTip.length > 80 ? '...' : ''}`)
      setPersonaTooltipText(tooltipParts.join('\n') || '페르소나 미설정')
    } catch {
      setPersonaSummary([])
      setPersonaTooltipText('페르소나 미설정')
    }
  }

  async function loadEnabledMcpSkills(options = {}) {
    const { silent = false } = options
    if (!userId) return
    try {
      const data = await mcpAPI.listMyServers()
      const list = data?.servers || data || []
      const enabled = Array.isArray(list) ? list.filter((s) => s && s.user_enabled) : []
      setEnabledMcpSkills(enabled)
    } catch (e) {
      if (!silent) {
        setEnabledMcpSkills([])
      }
    }
  }

  async function loadFiles(options = {}) {
    const { silent = false } = options
    try {
      if (!silent) setFilesLoading(true)
      if (!silent) setFilesError(false)
      const data = await filesAPI.list(0, 50, uploadKbId)
      const newFiles = data.files || []
      // 실패 전이 감지 (silent polling 시에만 — 초기 로드 시에는 스냅샷만 갱신)
      if (silent) {
        detectFailureTransitions(newFiles)
      } else {
        // 초기 로드: 스냅샷만 세팅 (알림 없이)
        const initMap = new Map()
        for (const f of newFiles) {
          initMap.set(f.id, String(f.status || '').toLowerCase())
        }
        prevFileStatusMapRef.current = initMap
      }
      setFiles(newFiles)
      setFilesError(false)
    } catch (e) {
      console.error(e)
      if (!silent) setFilesError(true)
    } finally {
      if (!silent) setFilesLoading(false)
    }
  }

  useEffect(() => {
    loadFiles({ silent: true })
  }, [uploadKbId])

  async function loadMyDocFiles(options = {}) {
    const { silent = false } = options
    try {
      if (!silent) setMyDocFilesLoading(true)
      if (!silent) setMyDocFilesError(false)
      const data = await myDocumentsAPI.list(0, 50)
      setMyDocFiles(data.files || [])
      setMyDocFilesError(false)
    } catch (e) {
      console.error(e)
      if (!silent) setMyDocFilesError(true)
    } finally {
      if (!silent) setMyDocFilesLoading(false)
    }
  }

  async function loadChatSessions(options = {}) {
    const { silent = false } = options
    try {
      if (!silent) setChatsLoading(true)
      if (!silent) setChatsError(false)
      const sessions = await chatsAPI.listAllSessions()
      setChatSessions(sessions || [])
      setChatsError(false)
    } catch (e) {
      console.error(e)
      if (!silent) setChatsError(true)
    } finally {
      if (!silent) setChatsLoading(false)
    }
  }

  async function loadSegments(fileId, domain = 'analysis') {
    if (domain === 'my_documents') {
      return []
    }
    try {
      const data = await filesAPI.getSegments(fileId)
      return (data.segments || []).map((segment) => ({
        ...segment,
        file_id: segment?.file_id || fileId,
      }))
    } catch (e) {
      console.error(e)
      return []
    }
  }


  function scrollChatToBottom(behavior = 'auto') {
    try {
      if (messagesEndRef.current) {
        messagesEndRef.current.scrollIntoView({ behavior, block: 'end' })
      } else if (messagesContainerRef.current) {
        const el = messagesContainerRef.current
        el.scrollTop = el.scrollHeight
      }
    } catch (_) {}
  }

  async function loadMessages(sessionId, autoOpenDocument = false, scrollToBottomAfterLoad = false) {
    try {
      const msgs = await chatsAPI.getMessages(sessionId)
      setMessages(msgs || [])

      if (scrollToBottomAfterLoad) {
        // Ensure DOM has rendered new messages before scrolling
        requestAnimationFrame(() => requestAnimationFrame(() => scrollChatToBottom('auto')))
      }

      if (!autoOpenDocument) return

      // Clear segment selection when restoring a conversation
      setSelectedSegmentIds([])
      setFocusSegmentId(null)

      if (!msgs?.length) return
      for (let i = msgs.length - 1; i >= 0; i--) {
        const m = msgs[i]
        if (!m.selected_segments?.length) continue
        const fileId = m.selected_segments[0]?.file_id
        if (!fileId) continue

        // Open the document in viewer but don't restore segment selection
        if (fileId !== activeDocumentId) {
          openDocumentById(fileId)
        }
        break
      }
    } catch (e) {
      console.error(e)
    }
  }

  function loadUserKnowledgeDbs() {
    api.get('/knowledge-dbs').then(res => {
      const kbs = res.data || []
      setUserKnowledgeDbs(kbs)
      const allowedKbIds = new Set(kbs.map((kb) => String(kb.id)))
      // uploadKbId가 미설정이거나, 삭제된 KB를 가리키면 default KB로 리셋
      setUploadKbId(prev => {
        if (prev && kbs.some(kb => kb.id === prev)) return prev
        const defaultKb = kbs.find(kb => kb.name === 'default')
        return defaultKb?.id ?? (kbs[0]?.id || null)
      })

      setPreferredKnowledgeDb((prev) => {
        if (prev === 'none') return prev
        return allowedKbIds.has(String(prev)) ? prev : 'none'
      })

      setChatKnowledgeDbBySession((prev) => {
        let changed = false
        const next = {}
        for (const [sessionId, kbId] of Object.entries(prev)) {
          const normalized = typeof kbId === 'string' && kbId.trim() ? kbId : 'none'
          if (normalized === 'none' || allowedKbIds.has(normalized)) {
            next[sessionId] = normalized
          } else {
            changed = true
          }
        }
        return changed ? next : prev
      })
    }).catch(() => {})
  }

  function loadUploadPolicy() {
    api.get('/settings/system/upload-policy').then((res) => {
      const data = res?.data || {}
      const queueLimit = Number(data.max_queued_files_per_user ?? data.max_queued_files)
      const maxUploadBytes = Number(data.max_upload_size_bytes)
      const maxUploadSizeMb = Number(data.max_file_size_mb)
      const allowed_extensions = Array.isArray(data.allowed_extensions) && data.allowed_extensions.length > 0
        ? data.allowed_extensions.map((ext) => String(ext).toLowerCase())
        : DEFAULT_UPLOAD_POLICY.allowed_extensions
      const max_queued_files_per_user = Number.isFinite(queueLimit) && queueLimit > 0
        ? queueLimit
        : DEFAULT_UPLOAD_POLICY.max_queued_files_per_user
      const max_upload_size_bytes = Number.isFinite(maxUploadBytes) && maxUploadBytes > 0
        ? maxUploadBytes
        : (Number.isFinite(maxUploadSizeMb) && maxUploadSizeMb > 0
          ? maxUploadSizeMb * 1024 * 1024
          : DEFAULT_UPLOAD_POLICY.max_upload_size_bytes)

      setUploadPolicy({
        allowed_extensions,
        max_queued_files_per_user,
        max_upload_size_bytes,
      })
    }).catch(() => {
      setUploadPolicy(DEFAULT_UPLOAD_POLICY)
    })
  }

  useEffect(() => {
    getOrCreateProcessingHistorySessionStart()
    api.get('/auth/me').then((res) => {
      setUsername(res.data.username || '')
      setUserRole(res.data.role)
      setUserId(res.data.id)
      loadPersonaSummary(res.data.role)
      filesAPI.cleanupDrafts()
        .catch(() => {})
        .finally(() => {
          clearScratchEditorState()
        })
    }).catch(() => {})
    loadFiles()
    loadMyDocFiles()
    loadChatSessions()
    loadCurrentAIModel()
    loadUserKnowledgeDbs()
    loadUploadPolicy()
    quickActionsAPI.get().then(data => setQuickActions(data.actions || [])).catch(() => {})

    // Cleanup on unmount
    return () => {
      if (streamAbortRef.current) {
        streamAbortRef.current.abort()
        streamAbortRef.current = null
      }
    }
  }, [clearScratchEditorState])

  useEffect(() => {
    if (userId) {
      loadEnabledMcpSkills({ silent: true })
    }
  }, [userId])

  // ========== 파일 실패 전이 감지 (error notification) ==========
  // 이전 폴링 시점의 파일 상태 스냅샷 (file_id → status)
  const prevFileStatusMapRef = useRef(new Map())
  // 세션 단위 dedup: 이미 알림을 보낸 (file_id:error_code) 조합
  const notifiedFailuresRef = useRef(new Set())

  // 에러 코드별 사용자 힌트 매핑 (백엔드 ERROR_CODES와 동기화)
  const ERROR_CODE_HINTS = {
    FILES_CONVERSION_SERVICE_UNAVAILABLE: '문서 변환 서비스(document-converter) 연결 불가',
    FILES_CONVERSION_TIMEOUT: '문서 변환 시간 초과 — 파일 크기/서버 리소스 확인 필요',
    FILES_CONVERSION_FAILED: '문서 변환 실패 — 지원되지 않는 형식이거나 손상된 파일',
    FILES_ANALYSIS_SERVICE_UNAVAILABLE: '문서 분석 서비스(HURIDOCS) 연결 불가',
    FILES_ANALYSIS_TIMEOUT: '문서 분석 시간 초과 — 페이지 수/복잡도 확인 필요',
    FILES_ANALYSIS_FAILED: '문서 분석 실패 — HURIDOCS가 해당 PDF를 처리하지 못함',
    FILES_PROCESSING_TIMEOUT: '전체 처리 시간 초과',
  }

  /**
   * 파일 목록 갱신 후 실패 전이를 감지하고 알림 발행
   * @param {Array} newFiles - 최신 파일 목록
   */
  function detectFailureTransitions(newFiles) {
    const prevMap = prevFileStatusMapRef.current
    const processingStatuses = new Set(['uploading', 'queued', 'converting', 'analyzing'])

    for (const f of newFiles) {
      const prevStatus = prevMap.get(f.id)
      const curStatus = String(f.status || '').toLowerCase()

      // 전이 감지: 이전에 processing 상태였던 파일이 failed로 바뀐 경우
      if (curStatus === 'failed' && prevStatus && processingStatuses.has(prevStatus)) {
        // Skip notification for authored documents (editor-created .md files)
        const isAuthored = String(f.filename || '').toLowerCase().endsWith('.md')
        if (isAuthored) continue

        const errorCode = f.error_code || 'UNKNOWN'
        const dedupKey = `${f.id}:${errorCode}`

        // dedup: 동일 파일+에러코드 조합은 세션당 1회만 알림
        if (!notifiedFailuresRef.current.has(dedupKey)) {
          notifiedFailuresRef.current.add(dedupKey)

          const hint = ERROR_CODE_HINTS[errorCode] || ''
          const filename = f.filename || '알 수 없는 파일'
          const message = f.error_message
            ? `📄 ${filename} — ${f.error_message}`
            : `📄 ${filename} 처리 실패`

          toast.error(message, {
            error_code: errorCode,
            filename,
            hint,
            file_id: f.id,
          })
        }
      }
    }

    // 스냅샷 갱신
    const newMap = new Map()
    for (const f of newFiles) {
      newMap.set(f.id, String(f.status || '').toLowerCase())
    }
    prevFileStatusMapRef.current = newMap
  }

  // 스마트 폴링: 처리중(uploading/queued/converting/analyzing) 파일이 있을 때만 주기적으로 갱신
  const pollingRef = useRef(null)
  const isFetchingRef = useRef(false)

  useEffect(() => {
    const processingStatuses = ['uploading', 'queued', 'converting', 'analyzing']
    const hasProcessing = files.some((f) => processingStatuses.includes(String(f.status || '').toLowerCase()))

    if (hasProcessing) {
      // 폴링 시작
      if (!pollingRef.current) {
        pollingRef.current = setInterval(async () => {
          if (isFetchingRef.current) return // 중복 요청 방지
          isFetchingRef.current = true
          try {
            await loadFiles({ silent: true })
          } finally {
            isFetchingRef.current = false
          }
        }, 3000) // 3초 간격
      }
    } else {
      // 폴링 중지
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }

    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [files, uploadKbId])

  // Close file context menu on outside click / ESC
  useEffect(() => {
    if (!fileContextMenu) return

    const close = () => {
      setFileContextMenu(null)
    }

    const onKeyDown = (e) => {
      if (e.key === 'Escape') close()
    }

    document.addEventListener('click', close)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', close, true)

    return () => {
      document.removeEventListener('click', close)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', close, true)
    }
  }, [fileContextMenu])

  // ========== Editor Keyboard Shortcuts ==========
  useEffect(() => {
    const handleEditorKeyDown = (e) => {
      // Ctrl+S / Cmd+S: Save editor document
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        if (editorPanelVisible) {
          e.preventDefault()
          handleSaveEditorDocumentRef.current?.()
        }
      }
      // Ctrl+Shift+E: Toggle editor panel
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'E') {
        e.preventDefault()
        setEditorPanelVisible(prev => !prev)
      }

      // Shift+Alt+1~4: Toggle panels (1=left, 2=center, 3=editor, 4=chat)
      if (e.altKey && e.shiftKey && !e.ctrlKey && !e.metaKey) {
        const tag = document.activeElement?.tagName?.toLowerCase()
        const isEditable = tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable
        if (isEditable) return

        const panelMap = { 1: 'left', 2: 'center', 3: 'editor', 4: 'chat' }
        const keyNum = parseInt(e.code?.replace('Digit', '') || e.key)
        if (panelMap[keyNum]) {
          e.preventDefault()
          togglePanel(panelMap[keyNum])
        }
      }
    }
    document.addEventListener('keydown', handleEditorKeyDown)
    return () => document.removeEventListener('keydown', handleEditorKeyDown)
  }, [editorPanelVisible, togglePanel])


  useEffect(() => {
    let cancelled = false
    ;(async () => {
      if (!activeDocumentId) {
        setSegments([])
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
        return
      }

      setSegments([])
      setSelectedSegmentIds([])
      setFocusSegmentId(null)

      const segs = await loadSegments(activeDocumentId, activeDocumentDomain)
      if (cancelled) return
      setSegments(segs)

      if (pendingReference?.fileId === activeDocumentId) {
        if (pendingReference.focusSegmentId) {
          // 기존: segment ID 직접 지정
          setSelectedSegmentIds(pendingReference.navigateOnly ? [] : (pendingReference.segmentIds || []))
          setFocusSegmentId(pendingReference.focusSegmentId)
        } else if (pendingReference.page && segs.length > 0) {
          // RAG 출처: page+segmentType으로 정밀 매칭, fallback으로 page만 매칭
          const pRef = pendingReference
          const seg = (pRef.segmentType && segs.find(s => s.page === pRef.page && s.type === pRef.segmentType))
            || segs.find(s => s.page === pRef.page)
          setSelectedSegmentIds(pRef.navigateOnly ? [] : (seg ? [seg.id] : []))
          setFocusSegmentId(seg?.id || null)
        } else {
          setSelectedSegmentIds(pendingReference.navigateOnly ? [] : (pendingReference.segmentIds || []))
          setFocusSegmentId(pendingReference.focusSegmentId || null)
        }
        setPendingReference(null)
      } else {
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [activeDocumentId, activeDocumentDomain])

  useEffect(() => {
    if (skipNextMessageLoadRef.current) {
      skipNextMessageLoadRef.current = false
      return
    }
    setAgentStatusHistory([])
    if (activeChatId) loadMessages(activeChatId, true, true)
    else setMessages([])
  }, [activeChatId])

  // Auto-disable document-wide context when segments are selected
  useEffect(() => {
    if (selectedSegmentIds.length > 0) setIncludeDocContent(false)
  }, [selectedSegmentIds])

  // ========== Per-Chat Draft Persistence ==========
  const prevChatIdRef = useRef(null)

  // Save current draft & restore target draft on chat switch
  useEffect(() => {
    const prevId = prevChatIdRef.current
    // Save draft for the chat we're leaving
    if (prevId && userId) {
      saveDraft(userId, prevId, inputText, pendingImages)
    }
    if (preserveComposerStateOnSessionSwitchRef.current) {
      preserveComposerStateOnSessionSwitchRef.current = false
      setIncludeDocContent(false)
      prevChatIdRef.current = activeChatId
      return
    }
    // Restore draft for the chat we're entering
    if (activeChatId && userId) {
      const draft = loadDraft(userId, activeChatId)
      if (draft) {
        setInputText(draft.text || '')
        // Restore pending images from metadata (re-create minimal entries for UI)
        if (draft.attachments?.length > 0) {
          const restored = draft.attachments.map((att, idx) => ({
            localId: `restored-${activeChatId}-${att.attachmentId}-${idx}`,
            file: null, // original File not available — only metadata
            previewUrl: null, // will be fetched lazily from server
            status: 'uploaded',
            progress: 100,
            attachmentId: att.attachmentId,
            _restored: true, // marker for UI to fetch preview from server
          }))
          setPendingImages(restored)
        } else {
          setPendingImages([])
        }
      } else {
        setInputText('')
        setPendingImages([])
      }
    } else if (!activeChatId) {
      setInputText('')
      setPendingImages([])
    }
    // Reset per-message toggles on session switch (prevent cross-session leakage)
    setIncludeDocContent(false)
    prevChatIdRef.current = activeChatId
  }, [activeChatId, userId])

  useEffect(() => {
    if (!activeChatId) {
      setKnowledgeDb(preferredKnowledgeDb)
      return
    }
    setKnowledgeDb(chatKnowledgeDbBySession[activeChatId] || preferredKnowledgeDb)
  }, [activeChatId, chatKnowledgeDbBySession, preferredKnowledgeDb])

  // Debounced auto-save draft on text or images change
  useEffect(() => {
    if (!activeChatId || !userId) return
    const timer = setTimeout(() => {
      saveDraft(userId, activeChatId, inputText, pendingImages)
    }, 500)
    return () => clearTimeout(timer)
  }, [inputText, pendingImages, activeChatId, userId])

  // Prune expired/orphaned drafts on startup (once chatSessions loaded)
  useEffect(() => {
    if (!userId || chatSessions.length === 0) return
    const validIds = new Set(chatSessions.map((s) => s.id))
    pruneExpiredDrafts(userId, validIds)
  }, [userId, chatSessions])

  // Fetch preview URLs for restored draft images (no previewUrl but have attachmentId)
  useEffect(() => {
    if (!activeChatId) return
    const restoredImages = pendingImages.filter((img) => img._restored && !img.previewUrl && img.attachmentId)
    if (restoredImages.length === 0) return

    let cancelled = false
    ;(async () => {
      for (const img of restoredImages) {
        if (cancelled) break
        try {
          const blobUrl = await getAttachmentBlobUrl(activeChatId, img.attachmentId)
          if (cancelled) break
          setPendingImages((prev) =>
            prev.map((p) =>
              p.localId === img.localId ? { ...p, previewUrl: blobUrl, _restored: false } : p
            )
          )
        } catch {
          // Attachment no longer accessible — remove from pending
          if (!cancelled) {
            setPendingImages((prev) => prev.filter((p) => p.localId !== img.localId))
          }
        }
      }
    })()
    return () => { cancelled = true }
  }, [activeChatId, pendingImages, getAttachmentBlobUrl])

  // Auto-scroll when AI finishes (conversation end)
  useEffect(() => {
    const wasGenerating = prevGeneratingRef.current
    if (activeChatId && wasGenerating && !isGenerating) {
      requestAnimationFrame(() => scrollChatToBottom('smooth'))
    }
    prevGeneratingRef.current = isGenerating
  }, [isGenerating, activeChatId])

  // Auto-scroll chat to bottom when chat panel becomes visible (expand, view switch, etc.)
  useEffect(() => {
    if (chatPanelVisible && activeChatId && messages.length > 0) {
      requestAnimationFrame(() => requestAnimationFrame(() => scrollChatToBottom('auto')))
    }
  }, [chatPanelVisible])

  function logout() {
    clearNotifications()
    // Reset panel visibility & width so next login starts with default 1:2:2
    ;[LEFT_VIS_KEY, CENTER_VIS_KEY, EDITOR_VIS_KEY, CHAT_VIS_KEY,
      LEFT_WIDTH_KEY, CENTER_WIDTH_KEY, CHAT_WIDTH_KEY, EDITOR_WIDTH_KEY,
    ].forEach(k => { try { localStorage.removeItem(k) } catch {} })
    localStorage.removeItem('access_token')
    localStorage.removeItem('refresh_token')
    clearProcessingHistorySession()
    navigate('/')
  }

  function openFileContextMenu(e, file) {
    e.preventDefault()
    e.stopPropagation()
    setFileContextMenu({ x: e.clientX, y: e.clientY, file })
  }


  async function handleDeleteChatSession(sessionId) {
    const session = chatSessions.find((s) => s.id === sessionId)
    if (!session) return

    // Optimistically remove from list
    setChatSessions((prev) => prev.filter((s) => s.id !== sessionId))
    if (activeChatId === sessionId) {
      setActiveChatId(null)
      setMessages([])
    }

    try {
      await chatsAPI.deleteSession(sessionId)
      clearDraft(userId, sessionId)
      toast.success('대화가 삭제되었습니다.')
    } catch (e) {
      console.error('Failed to delete session:', e)
      // Restore on failure
      setChatSessions((prev) => [...prev, session].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at)))
      toast.error('대화 삭제에 실패했습니다.')
    }
  }

  function handleRenameChatSession(sessionId) {
    const session = chatSessions.find((s) => s.id === sessionId)
    const currentName = session?.session_name || '새 대화'
    setRenameDialog({ open: true, sessionId, value: currentName })
  }

  async function handleConfirmRename() {
    const { sessionId, value } = renameDialog
    const trimmed = value.trim()
    if (!trimmed) return
    const session = chatSessions.find((s) => s.id === sessionId)
    if (trimmed === (session?.session_name || '새 대화')) {
      setRenameDialog({ open: false, sessionId: null, value: '' })
      return
    }
    try {
      await chatsAPI.renameSession(sessionId, trimmed)
      setChatSessions((prev) => prev.map((s) => (s.id === sessionId ? { ...s, session_name: trimmed } : s)))
    } catch (e) {
      console.error('Failed to rename session:', e)
    }
    setRenameDialog({ open: false, sessionId: null, value: '' })
  }


  async function handleDeleteFile(fileId) {
    try {
      const result = await filesAPI.delete(fileId)
      const deletedSessions = result?.deleted_sessions || 0
      
      setFiles((prev) => prev.filter((f) => f.id !== fileId))
      setOpenDocuments((prev) => prev.filter((d) => d.id !== fileId))
      if (activeDocumentId === fileId) {
        setActiveDocumentId(null)
        setSegments([])
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
      }

      // Refresh chat sessions (some may have been deleted by backend)
      // Get fresh list directly from API instead of relying on state
      const freshSessions = await chatsAPI.listAllSessions()
      setChatSessions(freshSessions || [])
      
      // If current active chat was deleted, clear it
      if (activeChatId) {
        const stillExists = (freshSessions || []).find((s) => s.id === activeChatId)
        if (!stillExists) {
          setActiveChatId(null)
          setMessages([])
        }
      }
      
      // Show success toast with deleted session count
      if (deletedSessions > 0) {
        toast.success(`문서가 삭제되었습니다 (연결된 대화 ${deletedSessions}개도 삭제됨)`)
      } else {
        toast.success('문서가 삭제되었습니다')
      }
    } catch (e) {
      console.error('Failed to delete file:', e)
    }
  }
  
  async function handleDeleteFileWithImpact(file) {
    try {
      // First, get delete impact (how many sessions will be deleted)
      const impact = await filesAPI.getDeleteImpact(file.id)
      const totalSessions = impact?.total_sessions_to_delete || 0
      
      // Build confirmation message
      let description = `"${file.filename}" 문서를 삭제하시겠습니까?`
      if (totalSessions > 0) {
        description = `"${file.filename}" 문서를 삭제하면 연결된 대화 ${totalSessions}개도 함께 삭제됩니다. 계속하시겠습니까?`
      }
      
      setConfirmDialog({
        open: true,
        title: 'DOREA-XP (공개용)',
        description,
        confirmText: '삭제',
        cancelText: '취소',
        variant: 'destructive',
        onConfirm: () => handleDeleteFile(file.id),
      })
    } catch (e) {
      console.error('Failed to get delete impact:', e)
      // Fallback to simple confirmation if impact API fails
      setConfirmDialog({
        open: true,
        title: 'DOREA-XP (공개용)',
        description: `"${file.filename}" 문서를 삭제하시겠습니까?`,
        confirmText: '삭제',
        cancelText: '취소',
        variant: 'destructive',
        onConfirm: () => handleDeleteFile(file.id),
      })
    }
  }

  // ========== Multi-file Upload Queue Logic ==========
  /**
   * 업로드 큐에서 다음 파일을 처리하는 워커
   */
  async function processUploadQueue() {
    if (isUploadingRef.current) return
    
    const pending = uploadQueueRef.current.find(item => item.status === 'pending')
    if (!pending) return
    
    isUploadingRef.current = true
    const { localId, file, knowledgeDbId } = pending
    
    // 상태 업데이트: uploading
    setUploadQueue(prev => prev.map(item => 
      item.localId === localId ? { ...item, status: 'uploading', progress: 0 } : item
    ))
    uploadQueueRef.current = uploadQueueRef.current.map(item =>
      item.localId === localId ? { ...item, status: 'uploading', progress: 0 } : item
    )
    
    try {
      await filesAPI.upload(file, (progress) => {
        setUploadQueue(prev => prev.map(item =>
          item.localId === localId ? { ...item, progress } : item
        ))
      }, knowledgeDbId)
      
      // 성공
      setUploadQueue(prev => prev.map(item =>
        item.localId === localId ? { ...item, status: 'success', progress: 100 } : item
      ))
      uploadQueueRef.current = uploadQueueRef.current.map(item =>
        item.localId === localId ? { ...item, status: 'success', progress: 100 } : item
      )
      
      // 파일 목록 새로고침
      await loadFiles({ silent: true })
      
    } catch (e) {
      console.error('Upload failed:', e)
      const errorMsg = e?.response?.data?.message || '업로드 실패'
      
      setUploadQueue(prev => prev.map(item =>
        item.localId === localId ? { ...item, status: 'error', error: errorMsg } : item
      ))
      uploadQueueRef.current = uploadQueueRef.current.map(item =>
        item.localId === localId ? { ...item, status: 'error', error: errorMsg } : item
      )
      
      toast.error(`${file.name}: ${errorMsg}`)
    }
    
    isUploadingRef.current = false
    
    // 다음 대기 파일 처리
    processUploadQueue()
  }
  
  /**
   * 업로드 큐에서 완료된 항목 제거 (3초 후)
   */
  useEffect(() => {
    const completed = uploadQueue.filter(item => item.status === 'success' || item.status === 'error')
    if (completed.length === 0) return
    
    const timer = setTimeout(() => {
      setUploadQueue(prev => prev.filter(item => item.status === 'pending' || item.status === 'uploading'))
      uploadQueueRef.current = uploadQueueRef.current.filter(item => item.status === 'pending' || item.status === 'uploading')
    }, 3000)
    
    return () => clearTimeout(timer)
  }, [uploadQueue])

  function handleUploadKbChange(e) {
    const val = e.target.value
    if (val === '__new__') {
      setQuickKbName('')
      setQuickKbDialogOpen(true)
      return
    }
    setUploadKbId(val ? Number(val) : null)
  }

  async function handleQuickCreateKb() {
    const name = quickKbName.trim()
    if (!name) return
    try {
      const res = await api.post('/knowledge-dbs', { name })
      const newKb = res.data
      setQuickKbDialogOpen(false)
      loadUserKnowledgeDbs()
      setUploadKbId(newKb.id)
      toast.success(`지식베이스 : ${newKb?.name || name} 를 추가하였습니다.`)
    } catch (e) {
      const msg = e?.response?.data?.message || '생성 실패'
      toast.error(msg)
    }
  }

  function enqueueFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (!incoming.length) return

    // ─── DOREA-XP 지식DB 10개 cap 사전 검증 ───
    // 지식DB(현재 "일반문서") 보유 문서 수 + (서버 처리 중) + (로컬 큐 대기) + 이번 시도 합산 > 10 → 즉시 거절 + 모달
    const XP_KB_MAX = 10
    const kbDocCount = files.length  // analysis 도메인 파일 = KB 소속
    const localPending = uploadQueueRef.current.filter((item) => item.status === 'pending' || item.status === 'uploading').length
    const projectedTotal = kbDocCount + localPending + incoming.length
    if (projectedTotal > XP_KB_MAX) {
      setConfirmDialog({
        open: true,
        title: '지식DB 한도 초과',
        description: `일반문서 지식DB는 최대 ${XP_KB_MAX}개 문서까지 보관할 수 있습니다.\n현재 ${kbDocCount}개 + 대기 ${localPending}개 + 추가 시도 ${incoming.length}개 = ${projectedTotal}개\n\n업로드를 진행하지 않습니다. 기존 문서를 삭제한 뒤 다시 시도해주세요.`,
        confirmText: '확인',
        cancelText: '',
        variant: 'destructive',
        onConfirm: () => {},
      })
      return
    }

    const allowedExtSet = new Set((uploadPolicy?.allowed_extensions || DEFAULT_UPLOAD_POLICY.allowed_extensions).map((ext) => String(ext).toLowerCase()))
    const maxQueued = uploadPolicy?.max_queued_files_per_user || DEFAULT_UPLOAD_POLICY.max_queued_files_per_user
    const maxUploadBytes = uploadPolicy?.max_upload_size_bytes || DEFAULT_UPLOAD_POLICY.max_upload_size_bytes

    const serverProcessingCount = files.filter((f) => PROCESSING_FILE_STATUSES.has(String(f.status || '').toLowerCase())).length
    const localQueueCount = uploadQueueRef.current.filter((item) => item.status === 'pending' || item.status === 'uploading').length
    const remainingSlots = Math.max(0, maxQueued - serverProcessingCount - localQueueCount)

    if (remainingSlots <= 0) {
      toast.error(`처리 대기 제한(${maxQueued}개)에 도달했습니다. 기존 처리 완료 후 다시 시도해주세요.`)
      return
    }

    const validFiles = []
    let rejectedByPolicy = 0

    for (const file of incoming) {
      const filename = String(file?.name || '').trim()
      const ext = filename.includes('.') ? `.${filename.split('.').pop().toLowerCase()}` : ''
      const contentType = String(file?.type || 'application/octet-stream').toLowerCase().split(';')[0].trim()

      if (!filename || !allowedExtSet.has(ext)) {
        rejectedByPolicy += 1
        continue
      }

      if (file.size > maxUploadBytes) {
        rejectedByPolicy += 1
        continue
      }

      const expectedMimes = UPLOAD_ALLOWED_MIMES_BY_EXT[ext]
      if (expectedMimes && contentType !== 'application/octet-stream' && !expectedMimes.has(contentType)) {
        rejectedByPolicy += 1
        continue
      }

      validFiles.push(file)
    }

    const acceptedFiles = validFiles.slice(0, remainingSlots)
    const rejectedByLimit = Math.max(0, validFiles.length - acceptedFiles.length)

    if (rejectedByPolicy > 0) {
      toast.warning(`업로드 정책(확장자/MIME/크기)에 맞지 않는 파일 ${rejectedByPolicy}개를 제외했습니다.`)
    }
    if (rejectedByLimit > 0) {
      toast.warning(`동시 처리 제한(${maxQueued}개)으로 ${rejectedByLimit}개를 제외했습니다.`)
    }

    if (!acceptedFiles.length) return

    const kbId = uploadKbId // null이면 서버에서 default KB 자동 할당
    const ts = Date.now()
    const newItems = acceptedFiles.map((file, idx) => ({
      localId: `upload_${ts}_${idx}`,
      file,
      knowledgeDbId: kbId,
      status: 'pending',
      progress: 0,
      error: null,
    }))

    setUploadQueue((prev) => [...prev, ...newItems])
    uploadQueueRef.current = [...uploadQueueRef.current, ...newItems]
    processUploadQueue()
  }

  function handleUploadDragEnter(e) {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current += 1
    setIsUploadDragActive(true)
  }

  function handleUploadDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleUploadDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) {
      setIsUploadDragActive(false)
    }
  }

  function handleUploadDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    dragDepthRef.current = 0
    setIsUploadDragActive(false)
    enqueueFiles(e.dataTransfer?.files)
  }

  async function handleUpload(e) {
    const fl = e.target.files
    if (!fl?.length) {
      if (e?.target) e.target.value = ''
      return
    }

    enqueueFiles(fl)
    if (e?.target) e.target.value = ''
  }

  async function handleDeleteMyDocument(file) {
    try {
      await myDocumentsAPI.delete(file.id)

      setOpenDocuments((prev) => prev.filter((d) => d.id !== file.id))
      if (activeDocumentId === file.id) {
        setActiveDocumentId(null)
        setSegments([])
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
      }

      if (editingDocDomain === 'my_documents' && editingMyDocFileId === file.id) {
        setEditorPanelVisible(false)
        setEditingDocDomain(null)
        setEditingMyDocFileId(null)
        setActiveEditorDocId(null)
        setActiveEditorDraftId(null)
        setEditorDocFilename(null)
        if (editorRef.current) {
          editorRef.current.setMarkdown('')
        }
      }

      await loadMyDocFiles({ silent: true })
      toast.success('내 문서가 삭제되었습니다.')
    } catch (e) {
      console.error('Failed to delete my-document:', e)
    }
  }

  async function handleCancelAnalysis(file) {
    setConfirmDialog({
      open: true,
      title: '문서분석 중단',
      description: `"${file.filename}" 문서의 분석을 중단하고 생성된 파일을 초기화하시겠습니까?`,
      confirmText: '중단',
      cancelText: '취소',
      variant: 'destructive',
      onConfirm: async () => {
        try {
          await filesAPI.cancelAnalysis(file.id)
          setOpenDocuments((prev) => prev.filter((d) => d.id !== file.id))
          if (activeDocumentId === file.id) {
            setActiveDocumentId(null)
            setSegments([])
            setSelectedSegmentIds([])
            setFocusSegmentId(null)
          }
          await loadFiles({ silent: true })
          toast.success('문서분석을 중단하고 생성 파일을 초기화했습니다.')
        } catch (e) {
          console.error('Failed to cancel analysis:', e)
        }
      },
    })
  }

  async function handlePromoteMyDocumentToAnalysis(file) {
    // ─── DOREA-XP 지식DB 10개 cap 사전 검증 ───
    const XP_KB_MAX = 10
    if (files.length >= XP_KB_MAX) {
      setConfirmDialog({
        open: true,
        title: '지식DB 한도 초과',
        description: `일반문서 지식DB는 최대 ${XP_KB_MAX}개 문서까지 보관할 수 있습니다.\n현재 ${files.length}개로 가득 차 있어 새 문서를 받을 수 없습니다.\n\n기존 문서를 삭제한 뒤 다시 시도해주세요.`,
        confirmText: '확인',
        cancelText: '',
        variant: 'destructive',
        onConfirm: () => {},
      })
      return
    }
    const selectedKnowledgeDbId = uploadKbId || null
    try {
      await myDocumentsAPI.promoteToAnalysis(file.id, selectedKnowledgeDbId)

      setOpenDocuments((prev) => prev.filter((d) => d.id !== file.id))
      if (activeDocumentId === file.id) {
        setActiveDocumentId(null)
        setSegments([])
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
      }

      if (editingMyDocFileId === file.id) {
        setEditingMyDocFileId(null)
        setEditingDocDomain(null)
        setActiveEditorDocId(null)
        setActiveEditorDraftId(null)
        setEditorDocFilename(null)
        if (editorRef.current) {
          editorRef.current.setMarkdown('')
        }
        toast.info('편집 중인 문서가 지식베이스로 이동되어 편집기를 초기화합니다.')
      }

      await Promise.all([
        loadMyDocFiles({ silent: true }),
        loadFiles({ silent: true }),
      ])
      toast.success('지식베이스로 이동되었습니다.')
    } catch (e) {
      console.error('Failed to promote my-document to analysis:', e)
    }
  }

  async function handleDownloadMyDocument(file) {
    try {
      const { blob, filename } = await myDocumentsAPI.downloadOriginal(file.id)
      const objectUrl = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = objectUrl
      link.download = filename || file.filename || 'download'
      document.body.appendChild(link)
      link.click()
      document.body.removeChild(link)
      URL.revokeObjectURL(objectUrl)
    } catch (e) {
      console.error('Failed to download my-document:', e)
      toast.error('원본 파일 다운로드에 실패했습니다.')
    }
  }

  async function handleMoveAnalysisFileToMyDocuments(file) {
    try {
      await myDocumentsAPI.moveToMyDocuments(file.id)
      setFiles((prev) => prev.filter((item) => item.id !== file.id))
      setOpenDocuments((prev) => prev.filter((d) => d.id !== file.id))
      if (activeDocumentId === file.id) {
        setActiveDocumentId(null)
        setSegments([])
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
      }
      await Promise.all([
        loadFiles({ silent: true }),
        loadMyDocFiles({ silent: true }),
      ])
      toast.success('내문서로 이동되었습니다.')
    } catch (e) {
      const status = e?.response?.status
      const errorCode = e?.response?.data?.error_code
      if (status === 409 || errorCode === 'FILES_ALREADY_PROCESSING') {
        toast.error('파일 처리 중에는 내문서로 이동할 수 없습니다.')
        return
      }
      console.error('Failed to move analysis file to my-documents:', e)
      toast.error('내문서로 이동하지 못했습니다.')
    }
  }

  async function handleEditMyDocument(file) {
    if (!isMarkdownMyDocument(file)) return

    try {
      requestedEditorKindRef.current = 'markdown'
      const data = await myDocumentsAPI.getContent(file.id)
      const markdown = data?.content || ''

      setEditorPanelVisible(true)
      setActiveEditorKind('markdown')
      setActiveEditorDocId(file.id)
      setActiveEditorDraftId(null)
      setEditorDocFilename(file.filename || `${file.id}.md`)
      setEditingDocDomain('my_documents')
      setEditingMyDocFileId(file.id)
      setViewerStateByDocId((prev) => ({
        ...prev,
        [file.id]: { markdown, updatedAt: Date.now() }
      }))

      let attempts = 0
      const maxAttempts = 50
      const intervalId = setInterval(() => {
        attempts += 1
        if (editorRef.current) {
          editorRef.current.setMarkdown(markdown)
          editorRef.current.focus?.()
          clearInterval(intervalId)
        } else if (attempts >= maxAttempts) {
          clearInterval(intervalId)
          toast.error('에디터 로딩 시간이 초과되었습니다. 다시 시도해주세요.')
        }
      }, 100)
    } catch (e) {
      console.error('Failed to load my-document content:', e)
    }
  }

  function handleMyDocUploadDragEnter(e) {
    e.preventDefault()
    e.stopPropagation()
    myDocDragDepthRef.current += 1
    setIsMyDocUploadDragActive(true)
  }

  function handleMyDocUploadDragOver(e) {
    e.preventDefault()
    e.stopPropagation()
  }

  function handleMyDocUploadDragLeave(e) {
    e.preventDefault()
    e.stopPropagation()
    myDocDragDepthRef.current = Math.max(0, myDocDragDepthRef.current - 1)
    if (myDocDragDepthRef.current === 0) {
      setIsMyDocUploadDragActive(false)
    }
  }

  async function uploadMyDocuments(fileList) {
    const incoming = Array.from(fileList || [])
    if (!incoming.length) return

    setIsMyDocUploading(true)
    let successCount = 0

    for (const file of incoming) {
      try {
        await myDocumentsAPI.upload(file, () => {})
        successCount += 1
      } catch (e) {
        const msg = e?.response?.data?.message || '업로드 실패'
        toast.error(`${file.name}: ${msg}`)
      }
    }

    if (successCount > 0) {
      await loadMyDocFiles({ silent: true })
      toast.success(`${successCount}개 파일 업로드 완료`)
    }

    setIsMyDocUploading(false)
  }

  async function handleMyDocUploadDrop(e) {
    e.preventDefault()
    e.stopPropagation()
    myDocDragDepthRef.current = 0
    setIsMyDocUploadDragActive(false)
    await uploadMyDocuments(e.dataTransfer?.files)
  }

  async function handleMyDocUpload(e) {
    const fl = e.target.files
    if (!fl?.length) {
      if (e?.target) e.target.value = ''
      return
    }
    await uploadMyDocuments(fl)
    if (e?.target) e.target.value = ''
  }

  async function handleReprocessFile(fileId, _analysisProvider) {
    try {
      await filesAPI.reprocess(fileId, { analysisProvider: 'opendataloader' })
      for (const key of notifiedFailuresRef.current) {
        if (key.startsWith(`${fileId}:`)) notifiedFailuresRef.current.delete(key)
      }
      toast.info('OpenDataLoader 로 재분석을 시작했습니다', { noHistory: true })
      await loadFiles({ silent: true })
    } catch (e) {
      const errorCode = e?.response?.data?.error_code
      if (errorCode === 'FILES_ALREADY_PROCESSING') {
        toast.info('파일이 이미 처리 중입니다')
      } else {
        console.error('Failed to reprocess file:', e)
      }
    }
  }

  async function openReprocessDialog(file) {
    let provider = normalizeAnalysisProvider(file?.analysis_provider)
    if (!file?.analysis_provider) {
      try {
        provider = normalizeAnalysisProvider((await settingsPublicAPI.getAnalysisProvider())?.provider)
      } catch {}
    }

    setReprocessDialog({
      open: true,
      fileId: file?.id || null,
      filename: file?.filename || '',
      provider,
    })
  }

  async function handleConfirmReprocess() {
    if (!reprocessDialog.fileId) return
    const { fileId, provider } = reprocessDialog
    setReprocessDialog((prev) => ({ ...prev, open: false }))
    await handleReprocessFile(fileId, provider)
  }

  function handleOpenDocument(file) {
    const resolvedDomain = file.domain || (myDocFiles.some((item) => item.id === file.id) ? 'my_documents' : 'analysis')
    const status = String(file?.status || '').trim().toLowerCase()
    const isAnalyzingAnalysisDocument = resolvedDomain === 'analysis' && status === 'analyzing'

    if (resolvedDomain === 'analysis' && status !== 'completed') {
      if (isAnalyzingAnalysisDocument) {
        toast.info('분석이 진행중인 문서입니다.')
      } else {
        setConfirmDialog({
          open: true,
          title: '알림',
          description: '문서분석이 완료된 문서만 볼 수 있습니다.\n문서분석을 진행할까요?',
          confirmText: '예',
          cancelText: '아니오',
          variant: 'default',
          onConfirm: () => {
            void openReprocessDialog(file)
          },
        })
        return
      }
    }

    if (!openDocuments.find((d) => d.id === file.id)) {
      setOpenDocuments((prev) => [
        ...prev,
        {
          id: file.id,
          name: file.filename,
          domain: resolvedDomain,
        },
      ])
    }
    setActiveDocumentId(file.id)
    if (!centerPanelVisible) setCenterPanelVisible(true)
  }

  function openDocumentById(fileId, domainHint = 'analysis') {
    if (!fileId) return
    if (!openDocuments.find((d) => d.id === fileId)) {
      const f = files.find((x) => x.id === fileId)
      const myDoc = myDocFiles.find((x) => x.id === fileId)
      setOpenDocuments((prev) => [
        ...prev,
        {
          id: fileId,
          name: f?.filename || myDoc?.filename || '문서',
          domain: myDoc ? 'my_documents' : domainHint,
        },
      ])
    }
    setActiveDocumentId(fileId)
    if (!centerPanelVisible) setCenterPanelVisible(true)
  }

  function handleCloseDocument(docId, e) {
    if (e) e.stopPropagation()
    setOpenDocuments((prev) => prev.filter((d) => d.id !== docId))
    if (activeDocumentId === docId) {
      // Switch to next open document or null
      const remaining = openDocuments.filter((d) => d.id !== docId)
      setActiveDocumentId(remaining.length > 0 ? remaining[0].id : null)
      if (remaining.length === 0) {
        setSegments([])
        setSelectedSegmentIds([])
        setFocusSegmentId(null)
      }
    }
  }

  async function ensureChatSession() {
    if (activeChatId || !activeDocumentId) return

    try {
      const newSession = await getOrCreateSession(activeDocumentId)
      setChatSessions((prev) => prev.some(x => x.id === newSession.id) ? prev : [newSession, ...prev])
      bindCurrentKnowledgeDbToSession(newSession.id)
      skipNextMessageLoadRef.current = true
      setActiveChatId(newSession.id)
      setActiveWorkspaceTab('chat')
    } catch (e) {
      console.error(e)
    }
  }

  function handleSegmentClick(segId, isMulti) {
    // (1) 대화창이 안열려있으면: 세그먼트 선택 시 새 대화 자동 생성
    ensureChatSession()

    if (isMulti) {
      setSelectedSegmentIds((prev) => (prev.includes(segId) ? prev.filter((id) => id !== segId) : [...prev, segId]))
    } else {
      setSelectedSegmentIds([segId])
    }
  }

  function handleSegmentReferenceClick(selectedSegments, focusSegmentIdOverride = null) {
    if (!selectedSegments?.length) return
    const fileId = selectedSegments[0]?.file_id
    const segIds = selectedSegments.map((s) => s.id).filter(Boolean)
    const focusId = focusSegmentIdOverride && segIds.includes(focusSegmentIdOverride)
      ? focusSegmentIdOverride
      : (segIds[0] || null)
    if (!fileId) return
    const selectedIds = focusId ? [focusId] : segIds

    // (2) 클릭하면 해당 문서 + 해당 지점으로 이동
    if (fileId === activeDocumentId) {
      setSelectedSegmentIds(selectedIds)
      setFocusSegmentId(focusId)
    } else {
      setPendingReference({ fileId, segmentIds: selectedIds, focusSegmentId: focusId })
      openDocumentById(fileId)
    }
  }

  function handleAttachmentThumbnailClick(attachment, blobUrl) {
    const reference = normalizeAttachmentReference(attachment?.reference)
    if (!reference) {
      setLightboxImage({ url: blobUrl, alt: '첨부 이미지' })
      return
    }

    const selectedIds = reference.segment_ids.length > 0
      ? reference.segment_ids
      : (reference.focus_segment_id ? [reference.focus_segment_id] : [])

    if (reference.file_id === activeDocumentId) {
      if (selectedIds.length === 0 && reference.page) {
        const matchedSegment = (reference.segment_type && segments.find((segment) => segment.page === reference.page && segment.type === reference.segment_type))
          || segments.find((segment) => segment.page === reference.page)
        setSelectedSegmentIds(matchedSegment ? [matchedSegment.id] : [])
        setFocusSegmentId(matchedSegment?.id || null)
        return
      }
      setSelectedSegmentIds(selectedIds)
      setFocusSegmentId(reference.focus_segment_id || selectedIds[0] || null)
      return
    }

    setPendingReference({
      fileId: reference.file_id,
      segmentIds: selectedIds,
      focusSegmentId: reference.focus_segment_id || selectedIds[0] || null,
      page: reference.page,
      segmentType: reference.segment_type,
      navigateOnly: false,
    })
    openDocumentById(reference.file_id)
  }

  function isImagePreviewableRagSource(source) {
    const segmentType = String(source?.segment_type || '').trim().toLowerCase()
    return ['picture', 'image', 'figure', 'photo', 'table'].includes(segmentType)
  }

  function handleRagSourceClick(source) {
    const fileId = String(source?.file_id || '').trim()
    if (!fileId) return
    const navigateOnly = false

    const resolveSegment = (segmentList) => {
      if (!Array.isArray(segmentList) || segmentList.length === 0) return null

      const segId = String(source?.seg_id || '').trim()
      if (segId) {
        return segmentList.find((segment) => segment.id === segId) || null
      }

      const page = Number(source?.page || 0)
      const segmentType = String(source?.segment_type || '').trim()
      return (segmentType && segmentList.find((segment) => segment.page === page && segment.type === segmentType))
        || segmentList.find((segment) => segment.page === page)
        || null
    }

    const nextReference = {
      fileId,
      segmentIds: navigateOnly ? [] : (source?.seg_id ? [String(source.seg_id)] : []),
      focusSegmentId: source?.seg_id ? String(source.seg_id) : null,
      page: Number(source?.page || 0) || null,
      segmentType: String(source?.segment_type || '').trim() || null,
      navigateOnly,
    }

    if (fileId === activeDocumentId) {
      const matchedSegment = resolveSegment(segments)
      setSelectedSegmentIds(navigateOnly ? [] : (matchedSegment ? [matchedSegment.id] : []))
      setFocusSegmentId(matchedSegment?.id || null)
      return
    }

    setPendingReference(nextReference)
    openDocumentById(fileId)
  }

  const handleNewChat = async () => {
    if (isGenerating) return
    setIsCreatingSession(true)
    try {
      const s = await getOrCreateSession(activeDocumentId || null)
      setChatSessions((prev) => [s, ...prev])
      bindCurrentKnowledgeDbToSession(s.id)
      setActiveChatId(s.id)
      setActiveWorkspaceTab('chat')
    } catch (e) {
      console.error(e)
    } finally {
      setIsCreatingSession(false)
    }
  }

  /**
   * Quick action handlers — works with segments, images, or document-wide context
   * @param {string} action — quick action ID
   */
  const handleQuickAction = async (action) => {
    if (isGenerating) return
    const includeDocumentContentForSend = includeDocContent && selectedSegmentIds.length === 0
    const selectedSegmentData = buildSelectedSegmentData()

    // Check if AI model is configured
    if (!effectiveChatModel?.configured) {
      toast.warning('AI 모델이 설정되지 않았습니다. 설정에서 모델을 선택해주세요.')
      return
    }

    // Check if there are pending images still uploading
    const stillUploading = pendingImages.some((img) => img.status === 'uploading')
    if (stillUploading) {
      toast.info('이미지 업로드 중입니다. 잠시만 기다려주세요.')
      return
    }

    // Ensure chat session exists
    let sessionId = activeChatId
    if (!sessionId) {
      try {
        const newSession = await getOrCreateSession(activeDocumentId || null)
        setChatSessions((prev) => prev.some(x => x.id === newSession.id) ? prev : [newSession, ...prev])
        bindCurrentKnowledgeDbToSession(newSession.id)
        skipNextMessageLoadRef.current = true
        setActiveChatId(newSession.id)
        setActiveWorkspaceTab('chat')
        sessionId = newSession.id
      } catch (e) {
        console.error('Failed to create chat session:', e)
        return
      }
    }

    const selectedAction = quickActions.find(a => a.id === action)
    if (!selectedAction?.prompt) {
      toast.warning('빠른 메뉴 프롬프트를 찾을 수 없습니다. 설정에서 확인해주세요.')
      return
    }

    // Build prompt — append attachment tokens if images are pending
    let uploadedImages = pendingImages.filter((img) => img.status === 'uploaded' && img.attachmentId)
    let promptText = selectedAction.prompt

    await preloadSegmentPreviews(selectedSegmentData, { force: true })

    try {
      const selectedSegmentAttachments = await materializeSelectedSegmentAttachments(sessionId, selectedSegmentData)
      uploadedImages = [...uploadedImages, ...selectedSegmentAttachments]
    } catch (error) {
      console.error('Failed to materialize selected image segments for quick action:', error)
      toast.error(error?.message || '선택한 이미지 세그먼트를 첨부하지 못했습니다.')
      return
    }

    if (uploadedImages.length > 0) {
      const attachmentTokens = uploadedImages.map((img) => `attachment://${img.attachmentId}`).join(' ')
      promptText = `${promptText}\n\n${attachmentTokens}`
      if (!isVisionCapable) {
        toast.info('비전 모델이 아니어서 AI가 이미지를 인식하지 못할 수 있습니다.', { duration: 4000 })
      }
    }

    // For optimistic UI, show the message with pending image previews
    const optimisticAttachments = uploadedImages.map((img) => ({
      attachmentId: img.attachmentId,
      previewUrl: img.previewUrl,
      reference: img.attachmentMeta?.reference || null,
    }))

    setIsGenerating(true)
    setAgentStatus({ status: 'thinking', message: '빠른 작업을 처리중입니다...', toolName: '', serverName: '' })

    if (knowledgeDb && knowledgeDb !== 'none') {
      setActiveLabel('rag')
      clearTimeout(activeLabelTimerRef.current)
      activeLabelTimerRef.current = setTimeout(() => setActiveLabel(null), 3000)
    }

    // Add user message immediately
    const userMsgId = Date.now()
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        content: promptText,
        is_user: true,
        selected_segments: selectedSegmentData,
        _localAttachments: optimisticAttachments,
      }
    ])

    // Clear pending images after quick action (don't revoke URLs — used in optimistic UI)
    if (uploadedImages.length > 0) {
      setPendingImages([])
    }

    // Clear persisted draft for this chat
    clearDraft(userId, sessionId)

    // Create empty assistant message for streaming
    const assistantMsgId = userMsgId + 1
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        content: '',
        is_user: false,
        _isStreaming: true
      }
    ])

    // Scroll to bottom for streaming
    requestAnimationFrame(() => scrollChatToBottom('smooth'))

    // Start SSE streaming
    streamAbortRef.current = chatsAPI.sendMessageStream(
      sessionId,
      promptText,
      selectedSegmentData,
      {
        onStart: () => {
          setAgentStatus({ status: 'thinking', message: '생각중입니다...', toolName: '', serverName: '' })
        },
        onDelta: (data) => {
          const delta = data.delta || ''
          setAgentStatus(prev => prev.status === 'streaming' ? prev : { status: 'streaming', message: '응답을 작성중입니다...', toolName: '', serverName: '' })
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId && !m._hasProposal
                ? { ...m, content: m.content + delta }
                : m
            )
          )
          requestAnimationFrame(() => scrollChatToBottom('auto'))
        },
        onDone: async (data) => {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: data.content || m.content,
                    model_used: data.model,
                    tokens_used: data.tokens,
                    _isStreaming: false,
                    _ragUsed: data.rag_used || false,
                    _ragSources: data.rag_sources || [],
                  }
                : m
            )
          )
          setIsGenerating(false)
          setAgentStatus({ status: 'idle', message: '', toolName: '', serverName: '' })
          setSegmentPreviewDismissed(true)
          streamAbortRef.current = null
          await loadChatSessions({ silent: true })
        },
        onError: (data) => {
          const errorMsg = data.message || '응답 생성 중 오류가 발생했습니다.'
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: `오류: ${errorMsg}`, _isStreaming: false, _isError: true }
                : m
            )
          )
          setIsGenerating(false)
          setAgentStatus({ status: 'idle', message: '', toolName: '', serverName: '' })
          streamAbortRef.current = null
          toast.error(errorMsg)
        },
        onToolUse: (data) => {
          const toolName = data.tool_name || data.name || ''
          const serverName = data.server_name || ''
          setAgentStatus({ status: 'tool_use', message: `MCP ${serverName || toolName}을(를) 활용하여 처리중입니다...`, toolName, serverName })
        },
        onToolResult: (data) => {
          setAgentStatus({ status: 'thinking', message: '도구 결과를 분석중입니다...', toolName: '', serverName: '' })
        },
      },
      knowledgeDb,
      false, // memoryTempOff (memory feature removed)
      mcpActive ? enabledMcpSkills : null, // MCP 토글이 켜져있을 때만 도구 전달
      null, // editorCommand
      'document',
      activeDocumentId
        ? {
            type: 'document',
            document_id: activeDocumentId,
            document_name: openDocuments.find(d => d.id === activeDocumentId)?.name || files.find(f => f.id === activeDocumentId)?.filename || null,
            current_page: viewerPage.page,
            total_pages: viewerPage.totalPages,
          }
        : null,
      selectedSegmentData.length > 0 ? false : includeDocumentContentForSend,
      effectiveChatModel ? { provider: effectiveChatModel.type, model: effectiveChatModel.model } : null
    )

    // Clear segment selection after action
  }

  // ========== Authored Asset Image Resolution ==========
  const handleResolveImageSrc = useCallback(async (src) => {
    const parsed = filesAPI.parseAuthoredAssetPath(src)
    if (!parsed) return null
    try {
      const blob = activeEditorDocId
        ? await filesAPI.fetchAuthoredAssetBlob(activeEditorDocId, parsed.assetName)
        : null
      if (!blob) return null
      return URL.createObjectURL(blob)
    } catch (err) {
      console.error('[MainShell] Failed to resolve asset:', src, err)
      return null
    }
  }, [activeEditorDocId])

  // ========== Editor Image Insert Handler ==========
  const handleEditorImageInsert = useCallback(async (file) => {
    const allowedMimes = new Set(['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'image/gif'])
    if (!allowedMimes.has(file.type)) {
      toast.error('이미지 파일만 삽입할 수 있습니다. (PNG, JPEG, WebP, GIF)')
      throw new Error('Invalid MIME type')
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error('이미지 크기가 5MB를 초과합니다.')
      throw new Error('File too large')
    }
    const fileId = await ensureEditorDocument()
    const result = await filesAPI.uploadAuthoredAsset(fileId, file)
    return {
      ...result,
      fileId,
      imageUrl: result?.asset_name ? `./assets/${result.asset_name}` : '',
      altText: file.name?.replace(/\.[^.]+$/, '') || 'image',
    }
  }, [ensureEditorDocument])

  const handleInsertCapturedImageIntoEditor = useCallback(async (file) => {
    if (!file) return

    setEditorPanelVisible(true)

    const uploadResult = await handleEditorImageInsert(file)
    const fileId = uploadResult?.fileId || activeEditorDocId || await ensureEditorDocument()
    const imageMarkdown = uploadResult?.markdown || ''
    if (!imageMarkdown) {
      throw new Error('Image markdown unavailable')
    }

    const currentMarkdown = editorRef.current?.getMarkdown?.() || ''
    const trimmedCurrent = currentMarkdown.trimEnd()
    const nextMarkdown = trimmedCurrent
      ? `${trimmedCurrent}\n\n${imageMarkdown}`
      : imageMarkdown

    if (editorRef.current) {
      editorRef.current.setMarkdown(nextMarkdown)
      editorRef.current.focus?.()
    }

    setViewerStateByDocId((prev) => ({
      ...prev,
      [fileId]: { markdown: nextMarkdown, updatedAt: Date.now() },
    }))
  }, [activeEditorDocId, ensureEditorDocument, handleEditorImageInsert])

  const materializeProposalImageSegments = useCallback(async (proposal) => {
    const content = String(proposal?.content || '')
    const selectedSegments = Array.isArray(proposal?.metadata?.selected_segments)
      ? proposal.metadata.selected_segments.filter((seg) => seg && isNonTextSegment(seg))
      : []

    if (!content || !selectedSegments.length) return proposal

    const placeholderMatches = Array.from(content.matchAll(PROPOSAL_IMAGE_PLACEHOLDER_RE))
      .filter((match) => isProposalImagePlaceholderTarget(match[2]))

    if (!placeholderMatches.length) return proposal

    let nextContent = content
    let replacedCount = 0

    for (let index = 0; index < placeholderMatches.length; index += 1) {
      const match = placeholderMatches[index]
      const seg = selectedSegments[index]
      if (!match || !seg) break

      const segmentId = String(seg.id || seg.seg_id || '').trim()
      const fileId = String(seg.file_id || '').trim()
      if (!segmentId || !fileId) continue

      try {
        const blob = await filesAPI.fetchSegmentPreviewBlob(fileId, segmentId)
        if (!(blob instanceof Blob) || blob.size === 0) continue

        const mimeType = blob.type || 'image/png'
        const file = new File(
          [blob],
          `proposal-segment-${segmentId}${getImageExtensionFromMime(mimeType)}`,
          { type: mimeType }
        )
        const uploadResult = await handleEditorImageInsert(file)
        const imageUrl = uploadResult?.imageUrl || (uploadResult?.asset_name ? `./assets/${uploadResult.asset_name}` : '')
        if (!imageUrl) continue

        const altText = (match[1] || uploadResult?.altText || 'image').trim() || 'image'
        nextContent = nextContent.replace(match[0], `![${altText}](${imageUrl})`)
        replacedCount += 1
      } catch (error) {
        console.error('Failed to materialize proposal image segment:', error)
      }
    }

    if (replacedCount === 0) return proposal
    return {
      ...proposal,
      content: nextContent,
      metadata: {
        ...proposal.metadata,
        materialized_selected_segments: true,
      },
    }
  }, [handleEditorImageInsert])

  const applyProposalWithAssets = useCallback(async (applyParams) => {
    const conflict = checkRevisionConflict(applyParams?.proposal, applyParams?.editorRef)
    if (!conflict.ok) {
      handleProposalApply(applyParams)
      return
    }

    try {
      const enrichedProposal = await materializeProposalImageSegments(applyParams.proposal)
      handleProposalApply({ ...applyParams, proposal: enrichedProposal })
    } catch (error) {
      console.error('Failed to prepare proposal assets:', error)
      handleProposalApply(applyParams)
    }
  }, [materializeProposalImageSegments])

  // ========== Deferred Proposal Apply (race condition fix) ==========
  // When user accepts a proposal while editor panel is hidden, the editor hasn't mounted yet.
  // We store the proposal + callbacks in pendingApplyRef, show the editor panel, and this
  // effect polls for editorRef.current to become available, then applies.
  useEffect(() => {
    if (!editorPanelVisible) return
    if (!pendingApplyRef.current) return

    const pending = pendingApplyRef.current
    let attempts = 0
    const maxAttempts = 50 // 50 * 100ms = 5 seconds max wait

    const intervalId = setInterval(() => {
      attempts++
      if (editorRef.current) {
        clearInterval(intervalId)
        pendingApplyRef.current = null
        void applyProposalWithAssets(pending)
      } else if (attempts >= maxAttempts) {
        clearInterval(intervalId)
        pendingApplyRef.current = null
        toast.error('에디터 로딩 시간이 초과되었습니다. 다시 시도해주세요.')
      }
    }, 100)

    return () => clearInterval(intervalId)
  }, [applyProposalWithAssets, editorPanelVisible])

  // ========== Editor Save Handler ==========
  const [isSavingEditor, setIsSavingEditor] = useState(false)
  const [saveFilenameDialog, setSaveFilenameDialog] = useState({ open: false, value: '' })

  const handleSaveEditorDocument = useCallback(async () => {
    if (!editorRef.current) return
    const markdown = editorRef.current.getMarkdown()
    if (!markdown.trim()) {
      toast.warning('저장할 내용이 없습니다.')
      return
    }
    if (activeEditorDocId && editorDocFilename) {
      await doSaveEditorDocument(markdown, editorDocFilename)
    } else {
      setSaveFilenameDialog({ open: true, value: '' })
    }
  }, [activeEditorDocId, editorDocFilename])

  // Actual save logic (shared between new & existing)
  const doSaveEditorDocument = useCallback(async (markdown, filename, options = {}) => {
    const { silent = false } = options
    const displayName = (filename || '').trim() || 'Untitled'
    setIsSavingEditor(true)
    try {
      if (editingDocDomain === 'my_documents' && editingMyDocFileId) {
        const result = await myDocumentsAPI.saveAuthored(markdown, displayName, editingMyDocFileId)
        const savedFileId = result.file_id || editingMyDocFileId
        setActiveEditorKind('markdown')
        setActiveEditorDocId(savedFileId)
        setActiveEditorDraftId(null)
        setEditingDocDomain('my_documents')
        setEditingMyDocFileId(savedFileId)
        setViewerStateByDocId((prev) => ({
          ...prev,
          [savedFileId]: { markdown, updatedAt: Date.now() }
        }))
        setEditorDocFilename(result.filename || displayName + '.md')
        lastPersistedEditorMarkdownRef.current = markdown
        if (!silent) toast.success('문서가 저장되었습니다.')
        await loadMyDocFiles({ silent: true })
        return result
      }

      if (activeEditorDraftId && !activeEditorDocId) {
        const result = await filesAPI.commitDraft(activeEditorDraftId, markdown, displayName)
        const savedFileId = result.file_id
        setActiveEditorKind('markdown')
        setActiveEditorDocId(savedFileId)
        setActiveEditorDraftId(null)
        setEditingDocDomain('my_documents')
        setEditingMyDocFileId(savedFileId)
        setViewerStateByDocId((prev) => {
          const next = { ...prev, [savedFileId]: { markdown, updatedAt: Date.now() } }
          delete next.__scratch__
          return next
        })
        setEditorDocFilename(result.filename || displayName + '.md')
        lastPersistedEditorMarkdownRef.current = markdown
        if (!silent) toast.success('문서가 저장되었습니다.')
        await loadMyDocFiles({ silent: true })
        return result
      }

      const result = await filesAPI.saveAuthored(markdown, displayName, activeEditorDocId)
      setActiveEditorKind('markdown')
      setActiveEditorDocId(result.file_id)
      setActiveEditorDraftId(null)
      setEditingDocDomain('my_documents')
      setEditingMyDocFileId(result.file_id)
      setViewerStateByDocId((prev) => {
        const next = { ...prev, [result.file_id]: { markdown, updatedAt: Date.now() } }
        delete next.__scratch__
        return next
      })
      setEditorDocFilename(result.filename || displayName + '.md')
      lastPersistedEditorMarkdownRef.current = markdown
      if (!silent) toast.success('문서가 저장되었습니다.')
      await loadMyDocFiles({ silent: true })
      return result
    } catch (e) {
      if (!silent) toast.error('저장에 실패했습니다.')
      throw e
    } finally {
      setIsSavingEditor(false)
    }
  }, [activeEditorDocId, activeEditorDraftId, editingDocDomain, editingMyDocFileId])

  const handleConfirmSaveFilename = useCallback(() => {
    if (!editorRef.current) return
    const markdown = editorRef.current.getMarkdown()
    if (!markdown.trim()) return
    const filename = saveFilenameDialog.value.trim() || 'Untitled'
    setSaveFilenameDialog({ open: false, value: '' })
    doSaveEditorDocument(markdown, filename)
  }, [saveFilenameDialog.value, doSaveEditorDocument])

  const saveCurrentEditorDocumentBeforeSwitch = useCallback(async (nextFileId = null) => {
    if (activeEditorKind !== 'markdown') return true
    if (!editorRef.current || !activeEditorDocId) return true

    const markdown = editorRef.current.getMarkdown()
    if (!markdown.trim()) return true

    const currentFile = myDocFiles.find((item) => item.id === activeEditorDocId)
    const fallbackName = currentFile?.filename || editorDocFilename || `${activeEditorDocId}.md`

    try {
      await doSaveEditorDocument(markdown, fallbackName)
      return true
    } catch (error) {
      console.error('Failed to save current editor document before switch:', error)
      toast.error('편집 중인 MD 파일 저장에 실패했습니다.')
      return false
    }
  }, [activeEditorDocId, activeEditorKind, editorDocFilename, myDocFiles, doSaveEditorDocument])

  useEffect(() => {
    const cachedMarkdown = activeEditorDocId ? viewerStateByDocId?.[activeEditorDocId]?.markdown : ''
    if (typeof cachedMarkdown === 'string') {
      lastPersistedEditorMarkdownRef.current = cachedMarkdown
    }
  }, [activeEditorDocId, viewerStateByDocId])

  useEffect(() => {
    if (!editorPanelVisible || activeEditorKind !== 'markdown') return undefined

    const intervalId = window.setInterval(async () => {
      if (editorAutosaveInFlightRef.current || isSavingEditor) return
      if (!editorRef.current) return

      const markdown = editorRef.current.getMarkdown?.() || ''
      if (!markdown.trim()) return
      if (markdown === lastPersistedEditorMarkdownRef.current) return

      editorAutosaveInFlightRef.current = true
      try {
        await doSaveEditorDocument(markdown, editorDocFilename || 'Untitled', { silent: true })
      } catch (error) {
        console.error('Editor autosave failed:', error)
      } finally {
        editorAutosaveInFlightRef.current = false
      }
    }, 60_000)

    return () => {
      window.clearInterval(intervalId)
    }
  }, [activeEditorKind, editorPanelVisible, editorDocFilename, doSaveEditorDocument, isSavingEditor])

  const handleOpenMarkdownEditorDocument = useCallback(async (file) => {
    if (!file || !isMarkdownMyDocument(file)) return

    const canSwitch = await saveCurrentEditorDocumentBeforeSwitch(file.id)
    if (!canSwitch) return

    await handleEditMyDocument(file)
  }, [handleEditMyDocument, saveCurrentEditorDocumentBeforeSwitch])

  // Keep ref in sync for keyboard shortcut handler (avoids TDZ)
  handleSaveEditorDocumentRef.current = handleSaveEditorDocument

  // Ref to hold streaming abort controller
  const streamAbortRef = useRef(null)

  const handleSendMessage = async () => {
    const selectedSegmentData = buildSelectedSegmentData()
    const selectedImageSegments = selectedSegmentData.filter((seg) => isNonTextSegment(seg))
    if ((!inputText.trim() && pendingImages.length === 0 && selectedImageSegments.length === 0) || isGenerating) return
    const includeDocumentContentForSend = includeDocContent && selectedSegmentIds.length === 0

    // DOREA-XP RHWP minimal: "한글편집기에 ... 넣어줘" 패턴이면 백엔드 호출 없이
    // 로컬에서 처리한다. 채팅 세션도 만들지 않는다 (순수 클라이언트 작업).
    // 첨부 파일/이미지가 같이 있으면 RHWP 라우팅을 건너뛰고 일반 흐름으로 간다.
    const trimmedInput = inputText.trim()
    if (trimmedInput && pendingImages.length === 0 && selectedImageSegments.length === 0 && hasRhwpInsertIntent(trimmedInput)) {
      const insertText = extractRhwpInsertText(trimmedInput)
      if (!insertText) {
        toast.info('한글편집기에 넣을 내용을 인식하지 못했습니다.')
        return
      }
      setIsGenerating(true)
      setActiveEditorKind('rhwp')
      setHasMountedRhwpEditor(true)
      if (!editorPanelVisible) setEditorPanelVisible(true)
      setInputText('')
      const userMsgId = Date.now()
      const assistantMsgId = userMsgId + 1
      setMessages((prev) => [
        ...prev,
        { id: userMsgId, content: trimmedInput, is_user: true, selected_segments: [] },
        { id: assistantMsgId, content: '', is_user: false, _isStreaming: true },
      ])
      requestAnimationFrame(() => scrollChatToBottom('smooth'))
      try {
        // RhwpEditor lazy-mount: imperative handle은 마운트 + createEditor가 끝나야
        // 채워진다. waitReady가 등장할 때까지 짧게 폴링한다.
        const deadline = Date.now() + 15_000
        while (!rhwpEditorInstanceRef.current?.waitReady && Date.now() < deadline) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 100))
        }
        const rhwp = rhwpEditorInstanceRef.current
        if (!rhwp?.waitReady) throw new Error('한글 에디터가 초기화되지 않았습니다.')
        await rhwp.waitReady()
        // 문서가 비어 있으면 빈 HWPX 자동 로드.
        try { await rhwp.insertText(insertText) }
        catch (firstErr) {
          // wasm 호출 실패 시 흔한 원인: 문서가 아직 안 열린 상태. 빈 문서 자동 로드 후 1회 재시도.
          console.warn('[RHWP] insertText 1차 실패, 빈 문서 로드 후 재시도:', firstErr?.message || firstErr)
          const blank = await rhwpAPI.fetchBlankHwpx()
          await rhwp.loadHwpx(blank, '새 한글 문서.hwpx')
          await rhwp.insertText(insertText)
        }
        setMessages((prev) => prev.map((m) => m.id === assistantMsgId
          ? { ...m, content: '한글 에디터에 추가했습니다.', _isStreaming: false }
          : m))
      } catch (err) {
        console.error('[RHWP] insertText 실패:', err)
        setMessages((prev) => prev.map((m) => m.id === assistantMsgId
          ? { ...m, content: `한글 에디터에 추가하지 못했습니다: ${err?.message || err}`, _isStreaming: false, _isError: true }
          : m))
      } finally {
        setIsGenerating(false)
        setAgentStatus({ status: 'idle', message: '', toolName: '', serverName: '', label: '', stage: 'idle' })
      }
      return
    }

    // Auto-create session if none exists or current session is invalid
    let sessionId = activeChatId
    // Verify activeChatId still exists in the sessions list
    if (sessionId && !chatSessions.some(s => s.id === sessionId)) {
      sessionId = null
    }
    if (!sessionId) {
      try {
        const newSession = await getOrCreateSession(activeDocumentId || null)
        setChatSessions((prev) => prev.some(x => x.id === newSession.id) ? prev : [newSession, ...prev])
        bindCurrentKnowledgeDbToSession(newSession.id)
        // Skip the useEffect loadMessages — we're about to add optimistic messages
        skipNextMessageLoadRef.current = true
        setActiveChatId(newSession.id)
        setActiveWorkspaceTab('chat')
        sessionId = newSession.id
      } catch (e) {
        console.error('Failed to auto-create chat session:', e)
        toast.error('채팅 세션을 생성하지 못했습니다.')
        return
      }
    }

    // Check if there are pending images still uploading
    const stillUploading = pendingImages.some((img) => img.status === 'uploading')
    if (stillUploading) {
      toast.info('이미지 업로드 중입니다. 잠시만 기다려주세요.')
      return
    }

    // Check if AI model is configured
    if (!effectiveChatModel?.configured) {
      toast.warning('AI 모델이 설정되지 않았습니다. 설정에서 모델을 선택해주세요.')
      return
    }

    // Get uploaded attachment IDs
    let uploadedImages = pendingImages.filter((img) => img.status === 'uploaded' && img.attachmentId)

    // (3) 진행중 표시 + 입력 불가
    setIsGenerating(true)
    setAgentStatus({ status: 'thinking', message: '메시지를 처리중입니다...', toolName: '', serverName: '', label: '', stage: 'request' })

    await preloadSegmentPreviews(selectedSegmentData, { force: true })

    try {
      const selectedSegmentAttachments = await materializeSelectedSegmentAttachments(sessionId, selectedSegmentData)
      uploadedImages = [...uploadedImages, ...selectedSegmentAttachments]
    } catch (error) {
      console.error('Failed to materialize selected image segments for send:', error)
      setIsGenerating(false)
      setAgentStatus({ status: 'idle', message: '', toolName: '', serverName: '', label: '', stage: 'error' })
      toast.error(error?.message || '선택한 이미지 세그먼트를 첨부하지 못했습니다.')
      return
    }

    // Build message content with attachment:// tokens appended
    let messageContent = inputText.trim()
    if (uploadedImages.length > 0) {
      const attachmentTokens = uploadedImages.map((img) => `attachment://${img.attachmentId}`).join(' ')
      messageContent = messageContent
        ? `${messageContent}\n\n${attachmentTokens}`
        : attachmentTokens
      if (!isVisionCapable) {
        toast.info('비전 모델이 아니어서 AI가 이미지를 인식하지 못할 수 있습니다.', { duration: 4000 })
      }
    }

    setInputText('')

    // For optimistic UI, show the message with pending image previews
    const optimisticAttachments = uploadedImages.map((img) => ({
      attachmentId: img.attachmentId,
      previewUrl: img.previewUrl,
      reference: img.attachmentMeta?.reference || null,
    }))

    // Add user message immediately
    const userMsgId = Date.now()
    setMessages((prev) => [
      ...prev,
      {
        id: userMsgId,
        content: messageContent,
        is_user: true,
        selected_segments: selectedSegmentData,
        _localAttachments: optimisticAttachments // local-only field for preview
      }
    ])

    // Clear pending images (don't revoke URLs yet - they're used in optimistic UI)
    setPendingImages([])

    // Clear persisted draft for this chat (message sent successfully)
    clearDraft(userId, sessionId)

    // Capture editor context ONLY when user explicitly mentions the editor in their message.
    // 편집기 패널이 열려 있어도 일반 질문이면 editor_command를 보내지 않는다.
    let editorCommand = null
    if (hasEditorIntent(messageContent)) {
      if (editorRef.current) {
        const selection = editorRef.current.getSelection()
        const revisionHash = editorRef.current.getRevisionHash()
        const currentMarkdown = editorRef.current.getMarkdown()
        editorCommand = {
          type: 'rewrite',
          editor_kind: 'markdown',
          selected_range: selection || null,
          anchor: null,
          revision_hash: revisionHash,
          current_content_length: currentMarkdown.length,
          risk_tier: 'preview',
          capabilities: activeEditorCapabilities,
        }
      } else {
        editorCommand = {
          type: 'insert',
          editor_kind: 'markdown',
          selected_range: null,
          anchor: null,
          revision_hash: null,
          current_content_length: 0,
          risk_tier: 'preview',
          capabilities: getEditorCapabilities('markdown'),
        }
      }
    }

    // Create empty assistant message for streaming
    const assistantMsgId = userMsgId + 1
    setMessages((prev) => [
      ...prev,
      {
        id: assistantMsgId,
        content: '',
        is_user: false,
        _isStreaming: true,
        // When editorCommand is present, AI will generate a proposal — suppress delta content in chat
        _isProposalStreaming: !!editorCommand,
      }
    ])

    // Scroll to bottom for streaming
    requestAnimationFrame(() => scrollChatToBottom('smooth'))

    // Start SSE streaming
    streamAbortRef.current = chatsAPI.sendMessageStream(
      sessionId,
      messageContent,
      selectedSegmentData,
        {
          onStart: (data) => {
            clearStreamSettlingTimer()
            setAgentStatus({ status: 'thinking', message: '모델 응답을 준비중입니다...', toolName: '', serverName: '', label: '', stage: 'model_start' })
          },
          onAgentStatus: (data) => {
            if (data.stage === 'rag_ready' || data.stage === 'rag_empty') {
              setMessages((prev) =>
                prev.map((m) =>
                  m.id === assistantMsgId
                    ? {
                        ...m,
                        _ragUsed: data.rag_used || false,
                        _ragSources: Array.isArray(data.rag_sources) ? data.rag_sources : [],
                      }
                    : m
                )
              )
            }
            setAgentStatus({
              status: data.status || 'thinking',
              message: data.message || '처리중입니다...',
              toolName: data.tool_name || '',
              serverName: data.server_name || '',
              label: data.label || '',
              stage: data.stage || '',
            })
          },
          onDelta: (data) => {
            const delta = data.delta || ''
            clearStreamSettlingTimer()
            setAgentStatus((prev) => (
              prev.status === 'streaming' && prev.stage === 'streaming'
                ? prev
                : { status: 'streaming', message: '응답을 작성중입니다...', toolName: '', serverName: '', label: '', stage: 'streaming' }
            ))
            scheduleStreamSettling()
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId && !m._hasProposal
                ? { ...m, content: m.content + delta }
                : m
            )
          )
          // Auto-scroll during streaming
          requestAnimationFrame(() => scrollChatToBottom('auto'))
        },
        onDone: async (data) => {
          clearStreamSettlingTimer()
          // Finalize the assistant message
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? {
                    ...m,
                    content: data.content || m.content,
                    model_used: data.model,
                    tokens_used: data.tokens,
                    _isStreaming: false,
                    _ragUsed: data.rag_used ?? m._ragUsed ?? false,
                    _ragSources: data.rag_sources ?? m._ragSources ?? [],
                  }
                : m
            )
          )
          setIsGenerating(false)
          setAgentStatus({ status: 'idle', message: '', toolName: '', serverName: '', label: '', stage: 'done' })
          setSegmentPreviewDismissed(true)
          streamAbortRef.current = null

          // Refresh chat sessions list (for updated message_count, updated_at)
          await loadChatSessions({ silent: true })
        },
        onError: (data) => {
          clearStreamSettlingTimer()
          const errorMsg = data.message || '응답 생성 중 오류가 발생했습니다.'
          const errorCode = data.error_code || ''
          // If session was deleted/not found, reset activeChatId so next send auto-creates
          if (errorCode === 'CHATS_SESSION_NOT_FOUND' || errorMsg.includes('세션을 찾을 수 없습니다')) {
            setActiveChatId(null)
          }
          // Update assistant message with error
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId
                ? { ...m, content: `오류: ${errorMsg}`, _isStreaming: false, _isError: true }
                : m
            )
          )
          setIsGenerating(false)
          setAgentStatus({ status: 'idle', message: '', toolName: '', serverName: '', label: '', stage: 'error' })
          streamAbortRef.current = null
          toast.error(errorMsg)
        },
        onToolUse: (data) => {
          clearStreamSettlingTimer()
          const toolName = data.tool_name || data.name || ''
          const serverName = data.server_name || ''
          const server = enabledMcpSkills.find((item) => item.name === serverName)
          const label = server?.server_type === 'skill' ? 'skill' : 'mcp'
          const toolPrefix = label === 'skill' ? 'SKILL' : 'MCP'
          const targetName = server?.display_name || server?.name || serverName || toolName || '도구'
          setAgentStatus({
            status: 'tool_use',
            message: `${toolPrefix} ${targetName} 실행중입니다...`,
            toolName,
            serverName,
            label,
            stage: 'tool_use',
          })
        },
        onToolResult: (data) => {
          clearStreamSettlingTimer()
          const serverName = data.server_name || ''
          const server = enabledMcpSkills.find((item) => item.name === serverName)
          const label = server?.server_type === 'skill' ? 'skill' : serverName ? 'mcp' : ''
          setAgentStatus({ status: 'thinking', message: '도구 결과를 분석중입니다...', toolName: '', serverName: '', label, stage: 'tool_result' })
        },
        onProposal: (data) => {
          clearStreamSettlingTimer()
          setAgentStatus({ status: 'editing', message: '편집기에 넣을 내용을 정리중입니다...', toolName: '', serverName: '', label: '', stage: 'editing' })
          // Append structured proposal from SSE stream
           setPendingProposals((prev) => [...prev, {
            id: `proposal-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            type: data.proposal_type || 'edit_proposal',
            command: data.command || data.type || 'unknown',
            content: data.content || data.text || '',
            target: data.target || null,
            risk_tier: data.risk_tier || 'preview',
            revision_hash: data.revision_hash || null,
            metadata: {
              ...data,
              selected_segments: selectedSegmentData,
              editor_kind: activeEditorKind,
              editor_capabilities: activeEditorCapabilities,
            },
            status: 'pending', // pending | accepted | rejected
            createdAt: Date.now(),
            linkedMessageId: assistantMsgId, // Link proposal to the assistant message
            chatSessionId: sessionId, // Bind to chat session for filtering on session switch
          }])
           // Mark the assistant message as having a proposal (to suppress duplicate display)
          setMessages((prev) =>
            prev.map((m) =>
              m.id === assistantMsgId ? { ...m, _hasProposal: true } : m
            )
          )
          // 편집기 패널이 닫혀 있으면 자동으로 열어서 proposal을 적용할 수 있게 한다
          if (!editorPanelVisible) {
            setEditorPanelVisible(true)
          }
        },
      },
      knowledgeDb,
      false, // memoryTempOff (memory feature removed)
      mcpActive ? enabledMcpSkills : null, // MCP 토글이 켜져있을 때만 도구 전달
      editorCommand,
      'document',
      activeDocumentId
        ? {
            type: 'document',
            document_id: activeDocumentId,
            document_name: openDocuments.find(d => d.id === activeDocumentId)?.name || files.find(f => f.id === activeDocumentId)?.filename || null,
            current_page: viewerPage.page,
            total_pages: viewerPage.totalPages,
          }
        : null,
      includeDocumentContentForSend,
      effectiveChatModel ? { provider: effectiveChatModel.type, model: effectiveChatModel.model } : null
    )

  }

  function renderMyDocumentRow(file) {
    const isMarkdown = isMarkdownMyDocument(file)
    const primaryLabel = file.filename || getMarkdownFolderLabel(file)
    const sizeBytes = file.size ?? file.file_size ?? file.bytes
    const isSelected = activeDocumentId === file.id

    return (
      <ContextMenu key={file.id}>
        <ContextMenuTrigger asChild>
          <div
            role="option"
            aria-selected={isSelected}
            tabIndex={isSelected ? 0 : -1}
            className={
              'group grid grid-cols-[1fr_44px_60px_18px] items-center gap-2 px-2 h-7 cursor-pointer focus:outline-none ' +
              (isSelected
                ? 'bg-blue-500/15 dark:bg-blue-400/15'
                : 'hover:bg-muted/60')
            }
            onClick={() => {
              if (isMarkdown) {
                handleOpenMarkdownEditorDocument(file)
                return
              }
              handleOpenDocument(file)
            }}
            title={primaryLabel}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              <img src={getFileIconUrl(primaryLabel)} alt="" className="h-4 w-4 shrink-0" />
              <span className="truncate text-[13px]">{primaryLabel}</span>
            </div>
            <span className="text-[11px] text-muted-foreground truncate">{getFileTypeLabel(primaryLabel)}</span>
            <span className="text-[11px] text-muted-foreground text-right font-mono tabular-nums">
              {Number(sizeBytes) > 0 ? formatFileSize(sizeBytes) : '—'}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  className="shrink-0 rounded p-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 hover:bg-muted"
                  onClick={(e) => e.stopPropagation()}
                  title="더보기"
                >
                  <DotsThreeHorizontalIcon weight="thin" className="h-3.5 w-3.5" />
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-44">
                {isMarkdown && (
                  <DropdownMenuItem onClick={() => handleOpenMarkdownEditorDocument(file)}>
                    <PencilSimpleIcon weight="thin" className="h-6 w-6" />
                    문서편집
                  </DropdownMenuItem>
                )}
                <DropdownMenuItem onClick={() => handlePromoteMyDocumentToAnalysis(file)}>
                  <GridFourIcon weight="thin" className="h-6 w-6" />
                  지식베이스로 이동
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => handleDownloadMyDocument(file)}>
                  <ArrowCircleDownIcon weight="thin" className="h-6 w-6" />
                  다운로드
                </DropdownMenuItem>
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => handleDeleteMyDocument(file)}
                >
                  <TrashIcon weight="thin" className="h-6 w-6" />
                  삭제
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent className="w-44">
          {isMarkdown && (
            <ContextMenuItem onClick={() => handleOpenMarkdownEditorDocument(file)}>
              <PencilSimpleIcon weight="thin" className="h-6 w-6" />
              문서편집
            </ContextMenuItem>
          )}
          <ContextMenuItem onClick={() => handlePromoteMyDocumentToAnalysis(file)}>
            <GridFourIcon weight="thin" className="h-6 w-6" />
            지식베이스로 이동
          </ContextMenuItem>
          <ContextMenuItem onClick={() => handleDownloadMyDocument(file)}>
            <ArrowCircleDownIcon weight="thin" className="h-6 w-6" />
            다운로드
          </ContextMenuItem>
          <ContextMenuItem
            variant="destructive"
            onClick={() => handleDeleteMyDocument(file)}
          >
            <TrashIcon weight="thin" className="h-6 w-6" />
            삭제
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <IconContext.Provider value={{ weight: 'thin' }}>
    <div className="h-svh flex flex-col bg-background text-foreground">
      <header className="h-[80px] min-h-[80px] shrink-0 flex items-center border-b pl-0 pr-4 relative">
        {/* Left: Logo */}
        <div className="flex items-center h-full">
          <img
            src="/LOGO-DOREA-X.png"
            alt="DOREA-X logo"
            className="h-[76px] w-auto object-contain"
          />
        </div>

        {/* Center: Panel Toggle Pills — icon only, absolute center, near top */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center gap-2">
          {PANEL_TOGGLE_ITEMS.map(({ id, icon: Icon, label, iconProps }) => {
            const isOn = { left: leftPanelVisible, center: centerPanelVisible, editor: editorPanelVisible, chat: chatPanelVisible }[id]
            return (
              <button
                key={id}
                onClick={() => togglePanel(id)}
                title={`${label} 패널 ${isOn ? 'OFF' : 'ON'}`}
                className={`h-[42px] w-[42px] flex items-center justify-center rounded-full transition-colors ${isOn ? 'bg-primary/15 hover:bg-primary/25' : 'hover:bg-muted/60'} ${!isOn ? 'opacity-40 grayscale' : ''}`}
              >
                <Icon size={28} {...iconProps} />
              </button>
            )
          })}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2 ml-auto">
          <NotificationCenter buttonClassName="rounded-2xl h-11 w-11" iconClassName="size-[24px]" />
          <DarkModeToggle buttonClassName="rounded-2xl h-11 w-11" iconClassName="size-[24px]" />
           <Button variant="outline" size="icon" className="rounded-2xl h-11 w-11" onClick={() => { setSettingsInitialMenu(null); setShowSettings(true) }}>
             <GearIcon className="size-[24px]" weight="regular" />
           </Button>
           <Button
             variant="outline"
             className="rounded-2xl h-11 px-3 gap-1.5 border-rose-200 text-rose-600 hover:bg-rose-50 hover:text-rose-700 dark:border-rose-900/50 dark:text-rose-300 dark:hover:bg-rose-950/40"
             onClick={logout}
             title="로그아웃"
             aria-label="로그아웃"
           >
             <span className="font-medium">{username || `user-${userId ?? '?'}`}</span>
             <span>로그아웃</span>
             <SignOutIcon className="size-[24px]" weight="regular" />
           </Button>
        </div>
      </header>

      <div className="flex flex-1 min-h-0">
        {/* Left Panel — hidden when not visible */}
        <aside style={{ width: flexPanel === 'left' ? undefined : leftPanelWidth, display: leftPanelVisible ? undefined : 'none' }} className={`${flexPanel === 'left' ? 'flex-1 min-w-0' : 'flex-none'} border-r bg-background flex flex-col min-h-0 overflow-hidden`}>
            <div className="h-9 min-h-9 shrink-0 border-b bg-muted/30 px-3 flex items-center">
              <PanelHeaderLabel icon={HouseLineIcon} label="워크스페이스" iconProps={{ weight: 'duotone' }} />
            </div>
            <Tabs value={activeWorkspaceTab} onValueChange={setActiveWorkspaceTab} className="flex flex-col min-h-0 flex-1">
              <div className="h-[54px] min-h-[54px] px-2 border-b flex items-center gap-2">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger value="myDocuments">
                    <FileTextIcon weight="thin" className="size-6" /> 저장소
                  </TabsTrigger>
                  <TabsTrigger value="analysis">
                    <GridFourIcon weight="thin" className="size-6" /> 지식베이스
                  </TabsTrigger>
                  <TabsTrigger value="chat">
                    <ChatCircleTextIcon weight="thin" className="size-6" /> 대화기록
                  </TabsTrigger>
                </TabsList>
              </div>

              <input ref={imageInputRef} type="file" className="hidden" accept="image/png,image/jpeg,image/webp,image/gif" multiple onChange={(e) => {
                const files = Array.from(e.target.files || [])
                for (const file of files) handleCaptureImage(file)
                e.target.value = ''
              }} />

              <div className="p-3 flex flex-col gap-3 min-h-0 flex-1">
              {activeWorkspaceTab === 'myDocuments' ? (
                <>
                  <div className="flex flex-col gap-2">
                    <div
                      className={
                        'w-full h-28 rounded-md border-2 border-dashed flex items-center justify-center text-sm transition-colors cursor-pointer ' +
                        (isMyDocUploadDragActive
                          ? 'border-primary bg-primary/10 text-primary'
                          : 'border-border text-muted-foreground bg-muted/30')
                      }
                      onClick={() => myDocFileInputRef.current?.click()}
                      onDragEnter={handleMyDocUploadDragEnter}
                      onDragOver={handleMyDocUploadDragOver}
                      onDragLeave={handleMyDocUploadDragLeave}
                      onDrop={handleMyDocUploadDrop}
                    >
                      {isMyDocUploading ? '업로드 중...' : 'Drag & Drop'}
                    </div>
                    <div className="flex gap-2">
                      <Button className="w-full" onClick={() => myDocFileInputRef.current?.click()} disabled={isMyDocUploading}>
                        <UploadSimpleIcon weight="thin" className="size-6" /> 업로드
                      </Button>
                    </div>
                    <input ref={myDocFileInputRef} type="file" className="hidden" onChange={handleMyDocUpload} multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.hwp,.hwpx,.txt,.csv,.md" />
                  </div>

                  <Separator className="mx-1" />

                  {!myDocFilesLoading && !myDocFilesError && myDocFiles.length > 0 && (
                    <div className="relative px-2">
                      <MagnifyingGlassIcon weight="thin" className="absolute left-4 top-1/2 -translate-y-1/2 size-[21px] text-muted-foreground pointer-events-none" />
                      <Input
                        value={myDocFilesFilter}
                        onChange={(e) => setMyDocFilesFilter(e.target.value)}
                        placeholder="내 문서 검색..."
                        className="h-7 pl-7 pr-7 text-xs"
                      />
                      {myDocFilesFilter && (
                        <button
                          onClick={() => setMyDocFilesFilter('')}
                          className="absolute right-4 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
                        >
                          <XIcon weight="thin" className="size-[18px] text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  )}

                  {/* Explorer-style column header — click to sort */}
                  {!myDocFilesLoading && !myDocFilesError && myDocFiles.length > 0 && (
                    <div className="grid grid-cols-[1fr_44px_60px_18px] items-center gap-2 px-2 h-7 border-b bg-muted/30 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      {[
                        { field: 'filename', label: '이름' },
                        { field: 'type', label: '유형' },
                        { field: 'size', label: '크기', align: 'right' },
                      ].map((col) => {
                        const isActive = myDocSort.field === col.field
                        return (
                          <button
                            key={col.field}
                            type="button"
                            onClick={() => handleMyDocSortToggle(col.field)}
                            className={`flex items-center gap-0.5 hover:text-foreground transition-colors ${col.align === 'right' ? 'justify-end' : ''} ${isActive ? 'text-foreground' : ''}`}
                            title={`${col.label} 정렬`}
                          >
                            <span className="truncate">{col.label}</span>
                            {isActive && (
                              <ArrowUpIcon weight="thin" className={`size-3 transition-transform ${myDocSort.direction === 'desc' ? 'rotate-180' : ''}`} />
                            )}
                          </button>
                        )
                      })}
                      <span aria-hidden="true" />
                    </div>
                  )}

                  <ScrollArea className="flex-1 min-h-0">
                    <div role="listbox" aria-label="내문서 목록" onKeyDown={handleListKeyDown}>
                      {myDocFilesLoading ? (
                        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                          <CircleNotchIcon weight="thin" className="size-6 animate-spin" /> 로딩 중...
                        </div>
                      ) : myDocFilesError ? (
                        <div className="flex flex-col items-center gap-2 p-4 text-sm text-muted-foreground">
                          <WarningIcon weight="thin" className="size-[30px] text-destructive" />
                          <span>내 문서 목록을 불러오지 못했습니다.</span>
                          <Button variant="ghost" size="sm" onClick={() => loadMyDocFiles()}>
                            <ArrowClockwiseIcon weight="thin" className="size-[18px] mr-1" /> 다시 시도
                          </Button>
                        </div>
                      ) : myDocFiles.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">내 문서가 없습니다.</div>
                      ) : filteredMyDocFiles.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">검색 결과가 없습니다.</div>
                      ) : (
                        filteredMyDocFiles.map((file) => renderMyDocumentRow(file))
                      )}
                    </div>
                  </ScrollArea>
                </>
              ) : activeWorkspaceTab === 'analysis' ? (
                <>
                  <div className="flex flex-col gap-1">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground shrink-0">지식베이스명</span>
                      <select
                        value={uploadKbId ? String(uploadKbId) : ''}
                        onChange={handleUploadKbChange}
                        className="h-9 rounded-md border border-input bg-background px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring min-w-0 flex-1 truncate"
                        title="업로드할 지식베이스 선택"
                      >
                        {userKnowledgeDbs.length === 0 && <option value="">default</option>}
                        {[...userKnowledgeDbs].sort((a, b) => a.name === 'default' ? -1 : b.name === 'default' ? 1 : 0).map(kb => (
                          <option key={kb.id} value={String(kb.id)}>{kb.name}</option>
                        ))}
                        <option value="__new__">+ 새 지식베이스 추가</option>
                      </select>
                    </div>
                    <Separator className="mx-1" />
                    <div className="grid grid-cols-2 gap-2">
                      <div
                        className={
                          'w-full h-[100px] rounded-md border-2 border-dashed flex items-center justify-center text-sm transition-colors cursor-pointer text-center px-3 ' +
                          (isUploadDragActive
                            ? 'border-primary bg-primary/10 text-primary'
                            : 'border-border text-muted-foreground bg-muted/30')
                        }
                        onClick={() => fileInputRef.current?.click()}
                        onDragEnter={handleUploadDragEnter}
                        onDragOver={handleUploadDragOver}
                        onDragLeave={handleUploadDragLeave}
                        onDrop={handleUploadDrop}
                      >
                        파일을 끌어서 놓기
                      </div>
                      <Button
                        className="w-full h-[100px] text-sm justify-center text-center gap-2"
                        onClick={() => fileInputRef.current?.click()}
                      >
                        <UploadSimpleIcon weight="thin" className="size-6" />
                        <span>업로드</span>
                      </Button>
                    </div>
                    <input ref={fileInputRef} type="file" className="hidden" onChange={handleUpload} multiple accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.hwp,.hwpx,.txt,.csv,.md" />
                  </div>


                  {/* Wave 6: Light Section Divider — Upload Zone / List Zone */}
                  <Separator className="mx-1" />
                  {/* Document search filter — only show when list is ready and has items */}
                  {!filesLoading && !filesError && files.length > 0 && (
                    <div className="flex flex-col gap-2">
                      <div className="relative px-2 pb-1">
                        <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                        <Input
                          value={filesFilter}
                          onChange={(e) => setFilesFilter(e.target.value)}
                          placeholder="문서 검색..."
                          className="h-7 pl-7 pr-7 text-xs"
                        />
                        {filesFilter && (
                          <button
                            onClick={() => setFilesFilter('')}
                            className="absolute right-4 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
                          >
                            <XIcon className="size-3 text-muted-foreground" />
                          </button>
                        )}
                      </div>
                      <FileListSortControls sortState={currentAnalysisSort} onToggle={handleAnalysisSortToggle} />
                    </div>
                  )}

                  {/* Explorer-style column header — visual parity with 저장소 */}
                  {!filesLoading && !filesError && files.length > 0 && (
                    <div className="grid grid-cols-[1fr_44px_18px] items-center gap-2 px-2 h-7 border-b bg-muted/30 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                      <span className="truncate">이름</span>
                      <span className="truncate text-center">상태</span>
                      <span aria-hidden="true" />
                    </div>
                  )}

                  <ScrollArea className="flex-1 min-h-0">
                    <div role="listbox" aria-label="문서 목록" onKeyDown={handleListKeyDown}>
                      {filesLoading ? (
                        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                          <CircleNotchIcon weight="thin" className="size-4 animate-spin" /> 로딩 중...
                        </div>
                      ) : filesError ? (
                        <div className="flex flex-col items-center gap-2 p-4 text-sm text-muted-foreground">
                          <AlertTriangle className="size-5 text-destructive" />
                          <span>문서 목록을 불러오지 못했습니다.</span>
                          <Button variant="ghost" size="sm" onClick={() => loadFiles()}>
                            <ArrowClockwiseIcon weight="thin" className="size-3 mr-1" /> 다시 시도
                          </Button>
                        </div>
                      ) : files.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">문서가 없습니다.</div>
                      ) : filteredFiles.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">검색 결과가 없습니다.</div>
                      ) : (
                        filteredFiles.map((f) => {
                          const status = String(f.status || '').toLowerCase()
                          const queuePosition = f.queue_position
                          const etaSeconds = f.eta_seconds
                          const etaDisplay = etaSeconds ? `~${Math.ceil(etaSeconds)}초` : ''
                          
                          const statusLabel =
                            {
                              uploading: '업로드 중',
                              queued: queuePosition ? `대기 ${queuePosition}번째 ${etaDisplay}${etaDisplay ? ' (예상)' : ''}` : '대기열',
                              converting: '변환 중',
                              analyzing: '분석 중',
                              completed: '완료',
                              failed: f.error_message ? `실패: ${f.error_message}` : '실패',
                              none: '대기',
                            }[status] || (status || '상태 없음')

                          const StatusIcon =
                            status === 'completed'
                              ? CheckCircleIcon
                              : status === 'failed'
                                ? AlertTriangle
                                : status === 'queued'
                                  ? CircleNotchIcon  // 대기열도 스피너 사용 (느린 속도)
                                  : CircleNotchIcon

                          const badgeVariant =
                            status === 'completed'
                              ? 'secondary'
                              : status === 'failed'
                                ? 'destructive'
                                : 'outline'
                          const disableAnalysisContextActions = ['uploading', 'queued', 'converting', 'analyzing'].includes(status)
                          const isAnalyzing = status === 'analyzing'

                          return (
                            <ContextMenu key={f.id}>
                              <ContextMenuTrigger asChild>
                                <div
                                  role="option"
                                  aria-selected={activeDocumentId === f.id}
                                  tabIndex={activeDocumentId === f.id ? 0 : -1}
                                  className={
                                    'group grid grid-cols-[1fr_44px_18px] items-center gap-2 px-2 h-7 cursor-pointer focus:outline-none ' +
                                    (activeDocumentId === f.id
                                      ? 'bg-blue-500/15 dark:bg-blue-400/15'
                                      : 'hover:bg-muted/60')
                                  }
                                  onClick={() => handleOpenDocument(f)}
                                >
                                  <div className="flex items-center gap-1.5 min-w-0" title={getAnalysisTooltipText(f)}>
                                    <img src={getFileIconUrl(f.filename)} alt="" className="h-4 w-4 shrink-0" />
                                    <span className="truncate text-[13px]">{f.filename}</span>
                                  </div>

                                  <div
                                    className={
                                      'flex items-center justify-center ' + (
                                        status === 'completed'
                                          ? 'text-emerald-600'
                                          : status === 'failed'
                                            ? 'text-destructive'
                                            : 'text-muted-foreground'
                                      )
                                    }
                                    title={statusLabel}
                                  >
                                    <StatusIcon
                                      className={
                                        'h-4 w-4 ' +
                                        (status === 'uploading' || status === 'converting' || status === 'analyzing'
                                          ? 'animate-spin'
                                          : status === 'queued'
                                            ? 'animate-spin opacity-50'
                                            : '')
                                      }
                                    />
                                  </div>

                                  <DropdownMenu>
                                    <DropdownMenuTrigger asChild>
                                      <button
                                        className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
                                        onClick={(e) => e.stopPropagation()}
                                        title="더보기"
                                      >
                                        <DotsThreeHorizontalIcon weight="thin" className="h-4 w-4" />
                                      </button>
                                    </DropdownMenuTrigger>
                                    <DropdownMenuContent align="end" className="w-36">
                                      {(status === 'completed' || status === 'failed') && (
                                        <DropdownMenuItem
                                          onClick={async () => {
                                            await openReprocessDialog(f)
                                          }}
                                        >
                                          <ArrowClockwiseIcon weight="thin" className="h-4 w-4" />
                                          재분석
                                        </DropdownMenuItem>
                                      )}
                                      {isAnalyzing && (
                                        <DropdownMenuItem
                                          variant="destructive"
                                          onClick={() => handleCancelAnalysis(f)}
                                        >
                                          <Trash2 className="h-4 w-4" />
                                          분석중단
                                        </DropdownMenuItem>
                                      )}
                                      <DropdownMenuItem
                                        disabled={disableAnalysisContextActions}
                                        onClick={() => handleMoveAnalysisFileToMyDocuments(f)}
                                      >
                                        <FileTextIcon weight="thin" className="h-6 w-6" />
                                        내문서로 이동
                                      </DropdownMenuItem>
                                      <DropdownMenuItem
                                        disabled={disableAnalysisContextActions}
                                        variant="destructive"
                                        onClick={() => handleDeleteFileWithImpact(f)}
                                      >
                                        <Trash2 className="h-4 w-4" />
                                        삭제
                                      </DropdownMenuItem>
                                    </DropdownMenuContent>
                                  </DropdownMenu>
                                </div>
                              </ContextMenuTrigger>
                              <ContextMenuContent>
                                {(status === 'completed' || status === 'failed') && (
                                  <ContextMenuItem
                                    onClick={async () => {
                                      await openReprocessDialog(f)
                                    }}
                                  >
                                    <ArrowClockwiseIcon weight="thin" className="h-4 w-4" />
                                    재분석
                                  </ContextMenuItem>
                                )}
                                {isAnalyzing && (
                                  <ContextMenuItem
                                    variant="destructive"
                                    onClick={() => handleCancelAnalysis(f)}
                                  >
                                    <Trash2 className="h-4 w-4" />
                                    분석중단
                                  </ContextMenuItem>
                                )}
                                <ContextMenuItem disabled={disableAnalysisContextActions} onClick={() => handleMoveAnalysisFileToMyDocuments(f)}>
                                    <FileTextIcon weight="thin" className="h-6 w-6" />
                                  내문서로 이동
                                </ContextMenuItem>
                                <ContextMenuItem
                                  disabled={disableAnalysisContextActions}
                                  variant="destructive"
                                  onClick={() => handleDeleteFileWithImpact(f)}
                                >
                                  <Trash2 className="h-4 w-4" />
                                  삭제
                                </ContextMenuItem>
                              </ContextMenuContent>
                            </ContextMenu>
                          )
                        })
                      )}
                    </div>
                  </ScrollArea>
                </>
              ) : (
                <>
                  <Button variant="secondary" onClick={handleNewChat} disabled={isGenerating || isCreatingSession}>
                    <MessageSquarePlus /> 새 대화 시작
                  </Button>

                  {/* Chat search filter — only show when list is ready and has items */}
                  {!chatsLoading && !chatsError && chatSessions.length > 0 && (
                    <div className="relative px-2 pb-1">
                      <Search className="absolute left-4 top-1/2 -translate-y-1/2 size-3.5 text-muted-foreground pointer-events-none" />
                      <Input
                        value={chatsFilter}
                        onChange={(e) => setChatsFilter(e.target.value)}
                        placeholder="대화 검색..."
                        className="h-7 pl-7 pr-7 text-xs"
                      />
                      {chatsFilter && (
                        <button
                          onClick={() => setChatsFilter('')}
                          className="absolute right-4 top-1/2 -translate-y-1/2 p-0.5 rounded hover:bg-muted"
                        >
                          <XIcon className="size-3 text-muted-foreground" />
                        </button>
                      )}
                    </div>
                  )}

                  <ScrollArea className="flex-1 min-h-0">
                    <div className="p-1 space-y-1" role="listbox" aria-label="대화 목록" onKeyDown={handleListKeyDown}>
                      {chatsLoading ? (
                        <div className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
                          <CircleNotchIcon weight="thin" className="size-4 animate-spin" /> 로딩 중...
                        </div>
                      ) : chatsError ? (
                        <div className="flex flex-col items-center gap-2 p-4 text-sm text-muted-foreground">
                          <AlertTriangle className="size-5 text-destructive" />
                          <span>대화 목록을 불러오지 못했습니다.</span>
                          <Button variant="ghost" size="sm" onClick={() => loadChatSessions()}>
                            <ArrowClockwiseIcon weight="thin" className="size-3 mr-1" /> 다시 시도
                          </Button>
                        </div>
                      ) : chatSessions.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">진행 중인 대화가 없습니다.</div>
                      ) : filteredChats.length === 0 ? (
                        <div className="p-3 text-sm text-muted-foreground">검색 결과가 없습니다.</div>
                      ) : (
                        filteredChats.map((s) => (
                          <ContextMenu key={s.id}>
                            <ContextMenuTrigger asChild>
                              <div
                                role="option"
                                aria-selected={activeChatId === s.id}
                                tabIndex={activeChatId === s.id ? 0 : -1}
                                className={
                                  'group grid grid-cols-[1fr_auto] items-center gap-1 rounded-md px-2 py-1 hover:bg-accent cursor-pointer focus:outline-none focus:ring-1 focus:ring-ring ' +
                                  (activeChatId === s.id ? 'bg-accent' : '')
                                }
                                onClick={() => setActiveChatId(s.id)}
                              >
                                <span className="block truncate text-sm">
                                  {s.session_name || '새 대화'}
                                </span>
                                <DropdownMenu>
                                  <DropdownMenuTrigger asChild>
                                    <button
                                      className="shrink-0 p-0.5 rounded opacity-0 group-hover:opacity-100 hover:bg-muted transition-opacity"
                                      onClick={(e) => e.stopPropagation()}
                                      title="더보기"
                                    >
                                      <DotsThreeHorizontalIcon weight="thin" className="h-4 w-4" />
                                    </button>
                                  </DropdownMenuTrigger>
                                  <DropdownMenuContent align="end" className="w-36">
                                    <DropdownMenuItem onClick={() => handleRenameChatSession(s.id)}>
                                      <PencilSimpleIcon weight="thin" className="h-4 w-4" />
                                      이름 수정
                                    </DropdownMenuItem>
                                    <DropdownMenuItem
                                      variant="destructive"
                                      onClick={() => {
                                        setConfirmDialog({
                                          open: true,
                                          title: 'DOREA-XP (공개용)',
                                          description: `"${s.session_name || '새 대화'}" 대화를 삭제하시겠습니까?`,
                                          confirmText: '삭제',
                                          cancelText: '취소',
                                          variant: 'destructive',
                                          onConfirm: () => handleDeleteChatSession(s.id),
                                        })
                                      }}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                      삭제
                                    </DropdownMenuItem>
                                  </DropdownMenuContent>
                                </DropdownMenu>
                              </div>
                            </ContextMenuTrigger>
                            <ContextMenuContent>
                              <ContextMenuItem
                                onClick={() => handleRenameChatSession(s.id)}
                              >
                                <PencilSimpleIcon weight="thin" className="h-4 w-4" />
                                이름 수정
                              </ContextMenuItem>
                              <ContextMenuItem
                                variant="destructive"
                                onClick={() => {
                                  setConfirmDialog({
                                    open: true,
                                    title: 'DOREA-XP (공개용)',
                                    description: `"${s.session_name || '새 대화'}" 대화를 삭제하시겠습니까?`,
                                    confirmText: '삭제',
                                    cancelText: '취소',
                                    variant: 'destructive',
                                    onConfirm: () => handleDeleteChatSession(s.id),
                                  })
                                }}
                              >
                                <Trash2 className="h-4 w-4" />
                                삭제
                              </ContextMenuItem>
                            </ContextMenuContent>
                          </ContextMenu>
                        ))
                      )}
                    </div>
                  </ScrollArea>
                </>
              )}
            </div>
          </Tabs>
        </aside>


        {/* Resize Handle: after left panel (visible when left is on AND another panel follows) */}
        {leftPanelVisible && (centerPanelVisible || chatPanelVisible || editorPanelVisible) && (
          <div
            role="separator"
            aria-valuenow={leftPanelWidth}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={MAX_PANEL_WIDTH}
            aria-label="왼쪽 패널 크기 조절"
            tabIndex={0}
            className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/30 transition-colors"
            onPointerDown={(e) => handleResizePointerDown('left', 1, e)}
            onKeyDown={(e) => handleResizeKeyDown('left', 1, e)}
          />
        )}

        {/* Center Panel — hidden when not visible */}
        <main style={{ ...(flexPanel === 'center' ? {} : { width: centerPanelWidth }), display: centerPanelVisible ? undefined : 'none' }} className={`${flexPanel === 'center' ? 'flex-1' : 'flex-none'} min-w-0 bg-muted/20 flex flex-col border-l border-r`}>
           <>
            <div className="h-9 min-h-9 shrink-0 border-b bg-muted/30 px-3 flex items-center justify-between gap-2">
              <PanelHeaderLabel icon={FileTextIcon} label="뷰어" iconProps={{ weight: 'regular' }} />
            </div>

          {(() => {
            const MAX_VISIBLE_TABS = 5
            const hasTabs = openDocuments.length > 0
            let visibleDocs = []
            let overflowDocs = []

            if (hasTabs) {
              const activeIndex = openDocuments.findIndex(d => d.id === activeDocumentId)
              visibleDocs = openDocuments.slice(0, MAX_VISIBLE_TABS)
              overflowDocs = openDocuments.slice(MAX_VISIBLE_TABS)

              if (activeIndex >= MAX_VISIBLE_TABS) {
                const activeDoc = openDocuments[activeIndex]
                overflowDocs = overflowDocs.filter(d => d.id !== activeDocumentId)
                overflowDocs.unshift(visibleDocs[visibleDocs.length - 1])
                visibleDocs = [...visibleDocs.slice(0, -1), activeDoc]
              }
            }

            return (
              <div className="h-[54px] min-h-[54px] shrink-0 border-b bg-background/50 px-2 flex items-center gap-1">
                {/* Center: Document tabs (only in document mode with open docs) */}
                {hasTabs ? (
                  <div className="flex items-end gap-0.5 flex-1 min-w-0 self-end overflow-hidden">
                    {visibleDocs.map((doc) => {
                      const isActive = activeDocumentId === doc.id
                      return (
                        <div
                          key={doc.id}
                          onClick={() => setActiveDocumentId(doc.id)}
                          title={doc.name}
                          className={`
                            group flex items-center gap-1 py-2 text-xs cursor-pointer rounded-t border border-b-0 transition-all
                            ${isActive
                              ? 'bg-background text-foreground border-border px-3 max-w-[180px]'
                              : 'bg-muted/30 text-muted-foreground border-transparent hover:bg-muted/50 px-2 max-w-[100px]'
                            }
                          `}
                        >
                          <img src={getFileIconUrl(doc.name)} alt="" className="h-3.5 w-3.5 shrink-0" />
                          <span className="truncate">{doc.name}</span>
                          <button
                            onClick={(e) => handleCloseDocument(doc.id, e)}
                            className={`p-0.5 rounded hover:bg-destructive/20 hover:text-destructive transition-opacity ${isActive ? 'opacity-60 group-hover:opacity-100' : 'opacity-0 group-hover:opacity-100'}`}
                            title="닫기"
                          >
                            <XIcon className="h-3 w-3" />
                          </button>
                        </div>
                      )
                    })}

                    {/* Overflow dropdown */}
                    {overflowDocs.length > 0 && (
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button className="flex items-center gap-1 px-2 py-2 text-xs text-muted-foreground hover:bg-muted/50 rounded-t border border-b-0 border-transparent">
                            <DotsThreeHorizontalIcon weight="thin" className="h-4 w-4" />
                            <span className="text-xs">+{overflowDocs.length}</span>
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="max-h-[300px] overflow-y-auto">
                          {overflowDocs.map((doc) => (
                            <DropdownMenuItem
                              key={doc.id}
                              onClick={() => setActiveDocumentId(doc.id)}
                              className="flex items-center justify-between gap-2"
                            >
                              <div className="flex items-center gap-2 min-w-0">
                                <img src={getFileIconUrl(doc.name)} alt="" className="h-4 w-4 shrink-0" />
                                <span className="truncate max-w-[200px]">{doc.name}</span>
                              </div>
                              <button
                                onClick={(e) => {
                                  e.stopPropagation()
                                  handleCloseDocument(doc.id, e)
                                }}
                                className="p-1 rounded hover:bg-destructive/20 hover:text-destructive"
                                title="닫기"
                              >
                                <XIcon className="h-3 w-3" />
                              </button>
                            </DropdownMenuItem>
                          ))}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    )}
                  </div>
                ) : (
                  <div className="flex-1" />
                )}

              </div>
            )
          })()}

          {/* Center Workspace Body */}
          <div className="flex-1 min-h-0 flex flex-col">
            {activeDocumentId ? (
              <PdfViewer
                key={`${activeDocumentDomain}:${activeDocumentId}`}
                fileId={activeDocumentId}
                fileDomain={activeDocumentDomain}
                pdfUrl={activeDocumentDomain === 'my_documents' ? myDocumentsAPI.getPdfUrl(activeDocumentId) : filesAPI.getPdfUrl(activeDocumentId)}
                segments={segments}
                selectedSegments={selectedSegmentIds}
                onSegmentClick={handleSegmentClick}
                onSegmentBoxSelect={handleSegmentBoxSelect}
                focusSegmentId={focusSegmentId}
                onInsertImageToEditor={handleInsertCapturedImageIntoEditor}
                onCaptureImage={handleCaptureImage}
                onCaptureText={handleCaptureText}
                isVisionCapable={isVisionCapable}
                onPageChange={setViewerPage}
              />
            ) : (
              <div className="h-full w-full flex flex-col overflow-hidden">
                <div className="w-full">
                  <img
                    src="/PIC_DOREA-X.png"
                    alt="DOREA-XP viewer placeholder"
                    className="w-full h-auto object-contain"
                  />
                </div>
                <div className="flex-1 flex items-center justify-center">
                  <div className="text-sm text-muted-foreground">문서를 선택하여 보거나 업로드하세요.</div>
                </div>
              </div>
            )}
          </div>
          </>
        </main>


        {/* Resize Handle: after center panel (visible when center is on AND editor/chat follows) */}
        {centerPanelVisible && (editorPanelVisible || chatPanelVisible) && (() => {
          const rightPanel = editorPanelVisible ? 'editor' : 'chat'
          return (
            <div
              role="separator"
              aria-valuenow={editorPanelVisible ? editorPanelWidth : chatPanelWidth}
              aria-valuemin={getPanelMinWidth(rightPanel)}
              aria-valuemax={getPanelMaxWidth(rightPanel)}
              aria-label="패널 크기 조절"
              tabIndex={0}
              className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/30 transition-colors"
              onPointerDown={(e) => handleResizePointerDown(rightPanel, -1, e)}
              onKeyDown={(e) => handleResizeKeyDown(rightPanel, -1, e)}
            />
          )
        })()}

        {/* Editor Panel — always mounted (display:none when hidden to preserve content) */}
        <aside style={{ width: flexPanel === 'editor' ? undefined : editorPanelWidth, minWidth: editorPanelMinWidth, display: editorPanelVisible ? undefined : 'none' }} className={`${flexPanel === 'editor' ? 'flex-1' : 'flex-none'} border-l bg-background flex flex-col min-h-0 overflow-hidden`}>
            <div className="h-9 min-h-9 shrink-0 border-b bg-muted/30 px-3 flex items-center">
              <PanelHeaderLabel icon={NotePencilIcon} label="편집기" iconProps={{ weight: 'regular' }} />
            </div>
          {/* Header */}
          <div className="h-[54px] min-h-[54px] shrink-0 border-b px-3 py-1 flex items-center justify-between">
              <div className="flex-1 min-w-0 flex items-center gap-2">
                <span className="min-w-0 truncate text-xs text-muted-foreground" title={getEditorStorageFilenameLabel()}>
                  {getEditorStorageFilenameLabel()}
                </span>
              </div>
              <div className="flex items-center shrink-0 ml-2 gap-1">
                {activeEditorKind === 'markdown' && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditorFontSize((v) => Math.max(FONT_SIZE_MIN, v - FONT_SIZE_STEP))}
                      disabled={editorFontSize <= FONT_SIZE_MIN}
                      title={`글자 크기 줄이기 (${editorFontSize}px)`}
                      className="shrink-0 h-7 w-7"
                    >
                      <ArrowCircleUpIcon weight="thin" className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => setEditorFontSize((v) => Math.min(FONT_SIZE_MAX, v + FONT_SIZE_STEP))}
                      disabled={editorFontSize >= FONT_SIZE_MAX}
                      title={`글자 크기 키우기 (${editorFontSize}px)`}
                      className="shrink-0 h-7 w-7"
                    >
                      <ArrowCircleDownIcon weight="thin" className="h-3.5 w-3.5" />
                    </Button>
                    <Separator orientation="vertical" className="h-4 mx-0.5" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-7 w-7"
                      onClick={() => editorRef.current?.getInstance()?.exec('undo')}
                      title="되돌리기 (Ctrl+Z)"
                    >
                      <ArrowCounterClockwiseIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-7 w-7"
                      onClick={() => editorRef.current?.getInstance()?.exec('redo')}
                      title="다시 실행 (Ctrl+Shift+Z)"
                    >
                      <ArrowClockwiseIcon weight="thin" className="h-3.5 w-3.5" />
                    </Button>
                    <Separator orientation="vertical" className="h-4 mx-0.5" />
                    <Button
                      variant="ghost"
                      size="icon"
                      className="shrink-0 h-7 w-7"
                      onClick={() => editorRef.current?.triggerImagePicker()}
                      title="이미지 삽입"
                    >
                      <ImageIcon className="h-3.5 w-3.5" />
                    </Button>
                    <Separator orientation="vertical" className="h-4 mx-0.5" />
                  </>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-xs px-2 gap-1"
                  onClick={handleSaveEditorDocument}
                  disabled={isSavingEditor}
                  title="저장"
                >
                  <FloppyDiskIcon className="h-3 w-3" />
                  {isSavingEditor ? '저장 중...' : '저장'}
                </Button>
              </div>
          </div>
          <div className="flex-1 min-h-0 relative">
            <Suspense fallback={<div className="flex items-center justify-center h-full text-muted-foreground">에디터 로딩 중...</div>}>
              {hasMountedMarkdownEditor && (
                <div className="absolute inset-0" style={{ visibility: activeEditorKind === 'markdown' ? 'visible' : 'hidden' }}>
                  <ToastEditor
                    ref={setMarkdownEditorInstance}
                    initialValue=""
                    height="100%"
                    resolveImageSrc={handleResolveImageSrc}
                    onImageInsert={handleEditorImageInsert}
                    onChange={(md) => {
                      if (!activeEditorDocId) return
                      setViewerStateByDocId(prev => ({
                        ...prev,
                        [activeEditorDocId]: { markdown: md, updatedAt: Date.now() }
                      }))
                    }}
                  />
                </div>
              )}
              {hasMountedRhwpEditor && (
                <div className="absolute inset-0" style={{ visibility: activeEditorKind === 'rhwp' ? 'visible' : 'hidden' }}>
                  <RhwpEditor ref={setRhwpEditorInstance} />
                </div>
              )}
            </Suspense>
          </div>
        </aside>

        {/* Resize Handle: between editor and chat (visible when both are on) */}
        {editorPanelVisible && chatPanelVisible && (
          <div
            role="separator"
            aria-valuenow={chatPanelWidth}
            aria-valuemin={MIN_PANEL_WIDTH}
            aria-valuemax={MAX_PANEL_WIDTH}
            aria-label="채팅 패널 크기 조절"
            tabIndex={0}
            className="w-1 flex-none cursor-col-resize bg-transparent hover:bg-primary/20 active:bg-primary/30 transition-colors"
            onPointerDown={(e) => handleResizePointerDown('chat', -1, e)}
            onKeyDown={(e) => handleResizeKeyDown('chat', -1, e)}
          />
        )}

        {/* Chat Panel — hidden when not visible */}
        <aside style={{ width: flexPanel === 'chat' ? undefined : chatPanelWidth, display: chatPanelVisible ? undefined : 'none' }} className={`${flexPanel === 'chat' ? 'flex-1 min-w-0' : 'flex-none'} border-l bg-background flex flex-col min-h-0 overflow-hidden`}>
            <>
                <div className="h-9 min-h-9 shrink-0 border-b bg-muted/30 px-3 flex items-center justify-between">
                  <PanelHeaderLabel icon={FinnTheHumanIcon} label="에이전트" iconProps={{ weight: 'duotone' }} />
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-6 px-2 gap-1 text-[11px]"
                      title="페르소나 설정"
                      onClick={() => {
                        setSettingsInitialMenu('ai-persona')
                        setShowSettings(true)
                      }}
                    >
                      <GearIcon className="h-3 w-3" weight="regular" />
                      <span>페르소나 설정</span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (!activeChatId) return
                        setConfirmDialog({
                          open: true,
                          title: '대화 초기화',
                          description: '이 세션의 모든 메시지를 삭제합니다. 이 작업은 되돌릴 수 없습니다.',
                          confirmText: '초기화',
                          cancelText: '취소',
                          variant: 'destructive',
                           onConfirm: async () => {
                             try {
                               await chatsAPI.clearSessionMessages(activeChatId)
                               setMessages([{ _isSystem: true, content: '대화가 초기화되었습니다.' }])
                              setChatSessions(prev => prev.map(s =>
                                s.id === activeChatId ? { ...s, message_count: 0, updated_at: new Date().toISOString() } : s
                              ))
                              toast.success('대화가 초기화되었습니다.')
                            } catch (e) {
                              toast.error('초기화에 실패했습니다.')
                            }
                          },
                        })
                      }}
                      title="대화 초기화"
                      className="shrink-0 h-6 w-6"
                      disabled={!activeChatId}
                    >
                      <EraserIcon weight="thin" className="h-3 w-3" />
                    </Button>
                  </div>
                 </div>

              <div className="flex-1 min-h-0 flex flex-col">
                {/* ===== Agent Status Fixed Panel ===== */}
                <div className="shrink-0 border-b border-amber-300 dark:border-amber-700 bg-amber-50/95 dark:bg-amber-950/90 flex flex-row">
                    {/* ===== Agent Avatar Image ===== */}
                    <div className="shrink-0 overflow-hidden bg-white" style={{ width: 200, height: 200 }}>
                      <img
                        src={agentStatusImageByState[agentStatus.status] || agentStatusImageByState.idle}
                        alt="Agent"
                        className="h-[200px] w-[200px] object-cover block"
                      />
                    </div>
                    <div className="flex-1 min-w-0 px-3 py-2 space-y-1">
                    {/* Row 1: PERSONA */}
                    <TooltipProvider delayDuration={300}>
                      <Tooltip>
                        <TooltipTrigger asChild>
                           <div className="relative flex items-center gap-1.5 h-[18px] cursor-default overflow-hidden">
                            <div className="flex items-center gap-1 shrink-0 w-[68px]">
                              <span className="text-[10px] font-semibold text-amber-700 dark:text-amber-400">PERSONA</span>
                            </div>
                            <div ref={personaBadgesRef} className="flex items-center gap-1 flex-nowrap overflow-hidden min-w-0">
                              {personaSummary.length > 0 ? personaSummary.map((tag) => (
                                <span key={tag} className="inline-flex items-center rounded-full bg-violet-200 dark:bg-violet-900/40 text-violet-800 dark:text-violet-300 px-1.5 py-0 text-[9px] font-medium leading-4 whitespace-nowrap shrink-0">
                                  {tag}
                                </span>
                              )) : (
                                <span className="text-[10px] text-amber-600 dark:text-amber-400/80">없음</span>
                              )}
                            </div>
                            {personaOverflow && <span className="absolute right-0 top-0 h-full flex items-center pl-6 pr-1 bg-gradient-to-l from-amber-50 via-amber-50/90 to-transparent dark:from-amber-950/90 dark:via-amber-950/80 pointer-events-none text-[9px] text-amber-500">…</span>}
                          </div>
                        </TooltipTrigger>
                        <TooltipContent side="bottom" align="start" className="max-w-sm whitespace-pre-line text-xs">
                          {personaTooltipText}
                        </TooltipContent>
                      </Tooltip>
                    </TooltipProvider>

                    {/* Row: RAG */}
                    <div className="flex items-center gap-1.5 min-h-[16px]">
                      <span className={`text-[10px] font-semibold shrink-0 w-[52px] transition-all duration-300${activeLabel === 'rag' ? ' text-blue-600 dark:text-blue-300 animate-pulse' : ' text-amber-700 dark:text-amber-400'}`}>RAG</span>
                      {knowledgeDb !== 'none' && userKnowledgeDbs.length > 0
                        ? (
                          <span className="inline-flex items-center gap-0.5 rounded-full bg-blue-200 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 px-1.5 py-0 text-[9px] font-medium leading-4 whitespace-nowrap shrink-0">
                            <DatabaseIcon weight="bold" className="h-2.5 w-2.5 shrink-0" />
                            {userKnowledgeDbs.find(kb => String(kb.id) === knowledgeDb)?.name || knowledgeDb}
                          </span>
                        )
                        : <span className="text-[10px] text-amber-600 dark:text-amber-400/80">없음</span>
                      }
                    </div>

                    {/* Row 3: MCP */}
                    <div className="relative flex items-center gap-1.5 h-[18px] overflow-hidden">
                      <span className={`text-[10px] font-semibold shrink-0 w-[52px] transition-all duration-300${activeLabel === 'mcp' ? ' text-emerald-600 dark:text-emerald-300 animate-pulse' : ' text-amber-700 dark:text-amber-400'}`}>MCP</span>
                      <div ref={mcpBadgesRef} className="flex items-center gap-1 flex-nowrap overflow-hidden min-w-0">
                        {(() => {
                          const mcpItems = mcpActive ? enabledMcpSkills.filter(s => s.server_type !== 'skill') : []
                          return mcpItems.length > 0 ? mcpItems.map(s => (
                            <span key={s.id} className="inline-flex items-center gap-0.5 rounded-full bg-emerald-200 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300 px-1.5 py-0 text-[9px] font-medium leading-4 whitespace-nowrap shrink-0">
                              <Cpu className="h-2.5 w-2.5 shrink-0" />
                              {s.display_name || s.name}
                            </span>
                          )) : (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400/80">없음</span>
                          )
                        })()}
                      </div>
                      {mcpOverflow && <span className="absolute right-0 top-0 h-full flex items-center pl-6 pr-1 bg-gradient-to-l from-amber-50 via-amber-50/90 to-transparent dark:from-amber-950/90 dark:via-amber-950/80 pointer-events-none text-[9px] text-amber-500">…</span>}
                    </div>

                    {/* Row 4: SKILL */}
                    <div className="relative flex items-center gap-1.5 h-[18px] overflow-hidden">
                      <span className={`text-[10px] font-semibold shrink-0 w-[52px] transition-all duration-300${activeLabel === 'skill' ? ' text-amber-500 dark:text-amber-200 animate-pulse' : ' text-amber-700 dark:text-amber-400'}`}>SKILL</span>
                      <div ref={skillBadgesRef} className="flex items-center gap-1 flex-nowrap overflow-hidden min-w-0">
                        {(() => {
                          const skillItems = mcpActive ? enabledMcpSkills.filter(s => s.server_type === 'skill') : []
                          return skillItems.length > 0 ? skillItems.map(s => (
                            <span key={s.id} className="inline-flex items-center gap-0.5 rounded-full bg-amber-200 dark:bg-amber-800/40 text-amber-800 dark:text-amber-300 px-1.5 py-0 text-[9px] font-medium leading-4 whitespace-nowrap shrink-0">
                              <Zap className="h-2.5 w-2.5 shrink-0" />
                              {s.display_name || s.name}
                            </span>
                          )) : (
                            <span className="text-[10px] text-amber-600 dark:text-amber-400/80">없음</span>
                          )
                        })()}
                      </div>
                      {skillOverflow && <span className="absolute right-0 top-0 h-full flex items-center pl-6 pr-1 bg-gradient-to-l from-amber-50 via-amber-50/90 to-transparent dark:from-amber-950/90 dark:via-amber-950/80 pointer-events-none text-[9px] text-amber-500">…</span>}
                    </div>

                    {/* Status message history (fixed 3 lines, bottom-aligned, scrollable) */}
                    <div
                      ref={agentStatusHistoryRef}
                      className="h-[3.6rem] overflow-y-auto flex flex-col justify-end pt-0.5"
                    >
                      <div className="space-y-0.5">
                      {agentStatusHistory.length === 0 && agentStatus.status === 'idle' ? (
                        <div className="flex items-center gap-1.5 min-h-[18px]">
                          <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                          <span className="text-[11px] font-medium text-amber-800 dark:text-amber-200">에이전트가 대기중입니다</span>
                        </div>
                      ) : (
                        <>
                          {agentStatusHistory.map((entry, idx) => {
                            const isLatest = idx === agentStatusHistory.length - 1
                            const isActive = isLatest && agentStatus.status !== 'idle'
                            const timeStr = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('en-GB', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }) : ''
                            return (
                            <div key={idx} className="flex items-center gap-1.5 min-h-[18px]">
                              {entry.label === 'memory' ? (
                                <Brain className="h-3 w-3 text-fuchsia-600 shrink-0" />
                              ) : entry.label === 'rag' ? (
                                <DatabaseIcon className="h-3 w-3 text-blue-600 shrink-0" />
                              ) : entry.label === 'skill' ? (
                                <Zap className="h-3 w-3 text-amber-500 shrink-0" />
                              ) : entry.status === 'thinking' ? (
                                <CircleNotchIcon weight="thin" className={`h-3 w-3 shrink-0 text-amber-700 dark:text-amber-300${isActive ? ' animate-spin' : ''}`} />
                              ) : entry.status === 'tool_use' ? (
                                <Cpu className="h-3 w-3 text-emerald-600 shrink-0" />
                              ) : entry.status === 'editing' ? (
                                <PencilLineIcon weight="thin" className="h-3 w-3 text-blue-600 shrink-0" />
                              ) : entry.status === 'streaming' ? (
                                <div className="h-2 w-2 rounded-full bg-amber-500 shrink-0" />
                              ) : (
                                <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                              )}
                              <span className={`text-[11px] ${isActive ? 'font-medium text-amber-900 dark:text-amber-100' : 'text-muted-foreground/60'}`}>
                                {timeStr && <span className="font-mono mr-1">{timeStr}</span>}
                                {entry.message}
                              </span>
                            </div>
                          )})}
                          {agentStatus.status === 'idle' && agentStatusHistory.length > 0 && (
                            <div className="flex items-center gap-1.5 min-h-[18px]">
                              <div className="h-2 w-2 rounded-full bg-emerald-500 shrink-0" />
                              <span className="text-[11px] font-medium text-amber-800 dark:text-amber-200">에이전트가 대기중입니다</span>
                            </div>
                          )}
                        </>
                      )}
                      </div>
                    </div>
                    </div>
                </div>

                <ScrollArea className="flex-1 min-h-0">
                  <div className="p-4 space-y-3" ref={messagesContainerRef} style={{ fontSize: `${chatFontSize}px` }}>
                    {messages.map((m, idx) => (
                      m._isSystem ? (
                        <div key={`sys-${idx}`} className="flex justify-center">
                          <span className="text-xs text-muted-foreground italic py-2">
                            {m.content}
                          </span>
                        </div>
                      ) : (
                      <React.Fragment key={m.id || idx}>
                      <div className={m.is_user ? 'flex justify-end' : 'flex justify-start'}>
                        <div className="max-w-[85%]">
                          {/* Message bubble */}
                          <div
                            className={
                              'rounded-lg px-3 py-2 leading-relaxed ' +
                              (m.is_user ? 'bg-primary text-white' : 'bg-muted text-foreground')
                            }
                          >
                            {(() => {
                              const textRefs = (m.selected_segments || []).filter((seg) => seg && !isNonTextSegment(seg))
                              if (!textRefs.length) return null
                              const allRefs = m.selected_segments.filter(Boolean)
                              return (
                                <div className="mb-1 rounded-md bg-black/5 px-1.5 py-1 text-xs opacity-90">
                                  {textRefs.map((seg, si) => {
                                    const rawLineText = getSegmentDisplayText(seg)
                                    const lineText = truncateSegmentPreviewText(rawLineText, 20)
                                    return (
                                      <button
                                        key={`${m.id || idx}-segment-text-${seg.id || si}`}
                                        type="button"
                                        className="mb-1 block w-full cursor-pointer rounded px-1.5 py-1 text-left hover:bg-black/10"
                                        onClick={() => handleSegmentReferenceClick(allRefs, seg.id)}
                                        title={rawLineText || lineText}
                                      >
                                        <span className="block truncate whitespace-nowrap">📎 {lineText}</span>
                                      </button>
                                    )
                                  })}
                                </div>
                              )
                            })()}
                            {renderMessageContent(m)}
                            {/* RAG Source Panel (inside bubble — content reference) */}
                            {!m.is_user && (() => {
                              const ragUsed = m._ragUsed || m.model_metadata?.rag_used
                              const ragSources = getMessageRagSources(m)
                              if (!ragUsed && ragSources.length === 0) return null
                              return (
                                <div className="mt-2 space-y-1">
                                  {ragUsed && (
                                    <Badge variant="secondary" className="text-[10px] px-1.5 py-0 h-4 bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                                      RAG 사용
                                    </Badge>
                                  )}
                                  {ragSources.length > 0 && (
                                    <details className="group">
                                      <summary className="cursor-pointer text-[11px] text-muted-foreground hover:text-foreground transition-colors select-none">
                                        📄 참조 소스 {ragSources.length}건
                                      </summary>
                                      <div className="mt-1 space-y-2 pl-1">
                                        {ragSources.map((src, si) => {
                                          const previewKey = isImagePreviewableRagSource(src) ? getSegmentPreviewCacheKey(src) : null
                                          const previewSrc = previewKey ? segmentPreviewUrls[previewKey] : null
                                          const fileLabel = src.filename || src.file_id?.slice(0, 8) || '소스'
                                          const pageLabel = src.page ? `p.${src.page}` : '페이지 정보 없음'
                                          const scoreLabel = `${Math.round((src.score || 0) * 100)}%`
                                          const sourceText = truncateSegmentPreviewText(getSegmentDisplayText(src), 120)

                                          if (previewSrc) {
                                            return (
                                              <button
                                                key={si}
                                                type="button"
                                                className="w-full overflow-hidden rounded-md border border-border/70 bg-background/70 text-left transition-colors hover:bg-accent"
                                                onClick={() => handleRagSourceClick(src)}
                                                title={`${fileLabel} — ${pageLabel}로 이동`}
                                              >
                                                <div className="flex items-center justify-center bg-muted/40 px-2 py-2">
                                                  <img
                                                    src={previewSrc}
                                                    alt={`${fileLabel} 미리보기`}
                                                    className="max-h-44 w-auto max-w-full rounded object-contain"
                                                    loading="lazy"
                                                  />
                                                </div>
                                                <div className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] text-muted-foreground">
                                                  <img src={getFileIconUrl(src.filename || '')} alt="" className="h-3 w-3 shrink-0" />
                                                  <span className="truncate min-w-0 flex-1">{fileLabel}</span>
                                                  <span className="shrink-0">{pageLabel}</span>
                                                  <span className="shrink-0 font-mono">{scoreLabel}</span>
                                                </div>
                                              </button>
                                            )
                                          }

                                          return (
                                            <button
                                              key={si}
                                              className="w-full rounded-md border border-border/60 bg-background/50 px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-foreground"
                                              onClick={() => handleRagSourceClick(src)}
                                              title={`${fileLabel} — ${pageLabel}로 이동`}
                                            >
                                              <div className="mb-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                                                <img src={getFileIconUrl(src.filename || '')} alt="" className="h-3 w-3 shrink-0" />
                                                <span className="truncate min-w-0 flex-1">{fileLabel}</span>
                                                <span className="shrink-0">{pageLabel}</span>
                                                <span className="shrink-0 font-mono">{scoreLabel}</span>
                                              </div>
                                              <div className="line-clamp-3 text-[11px] leading-relaxed text-foreground/85">
                                                {sourceText}
                                              </div>
                                            </button>
                                          )
                                        })}
                                      </div>
                                    </details>
                                  )}
                                </div>
                              )
                            })()}
                          </div>
                          {/* Meta row below bubble */}
                          {!m._isStreaming && (
                            <div className={`mt-0.5 px-1 ${m.is_user ? '' : 'grid grid-cols-[minmax(0,1fr)_auto] items-start gap-2'}`}>
                              <div className={`text-[10px] text-muted-foreground/60 ${m.is_user ? 'text-right' : 'text-left'}`}>
                                {(() => {
                                  // Server returns UTC without Z suffix — append Z so JS parses as UTC
                                  const raw = m.created_at
                                  const ts = raw
                                    ? new Date(typeof raw === 'string' && !raw.endsWith('Z') && !raw.includes('+') ? raw + 'Z' : raw)
                                    : (m.id && typeof m.id === 'number' ? new Date(m.id) : null)
                                  if (!ts || isNaN(ts.getTime())) return null
                                  return ts.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
                                })()}
                              </div>
                              {!m.is_user && !m._isError && !m._hasProposal && m.content && (
                                <div className="justify-self-end">
                                  <button
                                    onClick={() => handleCopyMessageContent(m)}
                                    id={`copy-${m.id}`}
                                    data-copied="false"
                                    className="group/copy rounded p-1 text-muted-foreground/50 hover:text-foreground hover:bg-muted transition-colors"
                                    title="답변 복사"
                                  >
                                    <CopyIcon weight="thin" className="h-3.5 w-3.5 group-data-[copied=true]/copy:hidden" />
                                    <Check className="h-3.5 w-3.5 text-emerald-500 hidden group-data-[copied=true]/copy:block" />
                                  </button>
                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      </div>
                      {/* Inline proposals linked to this message (filtered by active session) */}
                      {pendingProposals
                        .filter((p) => p.linkedMessageId === m.id && (!p.chatSessionId || p.chatSessionId === activeChatId))
                        .map((proposal) => renderProposalCard(proposal))}
                      </React.Fragment>
                      )
                    ))}

                    {isGenerating && messages.every(m => !m._isStreaming) ? (
                      <div className="text-sm text-muted-foreground">AI가 답변 중...</div>
                    ) : null}

                    <div ref={messagesEndRef} />
                  </div>
                </ScrollArea>

                <div className="border-t p-2">
                   {/* Pending images preview */}
                   {pendingImages.length > 0 && (
                     <div className="mb-2 flex flex-wrap gap-2">
                       {pendingImages.map((img) => (
                         <div key={img.localId} className="relative group">
                           {img.previewUrl ? (
                             <img
                               src={img.previewUrl}
                               alt="첨부 대기"
                               className={`w-16 h-16 rounded-md border object-cover ${
                                 img.status === 'uploading' ? 'opacity-50' : ''
                               } ${img.status === 'error' ? 'border-destructive' : ''}`}
                             />
                           ) : (
                             <div className="w-16 h-16 rounded-md border bg-muted flex items-center justify-center">
                               <CircleNotchIcon weight="thin" className="h-4 w-4 animate-spin text-muted-foreground" />
                             </div>
                           )}
                          {img.status === 'uploading' && (
                            <div className="absolute inset-0 flex items-center justify-center">
                              <CircleNotchIcon weight="thin" className="h-4 w-4 animate-spin text-primary" />
                            </div>
                          )}
                          {img.status === 'error' && (
                            <div className="absolute inset-0 flex items-center justify-center bg-black/40 rounded-md">
                              <AlertTriangle className="h-4 w-4 text-destructive" />
                            </div>
                          )}
                          <button
                            onClick={() => handleRemovePendingImage(img.localId)}
                            className="absolute -top-1 -right-1 h-5 w-5 rounded-full bg-destructive text-destructive-foreground flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                            title="삭제"
                          >
                            <XIcon className="h-3 w-3" />
                          </button>
                        </div>
                      ))}
                      <div className="flex items-center text-xs text-muted-foreground">
                        {pendingImages.length}/{MAX_PENDING_IMAGES}
                      </div>
                    </div>
                   )}

                    {selectedSegmentIds.length > 0 && !segmentPreviewDismissed && (
                      <div className="mb-2 flex flex-wrap gap-1.5">
                        {selectedSegmentIds.map((id) => {
                          const seg = segments.find((s) => s.id === id)
                          if (!seg) return null
                          if (isNonTextSegment(seg)) {
                            const previewKey = getSegmentPreviewCacheKey(seg)
                            const previewSrc = previewKey ? segmentPreviewUrls[previewKey] : null
                            const title = `${getSegmentType(seg) || '이미지 세그먼트'}${seg?.page ? ` · p.${seg.page}` : ''}`
                            return (
                              <div key={id} className="group relative h-16 w-16 overflow-hidden rounded-md border border-primary/25 bg-primary/5">
                                {previewSrc ? (
                                  <img src={previewSrc} alt={title} className="h-full w-full object-cover" loading="lazy" />
                                ) : (
                                  <div className="flex h-full w-full items-center justify-center text-[10px] font-semibold text-primary/70">
                                    {getNonTextSegmentTileLabel(seg)}
                                  </div>
                                )}
                                <button
                                  type="button"
                                  onClick={() => setSelectedSegmentIds((prev) => prev.filter((x) => x !== id))}
                                  className="absolute right-1 top-1 flex h-5 w-5 items-center justify-center rounded-full bg-black/65 text-white opacity-0 transition-opacity group-hover:opacity-100"
                                  title="선택 해제"
                                >
                                  <XIcon className="h-3 w-3" />
                                </button>
                              </div>
                            )
                          }
                          const text = getSegmentDisplayText(seg)
                          if (!text) return null
                          const preview = truncateSegmentPreviewText(text, 24)
                         return (
                           <span
                             key={id}
                             className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2.5 py-1 text-xs text-primary"
                             title={text}
                           >
                             <span className="truncate max-w-[180px]">📎 {preview}</span>
                             <button
                               type="button"
                               onClick={() => setSelectedSegmentIds((prev) => prev.filter((x) => x !== id))}
                               className="ml-0.5 rounded-full hover:bg-primary/20 p-0.5"
                               title="선택 해제"
                             >
                               <XIcon className="h-3 w-3" />
                             </button>
                           </span>
                         )
                       })}
                     </div>
                   )}

                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="flex-1 min-w-0 flex gap-1.5 overflow-x-auto scrollbar-none">
                      {quickActions.filter(action => action.visible).slice(0, 10).map((action) => (
                        <button
                          key={action.id}
                          className="shrink-0 h-7 px-3 rounded-full text-xs font-medium bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground transition-colors disabled:opacity-40 disabled:pointer-events-none"
                          onClick={() => handleQuickAction(action.id)}
                          disabled={isGenerating}
                          title={action.caption || action.label}
                        >
                          {action.label}
                        </button>
                      ))}
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setChatFontSize((v) => Math.max(FONT_SIZE_MIN, v - FONT_SIZE_STEP))}
                        disabled={chatFontSize <= FONT_SIZE_MIN}
                        title={`글씨 작게 (${Math.max(FONT_SIZE_MIN, chatFontSize - FONT_SIZE_STEP)}px)`}
                        aria-label={`글씨 작게 (${Math.max(FONT_SIZE_MIN, chatFontSize - FONT_SIZE_STEP)}px)`}
                        className="h-7 w-7"
                      >
                        <ArrowCircleDownIcon weight="thin" className="h-5 w-5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setChatFontSize((v) => Math.min(FONT_SIZE_MAX, v + FONT_SIZE_STEP))}
                        disabled={chatFontSize >= FONT_SIZE_MAX}
                        title={`글씨 크게 (${Math.min(FONT_SIZE_MAX, chatFontSize + FONT_SIZE_STEP)}px)`}
                        aria-label={`글씨 크게 (${Math.min(FONT_SIZE_MAX, chatFontSize + FONT_SIZE_STEP)}px)`}
                        className="h-7 w-7"
                      >
                        <ArrowCircleUpIcon weight="thin" className="h-5 w-5" />
                      </Button>
                    </div>
                  </div>

                   {/* Claude Desktop-style 2-row chat input */}
                   <div
                     className="rounded-xl border bg-background"
                     onDragOver={(e) => { e.preventDefault(); e.stopPropagation() }}
                     onDrop={(e) => {
                       e.preventDefault(); e.stopPropagation()
                       const files = Array.from(e.dataTransfer?.files || [])
                       for (const f of files) {
                         if (f.type?.startsWith('image/')) {
                           handleCaptureImage(f)
                         }
                       }
                     }}
                   >
                     {/* Row 1: Textarea */}
                    <textarea
                      ref={chatTextareaRef}
                       value={inputText}
                      onChange={(e) => {
                        setInputText(e.target.value)
                        // Auto-grow with safe reset
                        const el = e.target
                        el.style.height = '56px'
                        el.style.height = Math.min(el.scrollHeight, 200) + 'px'
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.shiftKey) {
                          e.preventDefault()
                          handleSendMessage()
                        }
                      }}
                      onPaste={handlePaste}
                       disabled={!canEditComposer}
                       placeholder={canEditComposer ? '메시지를 입력하세요...' : 'AI가 답변 중입니다...'}
                       className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none disabled:opacity-50"
                      rows={2}
                      style={{ minHeight: '56px', maxHeight: '200px' }}
                    />

                    {/* Row 2: + button (left) / model + send (right) */}
                    <div className="flex items-center justify-between px-2 pb-2">
                      {/* Left: + Menu Button + Document Context Pill */}
                      <div className="flex items-center gap-1.5">
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <button
                            className="flex h-8 w-8 items-center justify-center rounded-full border border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors"
                            title="옵션"
                          >
                            <PlusIcon weight="thin" className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent side="top" align="start" className="w-48">
                          {/* RAG Submenu */}
                          <DropdownMenuSub>
                            <DropdownMenuSubTrigger>
                              <DatabaseIcon weight="thin" className="h-4 w-4 mr-2 text-muted-foreground" />
                              <span>RAG</span>
                              {knowledgeDb !== 'none' && (
                                <span className="ml-auto text-xs text-muted-foreground">
                                  {userKnowledgeDbs.find(kb => String(kb.id) === knowledgeDb)?.name || ''}
                                </span>
                              )}
                            </DropdownMenuSubTrigger>
                            <DropdownMenuSubContent className="w-48">
                              <DropdownMenuRadioGroup value={knowledgeDb} onValueChange={handleKnowledgeDbChange}>
                                <DropdownMenuRadioItem value="none">없음</DropdownMenuRadioItem>
                                {userKnowledgeDbs.map(kb => (
                                  <DropdownMenuRadioItem key={kb.id} value={String(kb.id)}>
                                    {kb.name} ({kb.file_count}건)
                                  </DropdownMenuRadioItem>
                                ))}
                              </DropdownMenuRadioGroup>
                            </DropdownMenuSubContent>
                          </DropdownMenuSub>

                           {/* MCP/Skills Toggle — 사용자가 명시적으로 켜야 LLM이 도구 호출 가능 */}
                           {enabledMcpSkills.length > 0 && (
                             <>
                               <DropdownMenuSeparator />
                               <div
                                 className={`flex items-center justify-between rounded-sm px-2 py-1.5 text-sm ${isGenerating ? 'opacity-40' : 'cursor-pointer hover:bg-accent'}`}
                                 onClick={() => { if (!isGenerating) setMcpActive(!mcpActive) }}
                               >
                                 <div className="flex items-center gap-2">
                                   <Cpu className="h-4 w-4 text-muted-foreground" />
                                   도구
                                   <span className="text-xs text-muted-foreground">
                                     {enabledMcpSkills.length}개
                                   </span>
                                 </div>
                                 <Switch
                                   checked={mcpActive}
                                   onCheckedChange={setMcpActive}
                                   disabled={isGenerating}
                                   className="scale-75"
                                 />
                               </div>
                               {mcpActive && (
                                 <div className="pl-4 pr-2 pb-1">
                                   {enabledMcpSkills.map(s => (
                                     <div key={s.id} className="flex items-center gap-2 py-0.5 text-xs text-muted-foreground">
                                       {s.server_type === 'skill'
                                         ? <Zap className="h-3 w-3 text-amber-500 shrink-0" />
                                         : <Check className="h-3 w-3 text-emerald-500 shrink-0" />
                                       }
                                       <span className="break-words">{s.display_name || s.name}</span>
                                     </div>
                                   ))}
                                 </div>
                               )}
                             </>
                           )}

                          <DropdownMenuSeparator />

                          {/* Image Attachment */}
                           <DropdownMenuItem
                             disabled={isGenerating || pendingImages.length >= MAX_PENDING_IMAGES}
                             onSelect={() => imageInputRef.current?.click()}
                           >
                             <ImageIcon className="h-4 w-4 mr-2 text-muted-foreground" />
                             <span>이미지 첨부</span>
                             {pendingImages.length > 0 && (
                               <span className="ml-auto text-xs text-muted-foreground">
                                 {pendingImages.length}/{MAX_PENDING_IMAGES}
                               </span>
                             )}
                           </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>

                      {activeDocumentId && selectedSegmentIds.length === 0 && (
                        <button
                          onClick={() => setIncludeDocContent(!includeDocContent)}
                          disabled={isGenerating}
                          className={`flex items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium transition-colors ${
                            includeDocContent
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted/50 text-muted-foreground hover:bg-muted'
                          } ${isGenerating ? 'opacity-50 cursor-not-allowed' : ''}`}
                          title={includeDocContent ? '문서 전체 내용이 AI에게 전달됩니다' : '클릭하면 문서 전체를 AI 컨텍스트에 포함합니다'}
                        >
                          <FileTextIcon weight="thin" className="h-3 w-3" />
                          문서 전체
                        </button>
                      )}
                      </div>

                      {/* Right: Model name + Send button */}
                      <div className="flex items-center gap-1.5">
                        {/* Model Name Popover */}
                        <Popover>
                          <PopoverTrigger asChild>
                            <button className="flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground transition-colors">
                              <span className="max-w-[140px] truncate">
                                {effectiveChatModel?.configured ? effectiveChatModel.display_name : '모델 없음'}
                              </span>
                              <ChevronDown className="h-3 w-3" />
                            </button>
                          </PopoverTrigger>
                          <PopoverContent side="top" align="end" className="w-80 p-2">
                            {chatModelOptions.length > 0 ? (
                              <div className="space-y-2">
                                <div className="px-1 text-[11px] text-muted-foreground">
                                  기본 설정 모델은 항상 표시되며, 추가 선택지는 OpenAI, Claude, Ollama의 멀티모달 모델 중심으로 보여집니다.
                                </div>
                                <div className="max-h-72 space-y-3 overflow-y-auto pr-1">
                                  {[
                                    ['openai', 'OpenAI'],
                                    ['claude', 'Claude'],
                                    ['ollama', 'Ollama'],
                                  ].map(([providerType, providerLabel]) => {
                                    const providerModels = chatModelOptions.filter((model) => model.type === providerType)
                                    if (providerModels.length === 0) return null

                                    return (
                                      <div key={providerType} className="space-y-1">
                                        <div className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                                          {providerLabel}
                                        </div>
                                        <div className="space-y-1">
                                          {providerModels.map((model) => {
                                            const modelKey = buildChatModelKey(model)
                                            const isSelected = selectedChatModelKey === modelKey
                                            const isDefault = buildChatModelKey(currentAIModel) === modelKey

                                            return (
                                              <button
                                                key={modelKey}
                                                type="button"
                                                onClick={() => setSelectedChatModelKey(modelKey)}
                                                className={`flex w-full items-start justify-between rounded-md px-2 py-2 text-left transition-colors ${isSelected ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/60'}`}
                                              >
                                                <div className="min-w-0">
                                                  <div className="truncate text-sm font-medium">{model.display_name}</div>
                                                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                                                    <span className="truncate">{model.model}</span>
                                                    {isDefault && <span className="rounded bg-primary/10 px-1 py-0.5 text-[10px] text-primary">기본값</span>}
                                                  </div>
                                                </div>
                                                {isSelected ? <Check className="mt-0.5 h-4 w-4 shrink-0 text-primary" /> : null}
                                              </button>
                                            )
                                          })}
                                        </div>
                                      </div>
                                    )
                                  })}
                                </div>
                              </div>
                            ) : (
                              <div className="p-2 text-sm text-muted-foreground">
                                사용 가능한 멀티모달 모델이 없습니다
                              </div>
                            )}
                          </PopoverContent>
                        </Popover>

                        {/* Send Button */}
                        <button
                          onClick={handleSendMessage}
                          disabled={isGenerating || (!inputText.trim() && pendingImages.length === 0)}
                          className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-40 disabled:pointer-events-none"
                          title="전송"
                        >
                          <ArrowUpIcon className="h-4 w-4" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </>
        </aside>
      </div>

            {/* 우클릭 삭제 컨텍스트 메뉴 (인라인 삭제버튼으로 대체하여 비활성)
            {fileContextMenu && (
        <div
          className="file-context-menu"
          style={{ top: fileContextMenu.y, left: fileContextMenu.x }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item danger"
            onClick={() => {
              handleDeleteFile(fileContextMenu.file.id)
              setFileContextMenu(null)
            }}
          >
            삭제
          </button>
        </div>
      )}
            */}

      <SettingsModal
        isOpen={showSettings}
        onAiModelSaved={() => loadCurrentAIModel({ syncSelectedToCurrent: true })}
        onClose={() => {
          setShowSettings(false)
          setSettingsInitialMenu(null)
          loadCurrentAIModel()
          loadUserKnowledgeDbs()
          loadPersonaSummary()
          quickActionsAPI.get().then(data => setQuickActions(data.actions || [])).catch(() => {})
          loadEnabledMcpSkills({ silent: true })
        }}
        userRole={userRole}
        initialMenu={settingsInitialMenu}
      />

      {/* MyInfoModal removed — now integrated into SettingsModal > 내정보 */}

      {/* Image Lightbox Modal */}
      <Dialog open={!!lightboxImage} onOpenChange={(open) => !open && setLightboxImage(null)}>
        <DialogContent className="max-w-[90vw] max-h-[90vh] p-2 flex items-center justify-center bg-black/90 border-none">
          {lightboxImage && (
            <img
              src={lightboxImage.url}
              alt={lightboxImage.alt || '첨부 이미지'}
              className="max-w-full max-h-[85vh] object-contain rounded"
            />
          )}
        </DialogContent>
      </Dialog>

      {/* Quick KB Create Dialog */}
      <Dialog open={quickKbDialogOpen} onOpenChange={setQuickKbDialogOpen}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>새 지식DB 추가</DialogTitle>
          </DialogHeader>
          <Input
            value={quickKbName}
            onChange={(e) => setQuickKbName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && handleQuickCreateKb()}
            placeholder="지식DB 이름"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setQuickKbDialogOpen(false)}>취소</Button>
            <Button onClick={handleQuickCreateKb} disabled={!quickKbName.trim()}>추가</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={reprocessDialog.open}
        onOpenChange={(open) => {
          if (!open) {
            setReprocessDialog({ open: false, fileId: null, filename: '', provider: 'opendataloader' })
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>문서 재분석</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="text-sm text-muted-foreground whitespace-pre-wrap">
              {`"${reprocessDialog.filename}" 문서를 다시 분석하시겠습니까?`}
            </div>
            <div className="text-xs text-muted-foreground">
              OpenDataLoader 엔진으로 변환부터 다시 시작합니다.
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setReprocessDialog({ open: false, fileId: null, filename: '', provider: 'opendataloader' })}
            >
              취소
            </Button>
            <Button onClick={handleConfirmReprocess}>확인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Chat Rename Dialog */}
      <Dialog open={renameDialog.open} onOpenChange={(open) => { if (!open) setRenameDialog({ open: false, sessionId: null, value: '' }) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>대화 이름 수정</DialogTitle>
          </DialogHeader>
          <Input
            value={renameDialog.value}
            onChange={(e) => setRenameDialog((prev) => ({ ...prev, value: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirmRename()}
            placeholder="대화 이름"
            autoFocus
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenameDialog({ open: false, sessionId: null, value: '' })}>취소</Button>
            <Button onClick={handleConfirmRename} disabled={!renameDialog.value.trim()}>확인</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Save Filename Dialog (editor save) */}
      <Dialog open={saveFilenameDialog.open} onOpenChange={(open) => { if (!open) setSaveFilenameDialog({ open: false, value: '' }) }}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>파일명 입력</DialogTitle>
          </DialogHeader>
          <Input
            value={saveFilenameDialog.value}
            onChange={(e) => setSaveFilenameDialog((prev) => ({ ...prev, value: e.target.value }))}
            onKeyDown={(e) => e.key === 'Enter' && handleConfirmSaveFilename()}
            placeholder="Untitled"
            autoFocus
          />
          <div className="text-xs text-muted-foreground">비워두면 Untitled.md로 저장됩니다.</div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSaveFilenameDialog({ open: false, value: '' })}>취소</Button>
            <Button onClick={handleConfirmSaveFilename}>저장</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Confirm Dialog (replaces window.confirm) */}
      <ConfirmDialog
        open={confirmDialog.open}
        onOpenChange={(open) => setConfirmDialog((prev) => ({ ...prev, open }))}
        title={confirmDialog.title}
        description={confirmDialog.description}
        confirmText={confirmDialog.confirmText}
        cancelText={confirmDialog.cancelText}
        variant={confirmDialog.variant}
        onConfirm={confirmDialog.onConfirm}
      />
    </div>
    </IconContext.Provider>
  )
}
