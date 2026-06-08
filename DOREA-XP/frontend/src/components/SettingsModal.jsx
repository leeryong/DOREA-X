import React, { useEffect, useState, useRef } from 'react'
import api, { quickActionsAPI, mcpAPI, userPersonaAPI, adminAiSettingsAPI } from '../services/api'
import { toast } from '../services/toast'
import AdminUsersPanel from './AdminUsersPanel'
import ConfirmDialog from './ConfirmDialog'
import AdminQueuePanel from './AdminQueuePanel'
import UserQueuePanel from './UserQueuePanel'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Checkbox } from "@/components/ui/checkbox"
import { Slider } from "@/components/ui/slider"
import { Progress } from "@/components/ui/progress"
import { NativeSelect, NativeSelectOptGroup, NativeSelectOption } from "@/components/ui/native-select"
import { Badge } from "@/components/ui/badge"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"

import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { DndContext, PointerSensor, useSensor, useSensors, closestCenter } from "@dnd-kit/core"
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import {
  IconContext,
  ArrowClockwiseIcon as RefreshCw,
  BrainIcon as Brain,
  CaretLeftIcon as ChevronLeft,
  CursorClickIcon as MousePointerClick,
  DatabaseIcon as Database,
  DotsSixVerticalIcon as GripVertical,
  DownloadSimpleIcon as Download,
  EyeIcon as Eye,
  FileArrowUpIcon as FileUp,
  FileTextIcon as FileText,
  FolderOpenIcon as FolderOpen,
  InfoIcon as Info,
  LightningIcon as Zap,
  ListNumbersIcon as ListOrdered,
  MagnifyingGlassIcon as Search,
  PencilSimpleIcon as Pencil,
  PlugIcon as Plug,
  PlusIcon as Plus,
  ShieldCheckIcon as ShieldCheck,
  SpinnerGapIcon as Loader2,
  TrashIcon as Trash2,
  UploadSimpleIcon as Upload,
  UserIcon as User,
  UsersThreeIcon as Users,
  XIcon as X,
} from '@phosphor-icons/react'
import { getFileIconUrl } from '@/lib/utils'
import {
  PERSONA_SECTIONS,
  PERSONA_SECTION_KEYS,
  PERSONA_LAYERS,
  PERSONA_DEFAULTS,
  HEADING_TO_SECTION_KEY,
  compilePersonaToMarkdown,
  parseMarkdownToSections,
  getResetTarget,
  createEmptySections,
} from '@/lib/persona/personaConfig'

// ========== AGENTS.md 스타일 정규화 ==========
// KNOWN_SECTIONS derived from persona config (single source of truth)
const KNOWN_SECTIONS = [
  ...PERSONA_SECTIONS.map(s => s.heading),
  ...PERSONA_SECTIONS.map(s => s.labelEn),
  '기타', 'Custom', '일반',   // legacy / customText headings
  '역할', '스타일', '제약', '지식', // legacy Korean headings
]

function normalizePersonaMarkdown(raw, titleOverride) {
  const text = (raw || '').trim()
  if (!text) return ''

  const lines = text.split('\n')

  // 이미 구조화된 마크다운인지 판별: # 또는 ## 헤더가 있는지
  const hasH1 = lines.some(l => /^# /.test(l))
  const hasH2 = lines.some(l => /^## /.test(l))

  // 이미 AGENTS.md 형태면 최소 정리만
  if (hasH1 && hasH2) {
    // 빈 줄 정리: 연속 3줄 이상 빈 줄 → 2줄로
    return text.replace(/\n{3,}/g, '\n\n').trim()
  }

  // 섹션 헤더(##)는 있는데 최상위(#)가 없으면 제목만 추가
  if (!hasH1 && hasH2) {
    const title = titleOverride || '페르소나'
    return `# ${title}\n\n${text.replace(/\n{3,}/g, '\n\n').trim()}`
  }

  // 구조 없는 자유 텍스트 → AGENTS.md 템플릿으로 래핑
  const title = titleOverride || '페르소나'

  // 줄 단위로 분류 시도: "- " 리스트가 있으면 그대로, 아니면 통째로
  const trimmed = text.replace(/\n{3,}/g, '\n\n').trim()

  return `# ${title}\n\n## 일반\n\n${trimmed}`
}

// File detail modal sub-component (chunks + metadata)
function FileDetailModal({ open, onOpenChange, file, kbId, formatBytes }) {
  const [chunks, setChunks] = useState([])
  const [totalChunks, setTotalChunks] = useState(0)
  const [chunksLoading, setChunksLoading] = useState(false)
  const [showChunks, setShowChunks] = useState(false)

  useEffect(() => {
    if (open && file && kbId && file.embedding_status === 'completed' && file.embedding_chunks > 0) {
      setChunksLoading(true)
      setShowChunks(false)
      api.get(`/knowledge-dbs/${kbId}/files/${file.file_id}/chunks?limit=100`)
        .then(res => {
          setChunks(res.data.chunks || [])
          setTotalChunks(res.data.total || 0)
        })
        .catch(() => { setChunks([]); setTotalChunks(0) })
        .finally(() => setChunksLoading(false))
    } else {
      setChunks([])
      setTotalChunks(0)
    }
  }, [open, file?.file_id, kbId])

  if (!open || !file) return null
  const ext = (file.original_filename || '').split('.').pop()?.toUpperCase() || '-'
  const fmtDate = (v) => v ? new Date(v).toLocaleString('ko-KR') : '-'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>파일 상세 정보</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 overflow-y-auto flex-1 min-h-0 pr-1">
          {/* File header */}
          <div className="flex items-center gap-3">
            <div className="flex items-center justify-center rounded-lg p-2 bg-muted">
              <img src={getFileIconUrl(file.original_filename)} alt="" className="h-8 w-8" draggable={false} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium text-sm truncate" title={file.original_filename}>{file.original_filename}</div>
              <div className="text-xs text-muted-foreground">{ext} · {formatBytes(file.file_size)}</div>
            </div>
          </div>
          <Separator />
          {/* Metadata grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">임베딩 상태</div>
              <Badge variant="secondary" className="text-xs">{file.embedding_status === 'completed' ? '완료' : file.embedding_status}</Badge>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">전체 청크</div>
              <div className="font-medium">{file.embedding_chunks ?? 0}개</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">임베딩 모델</div>
              <div className="font-medium truncate" title={file.embedding_model || '-'}>{file.embedding_model || '-'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">임베딩 시점</div>
              <div className="font-medium">{fmtDate(file.embedding_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">업로드 시점</div>
              <div className="font-medium">{fmtDate(file.uploaded_at)}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">페이지 수</div>
              <div className="font-medium">{file.total_pages || '-'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">MIME 타입</div>
              <div className="font-medium truncate text-xs" title={file.mime_type || '-'}>{file.mime_type || '-'}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-0.5">콘텐츠 버전</div>
              <div className="font-mono text-xs truncate" title={file.content_version || '-'}>{file.content_version || '-'}</div>
            </div>
          </div>

          {/* Chunks section */}
          {file.embedding_chunks > 0 && (
            <>
              <Separator />
              <div>
                <button
                  className="flex items-center gap-2 text-sm font-medium hover:underline cursor-pointer"
                  onClick={() => setShowChunks(v => !v)}
                >
                  <ChevronLeft className={`h-4 w-4 transition-transform ${showChunks ? '-rotate-90' : ''}`} />
                  청크 내용 ({totalChunks || file.embedding_chunks}개{totalChunks > 100 ? ', 최대 100개 표시' : ''})
                </button>
                {showChunks && (
                  <div className="mt-2 space-y-2">
                    {chunksLoading ? (
                      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
                        <Loader2 className="h-4 w-4 animate-spin" /> 청크 로딩 중...
                      </div>
                    ) : chunks.length === 0 ? (
                      <div className="text-sm text-muted-foreground py-2">청크 데이터를 불러올 수 없습니다.</div>
                    ) : (
                      chunks.map((c, i) => (
                        <div key={c.id || i} className="rounded-md border p-3 bg-muted/30 text-xs space-y-1">
                          <div className="flex items-center gap-2 text-muted-foreground">
                            <span className="font-mono font-medium">#{c.chunk_index ?? i}</span>
                            {c.page != null && <span>p.{c.page}</span>}
                            {c.segment_type && <Badge variant="outline" className="text-[10px] px-1 py-0">{c.segment_type}</Badge>}
                          </div>
                          <div className="whitespace-pre-wrap break-words text-foreground leading-relaxed">{c.text}</div>
                        </div>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

// Recommended vision models for quick download
// DOREA-XP 기본은 CPU 노트북 환경 가정. thinking 모델은 응답이 잘리는 이슈로 추천에서 제외한다.
const RECOMMENDED_VISION_MODELS = [
  { name: "qwen2.5vl:3b",    size: "~3.2GB", description: "초경량 · CPU 노트북 추천 (기본)" },
  { name: "qwen2.5vl:7b",    size: "~5GB",   description: "표준 · GPU 권장 (VRAM 8GB)" },
  { name: "llava-phi3:3.8b", size: "~2.9GB", description: "Microsoft phi3 기반 · CPU 가능" },
  { name: "gemma3:4b",       size: "~3.3GB", description: "Google 멀티모달 · 멀티링구얼" },
  { name: "gemma3:12b",      size: "~8.1GB", description: "균형 · GPU 권장 (VRAM 12GB)" },
]

const GPT5_FALLBACK_MODELS = ['gpt-5.4', 'gpt-5.4-mini', 'gpt-5.4-nano']
const DEFAULT_EMBEDDING_MODEL = 'bge-m3'
const OPENAI_EMBEDDING_MODELS = ['text-embedding-3-small', 'text-embedding-3-large']

const EMBEDDING_MODEL_LABELS = {
  'bge-m3': 'bge-m3',
  'text-embedding-3-small': 'text-embedding-3-small',
  'text-embedding-3-large': 'text-embedding-3-large',
}

const EMBEDDING_MODEL_DESCRIPTIONS = {
  'bge-m3': '기본 로컬 임베딩 모델입니다. OpenAI Key 없이 바로 문서 임베딩에 사용할 수 있습니다.',
  'text-embedding-3-small': 'OpenAI 기본 추천 임베딩 모델입니다. 비용과 품질 균형이 좋습니다.',
  'text-embedding-3-large': '더 높은 품질의 OpenAI 임베딩 모델입니다. 더 높은 비용이 들 수 있습니다.',
}

function normalizeAiModelType(modelType) {
  const normalized = String(modelType || '').trim().toLowerCase()
  if (normalized === 'paid') return 'openai'
  if (normalized === 'free') return 'ollama'
  if (normalized === 'openai' || normalized === 'claude' || normalized === 'ollama') return normalized
  return 'ollama'
}

function getPreferredModel(models, currentModel, fallbackModel = '') {
  if (currentModel && models.includes(currentModel)) return currentModel
  if (fallbackModel && models.includes(fallbackModel)) return fallbackModel
  return currentModel || fallbackModel || models[0] || ''
}

const OPENAI_MODEL_LABELS = {
  'gpt-5.4': 'GPT-5.4 (최신, 추천)',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.4-nano': 'GPT-5.4 Nano',
}

function getPreferredOpenaiModel(models, currentModel) {
  return getPreferredModel(models, currentModel, 'gpt-5.4') || GPT5_FALLBACK_MODELS[0]
}

function getOpenaiModelLabel(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase()
  if (OPENAI_MODEL_LABELS[normalized]) return OPENAI_MODEL_LABELS[normalized]

  const gptMatch = normalized.match(/^gpt-(\d+)(?:\.(\d+))?(?:-(mini|nano))?$/)
  if (gptMatch) {
    const [, major, minor, tier] = gptMatch
    return `GPT-${major}${minor ? `.${minor}` : ''}${tier ? ` ${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : ''}`
  }

  const reasoningMatch = normalized.match(/^(o\d)(?:-(mini|nano))?$/)
  if (reasoningMatch) {
    const [, family, tier] = reasoningMatch
    return `${family.toUpperCase()}${tier ? ` ${tier.charAt(0).toUpperCase()}${tier.slice(1)}` : ''}`
  }

  if (normalized === 'chatgpt-4o-latest') return 'ChatGPT-4o Latest'
  return modelId.toUpperCase()
}

function getClaudeModelLabel(modelId) {
  const normalized = String(modelId || '').trim().toLowerCase()
  const match = normalized.match(/^claude-(haiku|sonnet|opus)-(\d+)-(\d{1,2})(?:-\d+)?$/)
  if (match) {
    const [, family, major, minor] = match
    return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} ${major}.${minor}`
  }

  const latestMatch = normalized.match(/^claude-(haiku|sonnet|opus)-latest$/)
  if (latestMatch) {
    const family = latestMatch[1]
    return `Claude ${family.charAt(0).toUpperCase()}${family.slice(1)} Latest`
  }

  return modelId
}

function getEmbeddingModelLabel(modelId) {
  return EMBEDDING_MODEL_LABELS[modelId] || modelId
}

function getEmbeddingModelProvider(modelId) {
  return String(modelId || '').startsWith('text-embedding-') ? 'OpenAI' : 'Ollama'
}

function getAvailableEmbeddingModels(hasOpenaiKey) {
  return hasOpenaiKey ? [DEFAULT_EMBEDDING_MODEL, ...OPENAI_EMBEDDING_MODELS] : [DEFAULT_EMBEDDING_MODEL]
}

function isOpenaiEmbeddingModel(modelId) {
  return String(modelId || '').startsWith('text-embedding-')
}

function SortableQuickActionRow({ action, onEdit, onDelete, onToggleVisible }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: action.id })
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.75 : 1,
  }

  return (
    <div ref={setNodeRef} style={style} className="rounded-md border p-3 flex items-start justify-between gap-2 bg-background">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex h-6 w-6 items-center justify-center rounded hover:bg-muted text-muted-foreground"
            {...attributes}
            {...listeners}
            title="드래그하여 순서 변경"
          >
            <GripVertical className="h-3.5 w-3.5" />
          </button>
          <Badge variant="outline" className="text-xs shrink-0">{action.label}</Badge>
          {action.caption ? <span className="text-xs text-muted-foreground truncate">{action.caption}</span> : null}
        </div>
        <div className="text-xs text-muted-foreground mt-1 line-clamp-2">{action.prompt}</div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          variant="ghost"
          size="sm"
          className="h-6 px-2 text-xs"
          onClick={onToggleVisible}
          title={action.visible ? '채팅에 표시 중' : '채팅에서 숨김'}
        >
          {action.visible ? '보임' : '숨김'}
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={onEdit}>
          <Pencil className="h-[18px] w-[18px]" />
        </Button>
        <Button variant="ghost" size="icon" className="h-6 w-6 text-destructive" onClick={onDelete}>
          <Trash2 className="h-[18px] w-[18px]" />
        </Button>
      </div>
    </div>
  )
}

// ── Local UI primitives (kept local on purpose so they don't bloat shared components) ──
// FieldRow: 한 줄짜리 라벨-컨트롤 행. divide-y로 묶어 평면 폼을 만든다.
function FieldRow({ label, hint, children, htmlFor }) {
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0 flex-1">
        <label htmlFor={htmlFor} className="block text-sm">{label}</label>
        {hint ? <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div> : null}
      </div>
      <div className="flex shrink-0 items-center">{children}</div>
    </div>
  )
}

// Switch: shadcn Switch 없이 가벼운 자체 토글. role=switch + aria-checked.
function Switch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={!!checked}
      disabled={disabled}
      onClick={() => onChange?.(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors ${checked ? 'bg-primary' : 'bg-muted'} disabled:opacity-50`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-background shadow transition-transform ${checked ? 'translate-x-[18px]' : 'translate-x-[3px]'}`} />
    </button>
  )
}

export default function SettingsModal({ isOpen, onClose, userRole = 'user', initialMenu = null, onAiModelSaved }) {
  const [activeMenu, setActiveMenu] = useState('my-info')
  
  // Settings States - Document Analysis (opendataloader only)
  const [opendataloaderUseOcr, setOpendataloaderUseOcr] = useState(true)
  const [opendataloaderOcrLanguage, setOpendataloaderOcrLanguage] = useState('ko')
  const [opendataloaderKidsMerge, setOpendataloaderKidsMerge] = useState(true)

  // Settings States - AI Model
  const [modelType, setModelType] = useState('ollama')
  const [personaView, setPersonaView] = useState('default')
  const [openaiApiKey, setOpenaiApiKey] = useState('')
  const [openaiApiKeyInput, setOpenaiApiKeyInput] = useState('')
  const [openaiModel, setOpenaiModel] = useState(GPT5_FALLBACK_MODELS[0])
  const [openaiAvailableModels, setOpenaiAvailableModels] = useState(GPT5_FALLBACK_MODELS)
  const [claudeApiKey, setClaudeApiKey] = useState('')
  const [claudeApiKeyInput, setClaudeApiKeyInput] = useState('')
  const [claudeModel, setClaudeModel] = useState('')
  const [claudeAvailableModels, setClaudeAvailableModels] = useState([])
  const [ollamaModel, setOllamaModel] = useState('')
  const [ollamaModels, setOllamaModels] = useState([])
  const [embeddingModel, setEmbeddingModel] = useState(DEFAULT_EMBEDDING_MODEL)
  const [availableEmbeddingModels, setAvailableEmbeddingModels] = useState(() => getAvailableEmbeddingModels(false))
  const [ollamaStatus, setOllamaStatus] = useState('checking') // 'online' | 'offline' | 'checking'
  const [temperature, setTemperature] = useState(0.7)
  const [maxTokens, setMaxTokens] = useState(4000)
  
  // Ollama Pull State
  const [pullModelName, setPullModelName] = useState('')
  const [isPulling, setIsPulling] = useState(false)
  const [pullProgress, setPullProgress] = useState(null) // { status, total, completed }
  const pullLayersRef = useRef({}) // digest -> { total, completed }
  const eventSourceRef = useRef(null)
  
  // Ollama Delete State
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [deleteTargetModel, setDeleteTargetModel] = useState(null) // { name, size }
  const [deletingModelName, setDeletingModelName] = useState(null)
  
  // Validation State
  const [isValidatingKey, setIsValidatingKey] = useState(false)

  // Upload Policy State (read-only)
  const [uploadPolicy, setUploadPolicy] = useState(null)

  // RAG Settings State
  const [ragTopK, setRagTopK] = useState(3)
  const [ragMinSimilarity, setRagMinSimilarity] = useState(0.5)
  const [ragChunkSize, setRagChunkSize] = useState(1200)
  const [ragChunkOverlap, setRagChunkOverlap] = useState(180)

  // Knowledge DB State
  const [knowledgeDbs, setKnowledgeDbs] = useState([])
  const [selectedKb, setSelectedKb] = useState(null)
  const [kbActionTarget, setKbActionTarget] = useState(null)
  const [kbFiles, setKbFiles] = useState([])
  const [availableFiles, setAvailableFiles] = useState([])
  const [kbBulkActionLoading, setKbBulkActionLoading] = useState(null)
  const [kbCreateOpen, setKbCreateOpen] = useState(false)
  const [kbEditOpen, setKbEditOpen] = useState(false)
  const [kbDeleteOpen, setKbDeleteOpen] = useState(false)
  const [kbAddFilesOpen, setKbAddFilesOpen] = useState(false)
  const [kbName, setKbName] = useState('')
  const [kbDescription, setKbDescription] = useState('')
  const [kbLoading, setKbLoading] = useState(false)
  const [selectedFileIds, setSelectedFileIds] = useState([])
  const [moveFileSearch, setMoveFileSearch] = useState('')
  const [fileDetailOpen, setFileDetailOpen] = useState(false)
  const [fileDetailTarget, setFileDetailTarget] = useState(null)

  // ========== Quick Actions State ==========
  const [qaActions, setQaActions] = useState([])
  const [qaEditingIdx, setQaEditingIdx] = useState(null) // null | index number | 'new'
  const [qaForm, setQaForm] = useState({ id: '', label: '', caption: '', prompt: '' })
  const [qaSaving, setQaSaving] = useState(false)
  const qaSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }))

  // ========== 내정보 / Memory State ==========
  const [myInfoUser, setMyInfoUser] = useState(null)
  const [myInfoLoading, setMyInfoLoading] = useState(false)
  // ========== Persona Settings State ==========
  // Legacy string state (kept for load/save bridge)
  const [userPersonaDraft, setUserPersonaDraft] = useState('')
  const [userPersonaSaved, setUserPersonaSaved] = useState('')
  const [userPersonaSaving, setUserPersonaSaving] = useState(false)
  const [adminPersonaDraft, setAdminPersonaDraft] = useState('')
  const [adminPersonaSaved, setAdminPersonaSaved] = useState('')
  const [adminPersonaSaving, setAdminPersonaSaving] = useState(false)
  // Structured persona state (sections editor)
  const [userPersonaSections, setUserPersonaSections] = useState(() => ({ ...createEmptySections() }))
  const [userPersonaCustomText, setUserPersonaCustomText] = useState('')
  const [adminPersonaSections, setAdminPersonaSections] = useState(() => ({ ...createEmptySections() }))
  const [adminPersonaCustomText, setAdminPersonaCustomText] = useState('')
  // Reset confirmation modal state
  const [personaResetTarget, setPersonaResetTarget] = useState(null) // 'admin' | 'user' | null

  // Reset sub-navigation when modal opens (keep only top-level activeMenu)
  useEffect(() => {
    if (isOpen) {
      setSelectedKb(null)
      setKbActionTarget(null)
      setKbFiles([])
      setKbBulkActionLoading(null)
      setKbCreateOpen(false)
      setKbEditOpen(false)
      setKbDeleteOpen(false)
      setKbAddFilesOpen(false)
      setFileDetailOpen(false)
      setFileDetailTarget(null)
      setPersonaView('default')
      if (initialMenu) {
        setActiveMenu(initialMenu)
      }
    }
  }, [isOpen, initialMenu])

  const isAdmin = userRole === 'admin' || userRole === 'super_admin'

  // 모든 사용자 공통 데이터 로드 (지식DB 등)
  useEffect(() => {
    if (!isOpen) return

    let cancelled = false

    async function loadKnowledgeDbs() {
      try {
        const res = await api.get('/knowledge-dbs')
        if (cancelled) return
        setKnowledgeDbs(res.data || [])
      } catch (e) {
        // non-critical
      }
    }

    async function loadQuickActions() {
      try {
        const data = await quickActionsAPI.get()
        if (cancelled) return
        setQaActions(data.actions || [])
      } catch (e) {
        // non-critical
      }
    }

    async function loadMyInfo() {
      setMyInfoLoading(true)
      try {
        const res = await api.get('/auth/me')
        if (cancelled) return
        setMyInfoUser(res.data)
      } catch (e) { /* non-critical */ }
      finally { if (!cancelled) setMyInfoLoading(false) }
    }

    async function loadUserPersona() {
      try {
        const data = await userPersonaAPI.getPersona()
        if (cancelled) return
        const personaMarkdown = data.persona_custom_markdown || ''
        setUserPersonaDraft(personaMarkdown)
        setUserPersonaSaved(personaMarkdown)
        const parsed = parseMarkdownToSections(personaMarkdown)
        setUserPersonaSections(parsed.sections)
        setUserPersonaCustomText(parsed.customText)
      } catch (e) { /* non-critical */ }
    }

    loadKnowledgeDbs()
    loadQuickActions()
    loadMyInfo()
    loadUserPersona()

    return () => { cancelled = true }
  }, [isOpen])

  // 관리자 전용 데이터 로드
  useEffect(() => {
    if (!isOpen) return
    if (!isAdmin) return

    let cancelled = false
    
    async function loadDocAnalysis() {
       try {
         const res = await api.get('/settings/system/document-analysis')
         if (cancelled) return
         setOpendataloaderUseOcr(Boolean(res.data.opendataloader_use_ocr))
         setOpendataloaderOcrLanguage(res.data.opendataloader_ocr_language || 'ko')
         setOpendataloaderKidsMerge(Boolean(res.data.opendataloader_kids_merge))
       } catch (e) {
         // toast will be shown by interceptor
       }
     }

    async function loadAiModelSettings() {
      try {
        const res = await api.get('/settings/system/ai-model')
        if (cancelled) return
        const nextOpenaiModel = res.data.openai_model || GPT5_FALLBACK_MODELS[0]
        const nextClaudeModel = res.data.claude_model || ''
        setModelType(normalizeAiModelType(res.data.model_type))
        setOpenaiApiKey(res.data.openai_api_key || '')
        setOpenaiApiKeyInput(res.data.openai_api_key || '')
        setOpenaiModel(nextOpenaiModel)
        setClaudeApiKey(res.data.claude_api_key || '')
        setClaudeApiKeyInput(res.data.claude_api_key || '')
        setClaudeModel(nextClaudeModel)
        setOllamaModel(res.data.ollama_model || '')
        const nextAvailableEmbeddingModels = Array.isArray(res.data.available_embedding_models) && res.data.available_embedding_models.length > 0
          ? res.data.available_embedding_models
          : getAvailableEmbeddingModels(Boolean(res.data.openai_api_key))
        setAvailableEmbeddingModels(nextAvailableEmbeddingModels)
        setEmbeddingModel(getPreferredModel(nextAvailableEmbeddingModels, res.data.embedding_model, DEFAULT_EMBEDDING_MODEL))
        setTemperature(res.data.temperature ?? 0.7)
        setMaxTokens(res.data.max_tokens ?? 4000)
        // Load admin persona from settings
        const personaMarkdown = res.data.persona_default_markdown || ''
        setAdminPersonaDraft(personaMarkdown)
        setAdminPersonaSaved(personaMarkdown)
        // Parse into structured sections for editor
        const parsedAdmin = parseMarkdownToSections(personaMarkdown)
        setAdminPersonaSections(parsedAdmin.sections)
        setAdminPersonaCustomText(parsedAdmin.customText)

        if (res.data.openai_api_key) {
          await refreshOpenaiModelOptions(res.data.openai_api_key, nextOpenaiModel, { silent: true })
        } else {
          setOpenaiAvailableModels(GPT5_FALLBACK_MODELS)
        }

        if (res.data.claude_api_key) {
          await refreshClaudeModelOptions(res.data.claude_api_key, nextClaudeModel, { silent: true })
        } else {
          setClaudeAvailableModels(nextClaudeModel ? [nextClaudeModel] : [])
        }
      } catch (e) {
        // toast will be shown by interceptor
      }
    }

    async function loadOllamaModels() {
      try {
        const statusRes = await api.get('/ollama/status')
        if (cancelled) return
        setOllamaStatus(statusRes.data.status)
        
        if (statusRes.data.status === 'online') {
          const modelsRes = await api.get('/ollama/models')
          if (cancelled) return
          setOllamaModels(modelsRes.data.models || [])
        }
      } catch (e) {
        setOllamaStatus('offline')
      }
    }

    async function loadUploadPolicy() {
      try {
        const res = await api.get('/settings/system/upload-policy')
        if (cancelled) return
        setUploadPolicy(res.data)
      } catch (e) {
        // non-critical — settings page still works
      }
    }

    async function loadRagSettings() {
      try {
        const res = await api.get('/settings/system/rag')
        if (cancelled) return
        setRagTopK(res.data.top_k ?? 3)
        setRagMinSimilarity(res.data.min_similarity ?? 0.5)
        setRagChunkSize(res.data.chunk_size ?? 1200)
        setRagChunkOverlap(res.data.chunk_overlap ?? 180)
      } catch (e) {
        // non-critical
      }
    }

    loadDocAnalysis()
    loadAiModelSettings()
    loadOllamaModels()
    loadUploadPolicy()
    loadRagSettings()
    
    return () => { 
      cancelled = true
      // Cleanup SSE on unmount
      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }
    }
  }, [isOpen, isAdmin])

  async function saveDocAnalysisSettings() {
     if (!isAdmin) return
     try {
       await api.put('/settings/system/document-analysis', {
         opendataloader_use_ocr: opendataloaderUseOcr,
         opendataloader_ocr_language: opendataloaderOcrLanguage,
         opendataloader_kids_merge: opendataloaderKidsMerge
       })
       toast.success('설정이 저장되었습니다')
     } catch (e) {
       // toast will be shown by interceptor
     }
   }

  // ========== AI Model Functions ==========

  async function refreshOpenaiModelOptions(apiKey, preferredModel, { silent = false } = {}) {
    if (!apiKey) {
      setOpenaiAvailableModels(GPT5_FALLBACK_MODELS)
      setOpenaiModel((current) => getPreferredOpenaiModel(GPT5_FALLBACK_MODELS, preferredModel || current))
      const fallbackEmbeddingModels = getAvailableEmbeddingModels(false)
      setAvailableEmbeddingModels(fallbackEmbeddingModels)
      setEmbeddingModel((current) => getPreferredModel(fallbackEmbeddingModels, current, DEFAULT_EMBEDDING_MODEL))
      return false
    }

    try {
      const res = await api.post('/settings/system/ai-model/validate-openai-key', {
        api_key: apiKey,
      })

      if (!res.data.valid) {
        setOpenaiAvailableModels(GPT5_FALLBACK_MODELS)
        setOpenaiModel((current) => getPreferredOpenaiModel(GPT5_FALLBACK_MODELS, preferredModel || current))
        const fallbackEmbeddingModels = getAvailableEmbeddingModels(false)
        setAvailableEmbeddingModels(fallbackEmbeddingModels)
        setEmbeddingModel((current) => getPreferredModel(fallbackEmbeddingModels, current, DEFAULT_EMBEDDING_MODEL))
        if (!silent) toast.error(res.data.message)
        return false
      }

      const validatedModels = Array.isArray(res.data.models) && res.data.models.length > 0
        ? res.data.models
        : GPT5_FALLBACK_MODELS

      setOpenaiAvailableModels(validatedModels)
      setOpenaiModel((current) => getPreferredOpenaiModel(validatedModels, preferredModel || current))
      const nextEmbeddingModels = getAvailableEmbeddingModels(true)
      setAvailableEmbeddingModels(nextEmbeddingModels)
      setEmbeddingModel((current) => getPreferredModel(nextEmbeddingModels, current, DEFAULT_EMBEDDING_MODEL))

      if (!silent) toast.success(res.data.message)
      return true
    } catch (e) {
      setOpenaiAvailableModels(GPT5_FALLBACK_MODELS)
      setOpenaiModel((current) => getPreferredOpenaiModel(GPT5_FALLBACK_MODELS, preferredModel || current))
      const fallbackEmbeddingModels = getAvailableEmbeddingModels(false)
      setAvailableEmbeddingModels(fallbackEmbeddingModels)
      setEmbeddingModel((current) => getPreferredModel(fallbackEmbeddingModels, current, DEFAULT_EMBEDDING_MODEL))
      if (!silent) toast.error('OpenAI 모델 목록을 확인하지 못했습니다')
      return false
    }
  }

  async function refreshClaudeModelOptions(apiKey, preferredModel, { silent = false } = {}) {
    if (!apiKey) {
      const fallbackModels = preferredModel ? [preferredModel] : []
      setClaudeAvailableModels(fallbackModels)
      setClaudeModel((current) => getPreferredModel(fallbackModels, preferredModel || current))
      return false
    }

    try {
      const res = await api.post('/settings/system/ai-model/validate-claude-key', {
        api_key: apiKey,
      })

      if (!res.data.valid) {
        const fallbackModels = preferredModel ? [preferredModel] : []
        setClaudeAvailableModels(fallbackModels)
        setClaudeModel((current) => getPreferredModel(fallbackModels, preferredModel || current))
        if (!silent) toast.error(res.data.message)
        return false
      }

      const validatedModels = Array.isArray(res.data.models) ? res.data.models.filter(Boolean) : []
      setClaudeAvailableModels(validatedModels)
      setClaudeModel((current) => getPreferredModel(validatedModels, preferredModel || current))

      if (!silent) toast.success(res.data.message)
      return true
    } catch (e) {
      const fallbackModels = preferredModel ? [preferredModel] : []
      setClaudeAvailableModels(fallbackModels)
      setClaudeModel((current) => getPreferredModel(fallbackModels, preferredModel || current))
      if (!silent) toast.error('Claude 모델 목록을 확인하지 못했습니다')
      return false
    }
  }
  
  async function validateOpenaiKey() {
    if (!openaiApiKeyInput.trim()) {
      toast.error('API Key를 입력해주세요')
      return
    }
    
    setIsValidatingKey(true)
    try {
      const apiKey = openaiApiKeyInput.trim()
      const valid = await refreshOpenaiModelOptions(apiKey, openaiModel)

      if (valid) {
        setOpenaiApiKey(apiKey)
      } else {
        setOpenaiApiKeyInput('')
      }
    } catch (e) {
      toast.error('API Key 검증 중 오류가 발생했습니다')
      setOpenaiAvailableModels(GPT5_FALLBACK_MODELS)
      setOpenaiApiKeyInput('')
    } finally {
      setIsValidatingKey(false)
    }
  }

  async function validateClaudeKey() {
    if (!claudeApiKeyInput.trim()) {
      toast.error('API Key를 입력해주세요')
      return
    }

    setIsValidatingKey(true)
    try {
      const apiKey = claudeApiKeyInput.trim()
      const valid = await refreshClaudeModelOptions(apiKey, claudeModel)

      if (valid) {
        setClaudeApiKey(apiKey)
      } else {
        setClaudeApiKeyInput('')
      }
    } catch (e) {
      toast.error('API Key 검증 중 오류가 발생했습니다')
      setClaudeAvailableModels([])
      setClaudeApiKeyInput('')
    } finally {
      setIsValidatingKey(false)
    }
  }

  async function saveAiModelSettings() {
    if (!isAdmin) return
    
    // Validation
    if (modelType === 'openai' && !openaiApiKey) {
      toast.error('OpenAI API Key를 먼저 검증해주세요')
      return
    }
    if (modelType === 'openai' && !openaiModel) {
      toast.error('OpenAI 모델을 선택해주세요')
      return
    }
    if (modelType === 'claude' && !claudeApiKey) {
      toast.error('Claude API Key를 먼저 검증해주세요')
      return
    }
    if (modelType === 'claude' && !claudeModel) {
      toast.error('Claude 모델을 선택해주세요')
      return
    }
    if (modelType === 'ollama' && !ollamaModel) {
      toast.error('Ollama 모델을 선택해주세요')
      return
    }
    if (!embeddingModel) {
      toast.error('임베딩 모델을 선택해주세요')
      return
    }
    if (isOpenaiEmbeddingModel(embeddingModel) && !openaiApiKey) {
      toast.error('OpenAI 임베딩 모델을 사용하려면 OpenAI API Key를 먼저 검증해주세요')
      return
    }
    
    try {
      await api.put('/settings/system/ai-model', {
        model_type: modelType,
        openai_api_key: openaiApiKey,
        openai_model: openaiModel,
        claude_api_key: claudeApiKey,
        claude_model: claudeModel,
        ollama_model: ollamaModel,
        embedding_model: embeddingModel,
        temperature,
        max_tokens: maxTokens
      })

      try {
        if (modelType === 'ollama' && ollamaModel) {
          await api.post('/ollama/runtime/keep-alive', { model: ollamaModel })
        } else if (modelType !== 'ollama' && ollamaModel) {
          await api.post('/ollama/runtime/unload', { model: ollamaModel })
        }
      } catch (_) {
      }

      try {
        await onAiModelSaved?.()
      } catch (refreshError) {
        console.error('Failed to refresh chat model selection after AI model save:', refreshError)
      }

      toast.success('AI 모델 설정이 저장되었습니다')
    } catch (e) {
      // toast will be shown by interceptor
    }
  }

  async function saveEmbeddingModelSettings() {
    if (!isAdmin) return

    if (!embeddingModel) {
      toast.error('임베딩 모델을 선택해주세요')
      return
    }

    if (isOpenaiEmbeddingModel(embeddingModel) && !openaiApiKey) {
      toast.error('OpenAI 임베딩 모델을 사용하려면 먼저 LLM 모델 메뉴에서 OpenAI API Key를 검증해주세요')
      return
    }

    try {
      await api.put('/settings/system/ai-model', {
        embedding_model: embeddingModel,
        ...(openaiApiKey ? { openai_api_key: openaiApiKey } : {}),
      })
      toast.success('임베딩 모델 설정이 저장되었습니다')
    } catch (e) {
      // toast will be shown by interceptor
    }
  }

  // ========== Persona Save/Reset Handlers ==========
  async function saveUserPersona() {
    setUserPersonaSaving(true)
    try {
      const compiled = compilePersonaToMarkdown('user', userPersonaSections, userPersonaCustomText)
      await userPersonaAPI.updatePersona(compiled)
      setUserPersonaDraft(compiled)
      setUserPersonaSaved(compiled)
      toast.success('내 페르소나가 저장되었습니다')
    } catch (e) {
      // toast will be shown by interceptor
    } finally {
      setUserPersonaSaving(false)
    }
  }

  function resetUserPersona() {
    setPersonaResetTarget('user')
  }

  function confirmResetUserPersona() {
    const parsed = parseMarkdownToSections(userPersonaSaved)
    setUserPersonaSections(parsed.sections)
    setUserPersonaCustomText(parsed.customText)
    setUserPersonaDraft(userPersonaSaved)
    toast.success('내 페르소나가 초기화되었습니다')
  }

  async function saveAdminPersona() {
    setAdminPersonaSaving(true)
    try {
      const compiled = compilePersonaToMarkdown('admin', adminPersonaSections, adminPersonaCustomText)
      await adminAiSettingsAPI.updatePersona(compiled)
      setAdminPersonaDraft(compiled)
      setAdminPersonaSaved(compiled)
      toast.success('기본 페르소나가 저장되었습니다')
    } catch (e) {
      // toast will be shown by interceptor
    } finally {
      setAdminPersonaSaving(false)
    }
  }

  function resetAdminPersona() {
    setPersonaResetTarget('admin')
  }

  function confirmResetAdminPersona() {
    const parsed = parseMarkdownToSections(adminPersonaSaved)
    setAdminPersonaSections(parsed.sections)
    setAdminPersonaCustomText(parsed.customText)
    setAdminPersonaDraft(adminPersonaSaved)
    toast.success('기본 페르소나가 초기화되었습니다')
  }

  function handlePersonaResetConfirm() {
    if (personaResetTarget === 'user') confirmResetUserPersona()
    else if (personaResetTarget === 'admin') confirmResetAdminPersona()
    setPersonaResetTarget(null)
  }

  async function saveRagSettings() {
    if (!isAdmin) return
    try {
      await api.put('/settings/system/rag', {
        top_k: ragTopK,
        min_similarity: ragMinSimilarity,
        chunk_size: ragChunkSize,
        chunk_overlap: ragChunkOverlap,
      })
      toast.success('RAG 설정이 저장되었습니다')
    } catch (e) {
      // toast will be shown by interceptor
    }
  }

  // ========== Knowledge DB Functions ==========

  async function refreshKnowledgeDbs() {
    try {
      const res = await api.get('/knowledge-dbs')
      const list = res.data || []
      setKnowledgeDbs(list)
      // Sync selectedKb with fresh data so badges (file_count, total_chunks) update
      setSelectedKb(prev => prev ? list.find(kb => kb.id === prev.id) || null : null)
    } catch (e) { /* interceptor handles */ }
  }

  async function createKnowledgeDb() {
    if (!kbName.trim()) { toast.error('이름을 입력해주세요'); return }
    setKbLoading(true)
    try {
      await api.post('/knowledge-dbs', { name: kbName.trim(), description: kbDescription.trim() || null })
      toast.success('지식DB가 생성되었습니다')
      setKbCreateOpen(false)
      setKbName('')
      setKbDescription('')
      await refreshKnowledgeDbs()
    } catch (e) { /* interceptor */ }
    finally { setKbLoading(false) }
  }

  async function updateKnowledgeDb() {
    const targetKb = kbActionTarget || selectedKb
    if (!targetKb || !kbName.trim()) return
    setKbLoading(true)
    try {
      const nextName = kbName.trim()
      const nextDescription = kbDescription.trim() || null
      await api.put(`/knowledge-dbs/${targetKb.id}`, { name: nextName, description: nextDescription })
      toast.success('지식DB가 수정되었습니다')
      setKbEditOpen(false)
      setKbActionTarget(null)
      await refreshKnowledgeDbs()
      setSelectedKb(prev => prev && prev.id === targetKb.id ? { ...prev, name: nextName, description: nextDescription } : prev)
    } catch (e) { /* interceptor */ }
    finally { setKbLoading(false) }
  }

  async function deleteKnowledgeDb() {
    const targetKb = kbActionTarget || selectedKb
    if (!targetKb) return
    setKbLoading(true)
    try {
      await api.delete(`/knowledge-dbs/${targetKb.id}`)
      toast.success('지식DB가 삭제되었습니다')
      setKbDeleteOpen(false)
      setKbActionTarget(null)
      setSelectedKb(prev => prev && prev.id === targetKb.id ? null : prev)
      setKbFiles(prev => selectedKb && selectedKb.id === targetKb.id ? [] : prev)
      await refreshKnowledgeDbs()
    } catch (e) { /* interceptor */ }
    finally { setKbLoading(false) }
  }

  async function loadKbFiles(kbId) {
    try {
      const res = await api.get(`/knowledge-dbs/${kbId}/files`)
      setKbFiles(res.data || [])
    } catch (e) { setKbFiles([]) }
  }

  async function loadAvailableFiles(kbId) {
    try {
      const res = await api.get(`/knowledge-dbs/${kbId}/available-files`)
      setAvailableFiles(res.data || [])
    } catch (e) { setAvailableFiles([]) }
  }

  async function addFilesToKb() {
    if (!selectedKb || selectedFileIds.length === 0) return
    setKbLoading(true)
    try {
      const res = await api.post(`/knowledge-dbs/${selectedKb.id}/files`, { file_ids: selectedFileIds })
      toast.success(res.data.message || '파일이 추가되었습니다')
      setKbAddFilesOpen(false)
      setSelectedFileIds([])
      await loadKbFiles(selectedKb.id)
      await refreshKnowledgeDbs()
    } catch (e) { /* interceptor */ }
    finally { setKbLoading(false) }
  }

  async function removeFileFromKb(fileId) {
    if (!selectedKb) return
    try {
      await api.delete(`/knowledge-dbs/${selectedKb.id}/files/${fileId}`)
      toast.success('파일이 제거되었습니다')
      await loadKbFiles(selectedKb.id)
      await refreshKnowledgeDbs()
    } catch (e) { /* interceptor */ }
  }

  async function embedFileInKb(fileId) {
    if (!selectedKb) return
    try {
      await api.post(`/knowledge-dbs/${selectedKb.id}/files/${fileId}/embed`)
      toast.success('임베딩이 시작되었습니다')
      await loadKbFiles(selectedKb.id)
      await refreshKnowledgeDbs()
    } catch (e) {
      const msg = e?.response?.data?.message || '임베딩 요청 실패'
      toast.error(msg)
    }
  }

  async function embedAllFilesInKb(mode) {
    if (!selectedKb) return

    setKbBulkActionLoading(mode)
    try {
      const res = await api.post(`/knowledge-dbs/${selectedKb.id}/embed`, { mode })
      const payload = res.data || {}
      const scheduledCount = Number(payload.scheduled_count || 0)
      const message = payload.message || (mode === 'all' ? '전체 재임베딩을 시작했습니다' : '임베딩을 시작했습니다')

      if (scheduledCount > 0) {
        toast.success(message)
      } else {
        toast.info(message)
      }

      await loadKbFiles(selectedKb.id)
      await refreshKnowledgeDbs()
    } catch (e) {
      // toast will be shown by interceptor
    } finally {
      setKbBulkActionLoading(null)
    }
  }

  // 임베딩 진행 중인 파일이 있으면 자동 폴링 (3초 간격)
  const hasProcessingFiles = kbFiles.some(f => f.embedding_status === 'pending' || f.embedding_status === 'processing')
  const hasEmbeddableKbFiles = kbFiles.some(f => f.status === 'completed' && (f.embedding_status === 'none' || f.embedding_status === 'failed'))
  const hasCompletedKbFiles = kbFiles.some(f => f.status === 'completed')
  const selectedKbRef = useRef(selectedKb)
  selectedKbRef.current = selectedKb

  useEffect(() => {
    if (!hasProcessingFiles || !selectedKbRef.current) return

    const interval = setInterval(async () => {
      const kb = selectedKbRef.current
      if (!kb) return
      try {
        const res = await api.get(`/knowledge-dbs/${kb.id}/files`)
        setKbFiles(res.data || [])
        // 더 이상 processing 파일이 없으면 KB 목록도 갱신
        const stillProcessing = (res.data || []).some(
          (f) => f.embedding_status === 'pending' || f.embedding_status === 'processing'
        )
        if (!stillProcessing) {
          refreshKnowledgeDbs()
        }
      } catch (_) { /* ignore polling errors */ }
    }, 3000)

    return () => clearInterval(interval)
  }, [hasProcessingFiles])

  function openKbDetail(kb) {
    setSelectedKb(kb)
    loadKbFiles(kb.id)
  }

  function openEditDialogForKb(kb) {
    if (!kb) return
    setKbActionTarget(kb)
    setKbName(kb.name)
    setKbDescription(kb.description || '')
    setKbEditOpen(true)
  }

  function openDeleteDialogForKb(kb) {
    if (!kb) return
    setKbActionTarget(kb)
    setKbDeleteOpen(true)
  }

  function openCreateDialog() {
    setKbName('')
    setKbDescription('')
    setKbCreateOpen(true)
  }

  function openEditDialog() {
    openEditDialogForKb(selectedKb)
  }

  function handleKbEditInputKeyDown(e) {
    if (e.key !== 'Enter' || e.nativeEvent?.isComposing) return
    e.preventDefault()
    if (!kbLoading && kbName.trim()) {
      updateKnowledgeDb()
    }
  }

  function openAddFilesDialog() {
    if (!selectedKb) return
    setSelectedFileIds([])
    setMoveFileSearch('')
    loadAvailableFiles(selectedKb.id)
    setKbAddFilesOpen(true)
  }

  const MAX_MOVE_FILES = 50
  function toggleFileSelection(fileId) {
    setSelectedFileIds(prev => {
      if (prev.includes(fileId)) return prev.filter(id => id !== fileId)
      if (prev.length >= MAX_MOVE_FILES) {
        toast.warning(`한 번에 최대 ${MAX_MOVE_FILES}개까지 선택할 수 있습니다.`)
        return prev
      }
      return [...prev, fileId]
    })
  }

  async function refreshOllamaModels() {
    try {
      const statusRes = await api.get('/ollama/status')
      setOllamaStatus(statusRes.data.status)
      
      if (statusRes.data.status === 'online') {
        const modelsRes = await api.get('/ollama/models')
        setOllamaModels(modelsRes.data.models || [])
        toast.success('모델 목록을 새로고침했습니다')
      } else {
        toast.error('Ollama 서비스에 연결할 수 없습니다')
      }
    } catch (e) {
      setOllamaStatus('offline')
    }
  }

  function startPullModel(modelNameOverride) {
    const modelToPull = modelNameOverride || pullModelName.trim()
    if (!modelToPull) {
      toast.error('다운로드할 모델 이름을 입력해주세요')
      return
    }
    
    // Update pullModelName if using override
    if (modelNameOverride) {
      setPullModelName(modelNameOverride)
    }
    
    setIsPulling(true)
    setPullProgress({ status: 'starting', total: 0, completed: 0 })
    pullLayersRef.current = {}
    
    // Use fetch with streaming instead of EventSource for POST
    const token = localStorage.getItem('access_token')
    
    fetch('/api/ollama/pull', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({ model: modelToPull })
    }).then(async response => {
      const reader = response.body?.getReader?.()
      if (!reader) {
        console.error('[Ollama Pull] No reader available')
        toast.error('다운로드 스트리밍을 시작할 수 없습니다')
        setIsPulling(false)
        setPullProgress(null)
        return
      }

      const decoder = new TextDecoder()
      let buffer = ''

      function processEvent(rawEvent) {
        const dataLines = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))

        if (!dataLines.length) return true

        const dataStr = dataLines
          .map((line) => line.replace(/^data:\s?/, ''))
          .join('\n')
          .trim()

        if (!dataStr) return true

        try {
          const data = JSON.parse(dataStr)

          if (data.status === 'error') {
            toast.error(data.error || '다운로드 오류')
            setIsPulling(false)
            setPullProgress(null)
            return false
          }

          if (data.status === 'success') {
            toast.success(`모델 '${modelToPull}' 다운로드 완료!`)
            setIsPulling(false)
            setPullProgress(null)
            setPullModelName('')
            refreshOllamaModels()
            return false
          }

          // Aggregate layer progress for single overall progress bar
          // Ollama sends digest when downloading layers
          if (data.digest) {
            const prev = pullLayersRef.current[data.digest] || { total: 0, completed: 0 }
            pullLayersRef.current[data.digest] = {
              total: data.total ?? prev.total ?? 0,
              completed: data.completed ?? prev.completed ?? 0,
            }

            const layers = Object.values(pullLayersRef.current)
            const overallTotal = layers.reduce((sum, v) => sum + (v.total || 0), 0)
            const overallCompleted = layers.reduce((sum, v) => sum + (v.completed || 0), 0)

            setPullProgress({
              status: data.status || 'downloading',
              total: overallTotal,
              completed: overallCompleted,
            })
          } else {
            // Non-downloading status (pulling manifest, verifying, etc.)
            // Keep total/completed, just update status text
            setPullProgress((prev) => ({
              ...(prev || { total: 0, completed: 0 }),
              status: data.status || prev?.status || 'starting',
            }))
          }
        } catch (e) {
          console.warn('[Ollama Pull] Parse error:', e, 'Raw:', dataStr)
        }

        return true
      }

      function flushBuffer() {
        while (true) {
          const match = buffer.match(/\r?\n\r?\n/)
          if (!match) break

          const rawEvent = buffer.slice(0, match.index)
          buffer = buffer.slice(match.index + match[0].length)

          const shouldContinue = processEvent(rawEvent)
          if (!shouldContinue) return false
        }
        return true
      }

      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        const chunk = decoder.decode(value, { stream: true })
        buffer += chunk

        const shouldContinue = flushBuffer()
        if (!shouldContinue) return
      }

      buffer += decoder.decode()
      flushBuffer()

      setIsPulling(false)
      setPullProgress(null)
    }).catch(err => {
      console.error('Pull error:', err)
      toast.error('모델 다운로드 중 오류가 발생했습니다')
      setIsPulling(false)
      setPullProgress(null)
    })
  }

  function cancelPull() {
    // Note: Ollama doesn't support cancelling pull, just close UI
    setIsPulling(false)
    setPullProgress(null)
  }

  function openDeleteDialog(model) {
    setDeleteTargetModel(model)
    setDeleteDialogOpen(true)
  }

  async function confirmDeleteModel() {
    if (!deleteTargetModel) return
    
    const modelName = deleteTargetModel.name
    const wasSelectedModel = ollamaModel === modelName
    setDeletingModelName(modelName)
    setDeleteDialogOpen(false)
    
    try {
      await api.delete(`/ollama/models/${encodeURIComponent(modelName)}`)
      toast.success(`모델 '${modelName}'이 삭제되었습니다`)
      
      // Remove from list immediately
      setOllamaModels((prev) => prev.filter((m) => m.name !== modelName))
      
      // If deleted model was the selected Ollama model, clear selection and save to DB
      if (wasSelectedModel && modelType === 'free') {
        setOllamaModel('')
        try {
          await api.put('/settings/system/ai-model', {
            model_type: modelType,
            openai_api_key: openaiApiKey,
            openai_model: openaiModel,
            ollama_model: '',
            temperature,
            max_tokens: maxTokens
          })
        } catch (e) {
          // Ignore save error, local state is already cleared
        }
        toast.warning('사용 중인 모델이 삭제되어 모델 선택이 초기화되었습니다. 새 모델을 선택해주세요.')
      }
    } catch (err) {
      const msg = err.response?.data?.detail?.message || err.message || '삭제 실패'
      toast.error(msg)
    } finally {
      setDeletingModelName(null)
      setDeleteTargetModel(null)
    }
  }

  function formatBytes(bytes) {
    if (!bytes) return '0 B'
    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i]
  }

  if (!isOpen) return null

  const menuGroups = [
    {
      label: '내 계정',
      items: [
        { id: 'my-info', label: '내 정보', icon: User, role: 'all' },
      ]
    },
    {
      label: '기본 설정',
      items: [
        { id: 'ai-persona', label: '에이전트 페르소나', icon: User, role: 'all' },
        { id: 'ai-model', label: 'LLM 모델', icon: Brain, role: 'all' },
        { id: 'embedding-model', label: '임베딩 모델', icon: Database, role: 'all' },
        { id: 'doc-analysis', label: '문서구조 분석', icon: FileText, role: 'all' },
      ]
    },
    {
      label: '고급 설정',
      items: [
        { id: 'knowledge-db', label: '지식베이스', icon: FolderOpen, role: 'all' },
        { id: 'quick-actions', label: '빠른 메뉴', icon: MousePointerClick, role: 'all' },
        { id: 'rag', label: 'RAG 설정', icon: Database, role: 'admin' },
        { id: 'mcp', label: 'MCP', icon: Plug, role: 'all' },
      ]
    },
    {
      label: '관리',
      items: [
        { id: 'admin-users', label: '회원관리', icon: Users, role: 'admin' },
        { id: 'admin-queue', label: '처리현황', icon: ListOrdered, role: 'all' },
      ]
    }
  ]

  const filteredMenuGroups = menuGroups
    .map(group => ({
      ...group,
      items: group.items.filter(m => m.role === 'all' || (m.role === 'admin' && isAdmin))
    }))
    .filter(group => group.items.length > 0)

  // Joined panel layout: one outer panel with internal divider
  const settingsSidebarSurfaceClassName = 'bg-muted/70'
  const sidebarClassName = `w-56 shrink-0 ${settingsSidebarSurfaceClassName} border-r border-border`
  const panelShellClassName = 'flex flex-1 min-h-0 overflow-hidden rounded-lg border border-border bg-card shadow-sm'


  return (
    <IconContext.Provider value={{ weight: 'thin' }}>
    <>
    <Dialog open={isOpen} onOpenChange={(v) => { if (!v) onClose?.() }}>
      <DialogContent className="w-[92vw] max-w-[120rem] sm:max-w-[120rem] h-[85vh] flex flex-col overflow-hidden">
        <DialogHeader>
          <DialogTitle>설정</DialogTitle>
        </DialogHeader>

        <div className={panelShellClassName}>
          {/* Sidebar */}
          <aside className={sidebarClassName}>
            <ScrollArea className="h-full p-2">
              <div className="flex flex-col gap-4">
                {filteredMenuGroups.map((group, groupIndex) => (
                  <div key={group.label}>
                    {groupIndex > 0 && <Separator className="mb-4" />}
                    <div className="px-2 mb-2 text-xs font-medium text-muted-foreground uppercase tracking-wider">
                      {group.label}
                    </div>
                    <div className="flex flex-col gap-1">
                      {group.items.map((menu) => {
                        const Icon = menu.icon
                        const isActive = activeMenu === menu.id
                        return (
                          <Button
                            key={menu.id}
                            variant="ghost"
                            className={`justify-start gap-3 pl-3 ${isActive ? 'bg-accent/80 font-medium text-foreground' : 'text-muted-foreground hover:text-foreground'}`}
                            onClick={() => setActiveMenu(menu.id)}
                          >
                            <span
                              aria-hidden="true"
                              className={`h-1.5 w-1.5 rounded-full shrink-0 transition-colors ${isActive ? 'bg-primary' : 'bg-transparent'}`}
                            />
                            <Icon className="h-6 w-6" />
                            <span className="flex-1 text-left">{menu.label}</span>
                            {menu.badge && (
                              <Badge variant="outline" className="text-[10px] px-1.5 py-0">
                                {menu.badge}
                              </Badge>
                            )}
                          </Button>
                        )
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </aside>

          {/* Content */}
          <div className="flex-1 min-w-0 min-h-0 flex flex-col">
            <div className="flex-1 min-h-0 overflow-auto p-6">
              {activeMenu === 'doc-analysis' && (
                <div className="space-y-7">
                  <div className="flex items-baseline justify-between">
                    <h2 className="text-base font-semibold">OCR / Layout 분석</h2>
                    <span className="text-xs text-muted-foreground">DOREA-XP는 OpenDataLoader만 사용합니다</span>
                  </div>

                  <div className="rounded-md border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
                    OpenDataLoader 단일 엔진 (CPU)
                  </div>

                  <div className="divide-y border-y">
                    <FieldRow label="OCR 사용" hint="Hybrid 모드 기본 적용">
                      <Switch checked={opendataloaderUseOcr} onChange={(v) => setOpendataloaderUseOcr(v)} />
                    </FieldRow>
                    <FieldRow label="OCR 기본 언어" hint="자동 판별 실패 시 사용">
                      <NativeSelect value={opendataloaderOcrLanguage} onChange={(e) => setOpendataloaderOcrLanguage(e.target.value)} className="w-[180px]">
                        <NativeSelectOption value="ko">한국어</NativeSelectOption>
                        <NativeSelectOption value="en">영어</NativeSelectOption>
                        <NativeSelectOption value="ja">일본어</NativeSelectOption>
                        <NativeSelectOption value="zh">중국어(간체)</NativeSelectOption>
                      </NativeSelect>
                    </FieldRow>
                    <FieldRow label="Kids 병합" hint="Kids 컴포넌트를 단일 세그먼트로">
                      <Switch checked={opendataloaderKidsMerge} onChange={(v) => setOpendataloaderKidsMerge(v)} />
                    </FieldRow>
                  </div>

                  <div className="flex justify-end">
                    <Button onClick={saveDocAnalysisSettings} size="sm">저장</Button>
                  </div>
                </div>
              )}


            {activeMenu === 'ai-model' && (() => {
              const providers = [
                { id: 'openai', label: 'OpenAI', meta: 'cloud · paid' },
                { id: 'claude', label: 'Claude', meta: 'cloud · paid' },
                { id: 'ollama', label: 'Ollama', meta: 'local · free' },
              ]
              const ollamaTotalSize = ollamaModels.reduce((s, m) => s + (m.size || 0), 0)

              return (
              <div className="space-y-8">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-base font-semibold">LLM</h2>
                  <span className="text-xs text-muted-foreground">
                    {modelType === 'openai' && (openaiApiKey ? `${openaiModel || '모델 미선택'}` : 'API Key 미검증')}
                    {modelType === 'claude' && (claudeApiKey ? `${claudeModel || '모델 미선택'}` : 'API Key 미검증')}
                    {modelType === 'ollama' && (ollamaStatus === 'online' ? `${ollamaModels.length}개 설치 · ${formatBytes(ollamaTotalSize)}` : ollamaStatus === 'offline' ? '오프라인' : '확인 중')}
                  </span>
                </div>

                {/* Provider tab bar — flat underline style */}
                <div className="flex border-b">
                  {providers.map(p => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => setModelType(p.id)}
                      className={`relative -mb-px flex items-center gap-2 border-b-2 px-4 py-2 text-sm transition-colors ${modelType === p.id ? 'border-foreground text-foreground' : 'border-transparent text-muted-foreground hover:text-foreground'}`}
                    >
                      <span>{p.label}</span>
                      <span className="text-[10px] uppercase tracking-wide opacity-60">{p.meta}</span>
                    </button>
                  ))}
                </div>

                {/* Provider-specific body */}
                {modelType === 'openai' && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-[140px_1fr] items-center gap-x-6 gap-y-3">
                      <label className="text-sm">API Key</label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="password"
                          value={openaiApiKeyInput}
                          onChange={e => setOpenaiApiKeyInput(e.target.value)}
                          placeholder="sk-…"
                          className="flex-1"
                        />
                        <Button onClick={validateOpenaiKey} disabled={isValidatingKey || !openaiApiKeyInput.trim()} size="sm">
                          {isValidatingKey ? '검증 중' : '검증'}
                        </Button>
                      </div>
                      <span />
                      <div className="text-xs">
                        {openaiApiKey ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 검증됨
                          </span>
                        ) : (
                          <span className="text-muted-foreground">검증 후 모델 목록이 열립니다</span>
                        )}
                      </div>

                      <label className="text-sm">모델</label>
                      <NativeSelect value={openaiModel} onChange={(e) => setOpenaiModel(e.target.value)} disabled={!openaiApiKey} className="w-full">
                        <NativeSelectOptGroup label="GPT-5.3+ 멀티모달">
                          {openaiAvailableModels.map((modelId) => (
                            <NativeSelectOption key={modelId} value={modelId}>{getOpenaiModelLabel(modelId)}</NativeSelectOption>
                          ))}
                        </NativeSelectOptGroup>
                      </NativeSelect>
                    </div>
                  </div>
                )}

                {modelType === 'claude' && (
                  <div className="space-y-6">
                    <div className="grid grid-cols-[140px_1fr] items-center gap-x-6 gap-y-3">
                      <label className="text-sm">API Key</label>
                      <div className="flex items-center gap-2">
                        <Input
                          type="password"
                          value={claudeApiKeyInput}
                          onChange={e => setClaudeApiKeyInput(e.target.value)}
                          placeholder="sk-ant-…"
                          className="flex-1"
                        />
                        <Button onClick={validateClaudeKey} disabled={isValidatingKey || !claudeApiKeyInput.trim()} size="sm">
                          {isValidatingKey ? '검증 중' : '검증'}
                        </Button>
                      </div>
                      <span />
                      <div className="text-xs">
                        {claudeApiKey ? (
                          <span className="inline-flex items-center gap-1.5 text-emerald-600">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 검증됨
                          </span>
                        ) : (
                          <span className="text-muted-foreground">검증 후 Haiku/Sonnet/Opus 노출</span>
                        )}
                      </div>

                      <label className="text-sm">모델</label>
                      <NativeSelect value={claudeModel} onChange={(e) => setClaudeModel(e.target.value)} disabled={!claudeApiKey} className="w-full">
                        <NativeSelectOption value="">— 선택 —</NativeSelectOption>
                        {claudeAvailableModels.map((modelId) => (
                          <NativeSelectOption key={modelId} value={modelId}>{getClaudeModelLabel(modelId)}</NativeSelectOption>
                        ))}
                      </NativeSelect>
                    </div>
                  </div>
                )}

                {modelType === 'ollama' && (
                  <div className="space-y-6">
                    {/* status header */}
                    <div className="flex items-center justify-between text-xs">
                      <span className="inline-flex items-center gap-1.5">
                        <span className={`h-1.5 w-1.5 rounded-full ${ollamaStatus === 'online' ? 'bg-emerald-500' : ollamaStatus === 'offline' ? 'bg-red-500' : 'bg-zinc-400'}`} />
                        <span className="text-muted-foreground">
                          {ollamaStatus === 'online' ? '연결됨' : ollamaStatus === 'offline' ? '연결 안 됨' : '확인 중'}
                        </span>
                      </span>
                      <button type="button" onClick={refreshOllamaModels} className="text-muted-foreground hover:text-foreground">새로고침</button>
                    </div>

                    {ollamaStatus === 'offline' ? (
                      <div className="rounded-md border border-destructive/30 bg-destructive/5 p-4 text-sm">
                        <div className="font-medium text-destructive">Ollama에 연결할 수 없습니다.</div>
                        <div className="mt-1 text-xs text-muted-foreground">Docker Compose에서 ollama 컨테이너 상태를 확인하세요.</div>
                        <Button variant="outline" size="sm" className="mt-3" onClick={refreshOllamaModels}>다시 시도</Button>
                      </div>
                    ) : (
                      <>
                        {/* 사용 중 모델 */}
                        <div className="grid grid-cols-[140px_1fr] items-center gap-x-6 gap-y-3">
                          <label className="text-sm">사용 모델</label>
                          {ollamaModels.length > 0 ? (
                            <NativeSelect value={ollamaModel} onChange={(e) => setOllamaModel(e.target.value)} className="w-full">
                              <NativeSelectOption value="">— 선택 —</NativeSelectOption>
                              {ollamaModels.map(m => (
                                <NativeSelectOption key={m.name} value={m.name}>
                                  {m.name} · {formatBytes(m.size)}{m.vision ? ' · Vision' : ''}
                                </NativeSelectOption>
                              ))}
                            </NativeSelect>
                          ) : (
                            <div className="text-xs text-muted-foreground">설치된 모델 없음</div>
                          )}
                        </div>

                        {/* 신규 다운로드 */}
                        <div className="grid grid-cols-[140px_1fr] items-center gap-x-6 gap-y-3 border-t pt-5">
                          <label className="text-sm">새로 받기</label>
                          <div className="flex items-center gap-2">
                            <Input
                              type="text"
                              value={pullModelName}
                              onChange={(e) => setPullModelName(e.target.value)}
                              placeholder="llama3 / gemma2 / mistral …"
                              disabled={isPulling}
                              className="flex-1"
                            />
                            <Button type="button" onClick={() => startPullModel()} disabled={isPulling || !pullModelName.trim()} size="sm">
                              {isPulling ? '받는 중' : '다운로드'}
                            </Button>
                          </div>
                          <span />
                          <a href="https://ollama.com/library" target="_blank" rel="noopener noreferrer" className="text-xs text-muted-foreground underline-offset-2 hover:underline">ollama.com/library</a>
                        </div>

                        {/* 추천 vision */}
                        <div className="space-y-2">
                          <div className="text-xs uppercase tracking-wide text-muted-foreground">추천 Vision 모델</div>
                          <div className="flex flex-wrap gap-1.5">
                            {RECOMMENDED_VISION_MODELS.map((model) => {
                              const isInstalled = ollamaModels.some((m) => m.name === model.name)
                              return (
                                <button
                                  key={model.name}
                                  type="button"
                                  disabled={isPulling || isInstalled}
                                  onClick={() => startPullModel(model.name)}
                                  title={model.description}
                                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition-colors disabled:opacity-50 ${isInstalled ? 'border-emerald-500/40 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400' : 'hover:bg-muted'}`}
                                >
                                  {isInstalled ? <>✓ {model.name}</> : <>↓ {model.name} <span className="opacity-60">({model.size})</span></>}
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* download progress */}
                        {isPulling && pullProgress ? (
                          <div className="space-y-2">
                            <div className="flex items-center justify-between text-xs text-muted-foreground">
                              <span>{pullProgress.status || '다운로드 중'}</span>
                              {pullProgress.total > 0 && (
                                <span>{formatBytes(pullProgress.completed)} / {formatBytes(pullProgress.total)}</span>
                              )}
                            </div>
                            <Progress value={pullProgress.total > 0 ? Math.round((pullProgress.completed / pullProgress.total) * 100) : 0} />
                          </div>
                        ) : null}

                        {/* installed models — compact table */}
                        {ollamaModels.length > 0 && (
                          <section className="border-t pt-5">
                            <div className="mb-2 flex items-baseline justify-between text-xs">
                              <span className="uppercase tracking-wide text-muted-foreground">설치됨 ({ollamaModels.length})</span>
                              <span className="text-muted-foreground">{formatBytes(ollamaTotalSize)}</span>
                            </div>
                            <ul className="divide-y border-y">
                              {ollamaModels.map((model) => {
                                const isVision = model.vision
                                const isDeleting = deletingModelName === model.name
                                const isSelected = ollamaModel === model.name
                                return (
                                  <li key={model.name} className="group flex items-center gap-3 py-2.5 text-sm">
                                    <span className="flex-1 truncate font-medium">{model.name}</span>
                                    {isVision && <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">Vision</span>}
                                    {isSelected && <span className="inline-flex items-center gap-1 text-[10px] text-emerald-600"><span className="h-1 w-1 rounded-full bg-emerald-500" />사용 중</span>}
                                    <span className="font-mono text-[11px] text-muted-foreground">{formatBytes(model.size)}</span>
                                    <button
                                      type="button"
                                      onClick={() => openDeleteDialog(model)}
                                      disabled={isDeleting || isPulling}
                                      className="rounded p-1 text-muted-foreground opacity-0 transition-opacity hover:text-destructive group-hover:opacity-100 disabled:opacity-30"
                                      aria-label={`${model.name} 삭제`}
                                    >
                                      {isDeleting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                                    </button>
                                  </li>
                                )
                              })}
                            </ul>
                          </section>
                        )}
                      </>
                    )}
                  </div>
                )}

                {/* Common tuning — collapsed by default for ollama+offline, otherwise inline */}
                <section className="space-y-5 border-t pt-6">
                  <div className="grid grid-cols-[140px_1fr] items-center gap-x-6 gap-y-5">
                    <label className="text-sm">Temperature</label>
                    <div className="flex items-center gap-3">
                      <Slider value={[temperature]} min={0} max={2} step={0.1} onValueChange={(v) => setTemperature(v?.[0] ?? 0.7)} className="flex-1" />
                      <span className="w-10 text-right font-mono text-xs text-muted-foreground">{temperature}</span>
                    </div>

                    <label className="text-sm">Max Tokens</label>
                    <Input
                      type="number"
                      value={maxTokens}
                      onChange={e => setMaxTokens(parseInt(e.target.value) || 4000)}
                      min={100}
                      max={128000}
                      className="w-32"
                    />
                  </div>
                </section>

                <div className="flex justify-end pt-2">
                  <Button type="button" onClick={saveAiModelSettings} size="sm">저장</Button>
                </div>
              </div>
              )
            })()}

            {activeMenu === 'embedding-model' && (
              <div className="space-y-8">
                <div>
                  <h2 className="text-base font-semibold">임베딩 모델</h2>
                  <p className="mt-1 text-xs text-muted-foreground">RAG/KB 검색에 쓰이는 벡터 생성 모델.</p>
                </div>

                {/* 현재 사용 중 — 강조 row */}
                <div className="flex items-center justify-between rounded-md bg-muted/40 px-4 py-3">
                  <div className="min-w-0">
                    <div className="text-[11px] uppercase tracking-wide text-muted-foreground">사용 중</div>
                    <div className="mt-0.5 flex items-center gap-2 text-sm font-medium">
                      <span>{getEmbeddingModelLabel(embeddingModel)}</span>
                      <span className="rounded bg-background px-1.5 py-0.5 text-[10px] font-normal text-muted-foreground">{getEmbeddingModelProvider(embeddingModel)}</span>
                    </div>
                  </div>
                  <NativeSelect
                    value={embeddingModel}
                    onChange={(e) => setEmbeddingModel(e.target.value)}
                    className="w-[260px]"
                  >
                    <NativeSelectOptGroup label="로컬">
                      <NativeSelectOption value={DEFAULT_EMBEDDING_MODEL}>{getEmbeddingModelLabel(DEFAULT_EMBEDDING_MODEL)}</NativeSelectOption>
                    </NativeSelectOptGroup>
                    {availableEmbeddingModels.some((modelId) => isOpenaiEmbeddingModel(modelId)) && (
                      <NativeSelectOptGroup label="OpenAI">
                        {availableEmbeddingModels.filter((modelId) => isOpenaiEmbeddingModel(modelId)).map((modelId) => (
                          <NativeSelectOption key={modelId} value={modelId}>{getEmbeddingModelLabel(modelId)}</NativeSelectOption>
                        ))}
                      </NativeSelectOptGroup>
                    )}
                  </NativeSelect>
                </div>

                {/* 대안 모델 — 테이블 형식 */}
                <section className="space-y-3">
                  <div className="flex items-baseline justify-between">
                    <h3 className="text-sm font-medium">사용 가능한 모델</h3>
                    <span className="text-[11px] text-muted-foreground">OpenAI 모델은 API Key 검증 후 노출됨</span>
                  </div>
                  <table className="w-full text-sm">
                    <thead className="text-[11px] uppercase tracking-wide text-muted-foreground">
                      <tr className="border-b">
                        <th className="py-2 text-left font-normal">모델</th>
                        <th className="py-2 text-left font-normal">출처</th>
                        <th className="py-2 text-left font-normal">설명</th>
                        <th className="py-2"></th>
                      </tr>
                    </thead>
                    <tbody>
                      {availableEmbeddingModels.map((modelId) => {
                        const isSelected = embeddingModel === modelId
                        return (
                          <tr key={modelId} className={`border-b last:border-0 ${isSelected ? 'bg-primary/5' : ''}`}>
                            <td className="py-2.5">
                              <span className="font-medium">{getEmbeddingModelLabel(modelId)}</span>
                              {modelId === DEFAULT_EMBEDDING_MODEL && <span className="ml-1.5 text-[10px] text-muted-foreground">기본</span>}
                              {modelId === 'text-embedding-3-small' && <span className="ml-1.5 text-[10px] text-emerald-600">추천</span>}
                            </td>
                            <td className="py-2.5 text-xs text-muted-foreground">{getEmbeddingModelProvider(modelId)}</td>
                            <td className="py-2.5 text-xs text-muted-foreground">{EMBEDDING_MODEL_DESCRIPTIONS[modelId] || ''}</td>
                            <td className="py-2.5 text-right">
                              {isSelected ? (
                                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-600">
                                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" /> 사용 중
                                </span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setEmbeddingModel(modelId)}
                                  className="text-[11px] text-muted-foreground hover:text-foreground"
                                >
                                  선택
                                </button>
                              )}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </section>

                <div className="flex justify-end">
                  <Button type="button" onClick={saveEmbeddingModelSettings} size="sm">저장</Button>
                </div>
              </div>
            )}

            {activeMenu === 'ai-persona' && (() => {
              const renderPersonaForm = (sections, setSections, custom, setCustom, saving, onSave, onReset) => (
                <div className="space-y-5">
                  {PERSONA_SECTIONS.map((section) => {
                    const exampleText = section.placeholder?.replace(/^예:\s*/, '') || ''
                    return (
                      <div key={section.key} className="space-y-1.5">
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-medium">{section.label}</label>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <Info className="h-3 w-3 cursor-help text-muted-foreground" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs">{section.description}</TooltipContent>
                          </Tooltip>
                          <span className="flex-1" />
                          {exampleText && (
                            <button
                              type="button"
                              className="text-[11px] text-muted-foreground hover:text-foreground"
                              onClick={() => setSections(prev => ({ ...prev, [section.key]: exampleText }))}
                            >예시 채우기</button>
                          )}
                        </div>
                        <textarea
                          value={sections[section.key] || ''}
                          onChange={(e) => setSections(prev => ({ ...prev, [section.key]: e.target.value }))}
                          maxLength={2000}
                          placeholder={section.placeholder}
                          className="w-full resize-y rounded border bg-background px-3 py-2 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-ring min-h-[56px]"
                        />
                      </div>
                    )
                  })}
                  <div className="space-y-1.5 border-t pt-5">
                    <label className="text-xs font-medium">추가 지시사항</label>
                    <textarea
                      value={custom}
                      onChange={(e) => setCustom(e.target.value)}
                      maxLength={2000}
                      placeholder="자유 형식으로 보충"
                      className="w-full resize-y rounded border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring min-h-[56px]"
                    />
                  </div>
                  <div className="flex justify-end gap-2 pt-2">
                    <Button variant="ghost" size="sm" onClick={onReset} disabled={saving}>초기화</Button>
                    <Button size="sm" onClick={onSave} disabled={saving}>
                      {saving ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : null}저장
                    </Button>
                  </div>
                </div>
              )

              const adminCount = Object.values(adminPersonaSections || {}).filter(Boolean).length + (adminPersonaCustomText ? 1 : 0)
              const userCount = Object.values(userPersonaSections || {}).filter(Boolean).length + (userPersonaCustomText ? 1 : 0)

              return (
              <div className="space-y-7">
                <h2 className="text-base font-semibold">에이전트 페르소나</h2>

                {/* Layer indicator — 시각적으로 레이어링 표현 */}
                <nav className="flex items-center gap-1 text-sm">
                  {[
                    isAdmin && { id: 'default', label: '기본', count: adminCount },
                    { id: 'mine', label: '내 페르소나', count: userCount },
                    { id: 'preview', label: '미리보기' },
                  ].filter(Boolean).map((tab, idx, arr) => (
                    <React.Fragment key={tab.id}>
                      <button
                        type="button"
                        onClick={() => setPersonaView(tab.id)}
                        className={`group inline-flex items-center gap-2 rounded px-2.5 py-1 transition-colors ${personaView === tab.id ? 'bg-foreground text-background' : 'text-muted-foreground hover:text-foreground'}`}
                      >
                        {tab.label}
                        {typeof tab.count === 'number' && tab.count > 0 && (
                          <span className={`rounded-full px-1.5 text-[10px] ${personaView === tab.id ? 'bg-background/20' : 'bg-muted'}`}>{tab.count}</span>
                        )}
                      </button>
                      {idx < arr.length - 1 && <span className="text-muted-foreground/40">›</span>}
                    </React.Fragment>
                  ))}
                </nav>

                {personaView === 'default' && (
                  isAdmin
                    ? renderPersonaForm(adminPersonaSections, setAdminPersonaSections, adminPersonaCustomText, setAdminPersonaCustomText, adminPersonaSaving, saveAdminPersona, resetAdminPersona)
                    : <div className="text-sm text-muted-foreground">관리자만 편집할 수 있습니다.</div>
                )}

                {personaView === 'mine' && (
                  renderPersonaForm(userPersonaSections, setUserPersonaSections, userPersonaCustomText, setUserPersonaCustomText, userPersonaSaving, saveUserPersona, resetUserPersona)
                )}

                {personaView === 'preview' && (
                  <div className="space-y-4">
                    <p className="text-xs text-muted-foreground">시스템 프롬프트 → 기본 페르소나 → 내 페르소나 순으로 합쳐져 전달됩니다.</p>
                    {isAdmin && (
                      <div className="space-y-1.5">
                        <div className="text-[11px] uppercase tracking-wide text-muted-foreground">① 기본</div>
                        <pre className="max-h-[160px] overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs">
{compilePersonaToMarkdown('admin', adminPersonaSections, adminPersonaCustomText) || '(설정되지 않음)'}
                        </pre>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{isAdmin ? '② 내 페르소나' : '① 내 페르소나'}</div>
                      <pre className="max-h-[160px] overflow-y-auto whitespace-pre-wrap rounded border bg-muted/30 p-3 text-xs">
{compilePersonaToMarkdown('user', userPersonaSections, userPersonaCustomText) || '(설정되지 않음)'}
                      </pre>
                    </div>
                  </div>
                )}
              </div>
              )
            })()}

            {activeMenu === 'upload-policy' && (
              <div className="space-y-6">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-base font-semibold">업로드 정책</h2>
                  <span className="text-[11px] uppercase tracking-wide text-muted-foreground">읽기 전용</span>
                </div>

                {uploadPolicy ? (
                  <>
                    <dl className="grid grid-cols-[180px_1fr] gap-x-8 gap-y-4 text-sm">
                      <dt className="text-muted-foreground">최대 파일 크기</dt>
                      <dd className="font-mono">{uploadPolicy.max_file_size_mb} MB</dd>

                      <dt className="text-muted-foreground">동시 처리 대기</dt>
                      <dd className="font-mono">{uploadPolicy.max_queued_files} 건</dd>

                      <dt className="text-muted-foreground pt-1">허용 확장자</dt>
                      <dd className="flex flex-wrap gap-1">
                        {uploadPolicy.allowed_extensions.map(ext => (
                          <code key={ext} className="rounded bg-muted px-1.5 py-0.5 text-xs">{ext}</code>
                        ))}
                      </dd>
                    </dl>

                    <p className="border-t pt-4 text-xs text-muted-foreground">
                      정책은 서버 환경변수로만 조정됩니다. 변경이 필요하면 관리자에게 요청하세요.
                    </p>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">불러오는 중…</div>
                )}
              </div>
            )}

            {activeMenu === 'admin-users' && (
              <AdminUsersPanel isAdmin={isAdmin} />
            )}

            {activeMenu === 'admin-queue' && (
              isAdmin ? <AdminQueuePanel isAdmin={isAdmin} /> : <UserQueuePanel />
            )}

            {activeMenu === 'knowledge-db' && (
              <div className="space-y-6">
                <div className="flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    {selectedKb ? (
                      <button className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground" onClick={() => { setSelectedKb(null); setKbFiles([]) }}>
                        <ChevronLeft className="h-4 w-4" /> 지식베이스
                      </button>
                    ) : (
                      <h2 className="text-base font-semibold">지식베이스</h2>
                    )}
                    {selectedKb && (
                      <div className="mt-1 truncate text-lg font-semibold">{selectedKb.name}</div>
                    )}
                  </div>
                  {/* DOREA-XP: 지식DB 추가/삭제 비활성화 (backend 403). 일반문서 1개만 사용. */}
                </div>

                {/* KB 카드 그리드 — 카드뉴스 스타일 */}
                {!selectedKb && (
                  knowledgeDbs.length === 0 ? (
                    <div className="py-16 text-center">
                      <div className="text-sm">아직 지식베이스가 없습니다.</div>
                      <div className="mt-1 text-xs text-muted-foreground">먼저 만들고, 분석 완료된 문서를 추가하면 RAG 범위로 지정할 수 있습니다.</div>
                    </div>
                  ) : (
                    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                      {knowledgeDbs.map(kb => (
                        <article
                          key={kb.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => openKbDetail(kb)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') {
                              e.preventDefault()
                              openKbDetail(kb)
                            }
                          }}
                          className="group relative flex h-[140px] cursor-pointer flex-col justify-between rounded-md border bg-background p-4 transition-all hover:border-foreground/30 hover:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        >
                          {/* 좌상단 컬러 인디케이터 + 액션 */}
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground/30 group-hover:bg-foreground/60" />
                                <h3 className="truncate text-sm font-semibold leading-tight">{kb.name}</h3>
                              </div>
                              {kb.description ? (
                                <p className="mt-2 line-clamp-2 text-xs leading-relaxed text-muted-foreground">{kb.description}</p>
                              ) : (
                                <p className="mt-2 text-xs italic text-muted-foreground/40">설명 없음</p>
                              )}
                            </div>
                            {/* DOREA-XP: 지식DB 수정/삭제 비활성화 (backend 403) */}
                          </div>

                          {/* 하단 메트릭 */}
                          <div className="flex items-end justify-between border-t border-dashed pt-2 text-xs text-muted-foreground">
                            <span className="inline-flex items-baseline gap-1">
                              <span className="font-mono text-sm font-semibold text-foreground">{kb.file_count}</span>
                              <span>파일</span>
                            </span>
                            <span className="inline-flex items-baseline gap-1">
                              <span className="font-mono text-sm font-semibold text-foreground">{kb.total_chunks}</span>
                              <span>청크</span>
                            </span>
                          </div>
                        </article>
                      ))}
                    </div>
                  )
                )}

                {/* KB 상세 — 파일 목록 */}
                {selectedKb && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-2">
                      <Badge variant="secondary">{selectedKb.file_count || kbFiles.length}개 파일</Badge>
                      <Badge variant="outline">{selectedKb.total_chunks || 0} 청크</Badge>
                      <div className="flex-1" />
                      <Button variant="outline" size="sm" onClick={openAddFilesDialog}>
                        <FileUp className="h-4 w-4 mr-1" /> 파일 이동
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasEmbeddableKbFiles || kbBulkActionLoading !== null}
                        onClick={() => embedAllFilesInKb('missing')}
                      >
                        {kbBulkActionLoading === 'missing'
                          ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          : <Zap className="h-4 w-4 mr-1" />}
                        {kbBulkActionLoading === 'missing' ? '임베딩 중...' : '임베딩'}
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={!hasCompletedKbFiles || kbBulkActionLoading !== null}
                        onClick={() => embedAllFilesInKb('all')}
                      >
                        {kbBulkActionLoading === 'all'
                          ? <Loader2 className="h-4 w-4 mr-1 animate-spin" />
                          : <RefreshCw className="h-4 w-4 mr-1" />}
                        {kbBulkActionLoading === 'all' ? '재임베딩 중...' : '재임베딩'}
                      </Button>
                    </div>

                    {kbFiles.length === 0 ? (
                      <div className="py-10 text-center">
                        <div className="text-sm">등록된 파일이 없습니다.</div>
                        <div className="mt-1 text-xs text-muted-foreground">"파일 이동"으로 다른 지식DB의 문서를 옮겨오세요.</div>
                      </div>
                    ) : (
                      <ScrollArea className="max-h-[400px]">
                        <div className="space-y-1.5">
                        {kbFiles.map(f => {
                          const isCompleted = f.embedding_status === 'completed'
                          return (
                          <div key={f.file_id} className="flex items-center justify-between p-2.5 rounded-md border bg-background text-sm gap-2">
                            <div className="flex items-center gap-2 min-w-0 flex-1">
                              <img src={getFileIconUrl(f.original_filename)} alt="" className="h-5 w-5 shrink-0" draggable={false} />
                              {isCompleted ? (
                                <button
                                  className="truncate hover:underline text-foreground cursor-pointer text-left"
                                  onClick={() => { setFileDetailTarget(f); setFileDetailOpen(true) }}
                                  title="파일 상세 정보 보기"
                                >
                                  {f.original_filename}
                                </button>
                              ) : (
                                <span className="truncate">{f.original_filename}</span>
                              )}
                              <Badge
                                variant={isCompleted ? 'secondary' : f.embedding_status === 'failed' ? 'destructive' : 'outline'}
                                className="text-[10px] px-1.5 py-0 shrink-0"
                                title={
                                  f.embedding_status === 'processing' && f.embedding_total_chunks > 0
                                    ? `총 ${f.embedding_total_chunks}청크 중 ${f.embedding_processed_chunks || 0}개 임베딩 완료`
                                    : f.embedding_error || ''
                                }
                              >
                                {isCompleted ? '임베딩 완료' :
                                 f.embedding_status === 'processing'
                                   ? (f.embedding_total_chunks > 0
                                       ? `임베딩 중... (${f.embedding_processed_chunks || 0}/${f.embedding_total_chunks})`
                                       : '임베딩 준비중...')
                                   : f.embedding_status === 'pending' ? '대기중' :
                                   f.embedding_status === 'failed' ? '실패' : '미임베딩'}
                              </Badge>
                              {f.embedding_chunks > 0 && (
                                <span className="text-xs text-muted-foreground shrink-0">{f.embedding_chunks}청크</span>
                              )}
                              {f.embedding_status === 'failed' && f.embedding_error && (
                                <span className="text-[10px] text-destructive truncate max-w-[200px]" title={f.embedding_error}>{f.embedding_error}</span>
                              )}
                            </div>
                            <div className="flex items-center gap-1 shrink-0">
                              {f.embedding_status === 'processing' ? (
                                <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                              ) : f.status !== 'completed' ? (
                                <span className="cursor-not-allowed" title="문서 분석 완료 후 임베딩 가능">
                                  <Button
                                    variant="ghost" size="sm"
                                    className="h-7 px-2 text-xs text-muted-foreground pointer-events-none opacity-40"
                                    tabIndex={-1}
                                  >
                                    <Zap className="h-3.5 w-3.5 mr-1" />
                                    임베딩
                                  </Button>
                                </span>
                              ) : (
                                <Button
                                  variant="ghost" size="sm"
                                  className="h-7 px-2 text-xs text-muted-foreground hover:text-primary"
                                  onClick={() => embedFileInKb(f.file_id)}
                                  title={f.embedding_status === 'completed' ? '재임베딩' : '임베딩'}
                                >
                                  <Zap className="h-3.5 w-3.5 mr-1" />
                                  {f.embedding_status === 'completed' ? '재임베딩' : '임베딩'}
                                </Button>
                              )}
                              <Button
                                variant="ghost" size="sm"
                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                onClick={() => removeFileFromKb(f.file_id)}
                                title="삭제"
                              >
                                <Trash2 className="h-3.5 w-3.5 mr-1" />삭제
                              </Button>
                            </div>
                          </div>
                          )
                        })}
                        </div>
                      </ScrollArea>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* KB 생성 다이얼로그 */}
            {kbCreateOpen && (
              <Dialog open={kbCreateOpen} onOpenChange={setKbCreateOpen}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>새 지식DB 만들기</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>이름 *</Label>
                      <Input value={kbName} onChange={e => setKbName(e.target.value)} placeholder="예: 법률 문서, 프로젝트 자료" maxLength={100} />
                    </div>
                    <div className="space-y-2">
                      <Label>설명</Label>
                      <Input value={kbDescription} onChange={e => setKbDescription(e.target.value)} placeholder="선택사항" maxLength={500} />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setKbCreateOpen(false)}>취소</Button>
                      <Button onClick={createKnowledgeDb} disabled={kbLoading || !kbName.trim()}>
                        {kbLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                        생성
                      </Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}

            {/* KB 수정 다이얼로그 */}
            {kbEditOpen && (
              <Dialog open={kbEditOpen} onOpenChange={(open) => {
                setKbEditOpen(open)
                if (!open) setKbActionTarget(null)
              }}>
                <DialogContent className="sm:max-w-md">
                  <DialogHeader>
                    <DialogTitle>지식DB 수정</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label>이름 *</Label>
                      <Input value={kbName} onChange={e => setKbName(e.target.value)} onKeyDown={handleKbEditInputKeyDown} maxLength={100} />
                    </div>
                    <div className="space-y-2">
                      <Label>설명</Label>
                      <Input value={kbDescription} onChange={e => setKbDescription(e.target.value)} onKeyDown={handleKbEditInputKeyDown} maxLength={500} />
                    </div>
                    <div className="flex justify-end gap-2">
                      <Button variant="outline" onClick={() => setKbEditOpen(false)}>취소</Button>
                      <Button onClick={updateKnowledgeDb} disabled={kbLoading || !kbName.trim()}>저장</Button>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}

            {/* KB 삭제 확인 */}
            {kbDeleteOpen && (
              <AlertDialog open={kbDeleteOpen} onOpenChange={(open) => {
                setKbDeleteOpen(open)
                if (!open) setKbActionTarget(null)
              }}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>지식DB 삭제</AlertDialogTitle>
                    <AlertDialogDescription>
                      '{kbActionTarget?.name || selectedKb?.name}' 지식DB를 삭제합니다. 벡터 데이터가 모두 삭제되고 파일 연결이 해제됩니다. 이 작업은 되돌릴 수 없습니다.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>취소</AlertDialogCancel>
                    <AlertDialogAction onClick={deleteKnowledgeDb} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                      삭제
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}

            {/* 파일 이동 다이얼로그 */}
            {kbAddFilesOpen && (
              <Dialog open={kbAddFilesOpen} onOpenChange={setKbAddFilesOpen}>
                <DialogContent className="sm:max-w-lg">
                  <DialogHeader>
                    <DialogTitle>파일 이동 — {selectedKb?.name}</DialogTitle>
                  </DialogHeader>
                  <div className="space-y-4">
                    {availableFiles.length === 0 ? (
                      <div className="text-center py-6 text-muted-foreground text-sm">
                        이동 가능한 파일이 없습니다.
                        <div className="text-xs mt-1">분석 완료된 파일 중 다른 지식DB에 속한 파일이 여기에 표시됩니다.</div>
                      </div>
                    ) : (() => {
                      const filtered = moveFileSearch
                        ? availableFiles.filter(f => f.original_filename.toLowerCase().includes(moveFileSearch.toLowerCase()))
                        : availableFiles
                      return (
                        <>
                          <div className="text-xs text-muted-foreground bg-muted/50 rounded-md px-3 py-2">
                            선택한 파일은 기존 지식DB에서 제거되고 이 DB로 이동됩니다. 임베딩은 초기화됩니다.
                          </div>
                          {availableFiles.length > 10 && (
                            <Input
                              placeholder="파일명 검색..."
                              value={moveFileSearch}
                              onChange={e => setMoveFileSearch(e.target.value)}
                              className="h-8 text-sm"
                            />
                          )}
                          <ScrollArea className="max-h-[300px]">
                            <div className="space-y-1">
                              {filtered.map(f => (
                                <div
                                  key={f.file_id}
                                  className={`flex items-center gap-2 p-2 rounded-md cursor-pointer transition-colors ${
                                    selectedFileIds.includes(f.file_id) ? 'bg-accent' : 'hover:bg-muted/50'
                                  }`}
                                  onClick={() => toggleFileSelection(f.file_id)}
                                >
                                  <Checkbox
                                    checked={selectedFileIds.includes(f.file_id)}
                                    onCheckedChange={() => toggleFileSelection(f.file_id)}
                                  />
                                  <img src={getFileIconUrl(f.original_filename)} alt="" className="h-4 w-4 shrink-0" />
                                  <div className="flex flex-col min-w-0 flex-1">
                                    <span className="text-sm truncate">{f.original_filename}</span>
                                    {f.current_kb_name && (
                                      <span className="text-[10px] text-muted-foreground">현재: {f.current_kb_name}</span>
                                    )}
                                  </div>
                                  <span className="text-xs text-muted-foreground shrink-0">{formatBytes(f.file_size)}</span>
                                </div>
                              ))}
                              {filtered.length === 0 && (
                                <div className="text-center py-4 text-sm text-muted-foreground">검색 결과가 없습니다.</div>
                              )}
                            </div>
                          </ScrollArea>
                        </>
                      )
                    })()}
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground">
                        {selectedFileIds.length}개 선택됨 (최대 {MAX_MOVE_FILES}개)
                      </span>
                      <div className="flex gap-2">
                        <Button variant="outline" onClick={() => setKbAddFilesOpen(false)}>취소</Button>
                        <Button onClick={addFilesToKb} disabled={kbLoading || selectedFileIds.length === 0}>
                          {kbLoading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : null}
                          이동
                        </Button>
                      </div>
                    </div>
                  </div>
                </DialogContent>
              </Dialog>
            )}

            {/* 파일 상세 정보 모달 */}
            <FileDetailModal
              open={fileDetailOpen}
              onOpenChange={setFileDetailOpen}
              file={fileDetailTarget}
              kbId={selectedKb?.id}
              formatBytes={formatBytes}
            />

            {activeMenu === 'rag' && (
              <div className="space-y-8">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-base font-semibold">RAG</h2>
                  <span className="text-xs text-muted-foreground">Top-K {ragTopK} · 유사도 ≥ {ragMinSimilarity}</span>
                </div>

                {/* 검색은 자주 보는 값 → 항상 펼침 */}
                <section className="space-y-5">
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <label>검색 결과 수</label>
                      <span className="font-mono text-xs text-muted-foreground">Top-K = {ragTopK}</span>
                    </div>
                    <Slider value={[ragTopK]} min={1} max={20} step={1} onValueChange={(v) => setRagTopK(v?.[0] ?? 3)} />
                  </div>

                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-sm">
                      <label>최소 유사도</label>
                      <span className="font-mono text-xs text-muted-foreground">≥ {ragMinSimilarity}</span>
                    </div>
                    <Slider value={[ragMinSimilarity]} min={0} max={1} step={0.05} onValueChange={(v) => setRagMinSimilarity(v?.[0] ?? 0.5)} />
                  </div>
                </section>

                {/* 청킹은 보통 안 만짐 → details로 접어둠 */}
                <details className="group border-t pt-4 [&_summary::-webkit-details-marker]:hidden">
                  <summary className="flex cursor-pointer select-none items-center justify-between text-sm font-medium">
                    <span>청킹 (Advanced)</span>
                    <span className="text-xs text-muted-foreground transition-transform group-open:rotate-90">›</span>
                  </summary>
                  <div className="mt-5 grid grid-cols-[200px_1fr] gap-x-8 gap-y-5">
                    <div>
                      <div className="text-sm">청크 크기</div>
                      <div className="text-xs text-muted-foreground">100 – 10000 문자</div>
                    </div>
                    <Input
                      type="number"
                      value={ragChunkSize}
                      onChange={e => setRagChunkSize(Math.max(100, Math.min(10000, parseInt(e.target.value) || 1200)))}
                      min={100}
                      max={10000}
                      className="w-32"
                    />

                    <div>
                      <div className="text-sm">청크 겹침</div>
                      <div className="text-xs text-muted-foreground">0 – 2000 문자</div>
                    </div>
                    <Input
                      type="number"
                      value={ragChunkOverlap}
                      onChange={e => setRagChunkOverlap(Math.max(0, Math.min(2000, parseInt(e.target.value) || 180)))}
                      min={0}
                      max={2000}
                      className="w-32"
                    />
                  </div>
                  <p className="mt-4 text-xs text-muted-foreground">변경값은 새로 인덱싱되는 문서에만 적용. 기존 문서는 재분석 필요.</p>
                </details>

                <div className="flex justify-end pt-2">
                  <Button onClick={saveRagSettings} size="sm">저장</Button>
                </div>
              </div>
            )}

             {activeMenu === 'mcp' && (
              <KistiMcpReadOnlyPanel isAdmin={isAdmin} />
            )}

            {activeMenu === 'quick-actions' && (
              <div className="space-y-5">
                <div className="flex items-baseline justify-between">
                  <h2 className="text-base font-semibold">빠른 메뉴</h2>
                  <span className="text-xs text-muted-foreground">{qaActions.filter(a => a.visible).length}개 노출 · 최대 3개 · 전체 {qaActions.length}</span>
                </div>

                <div className="flex items-center justify-between border-b pb-3">
                  <span className="text-xs text-muted-foreground">세그먼트 선택 시 채팅 위에 표시됩니다. 드래그로 순서 변경.</span>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 text-xs"
                      onClick={async () => {
                        if (!window.confirm('빠른메뉴를 기본값(요약/분석/번역)으로 초기화할까요?')) return
                        setQaSaving(true)
                        try {
                          const result = await quickActionsAPI.reset()
                          setQaActions(result.actions || [])
                          setQaEditingIdx(null)
                          toast.success('빠른메뉴가 초기화되었습니다.')
                        } catch (e) {
                          toast.error('초기화에 실패했습니다.')
                        } finally {
                          setQaSaving(false)
                        }
                      }}
                    >
                      초기화
                    </Button>
                    {qaActions.length < 3 && qaEditingIdx === null && (
                      <Button
                        size="sm"
                        className="h-7 text-xs"
                        onClick={() => {
                          setQaEditingIdx('new')
                          setQaForm({ id: '', label: '', caption: '', prompt: '' })
                        }}
                      >
                        <Plus className="mr-1 h-3 w-3" />새로 만들기
                      </Button>
                    )}
                  </div>
                </div>

                <div className="space-y-3">
                    {qaActions.length === 0 && qaEditingIdx === null && (
                      <div className="py-6 text-center text-sm text-muted-foreground">
                        등록된 메뉴가 없습니다. "초기화"로 기본 3종(요약 / 분석 / 번역)을 불러올 수 있습니다.
                      </div>
                    )}

                    <DndContext
                      sensors={qaSensors}
                      collisionDetection={closestCenter}
                      onDragEnd={async (event) => {
                        const { active, over } = event
                        if (!over || active.id === over.id) return
                        const oldIndex = qaActions.findIndex((a) => a.id === active.id)
                        const newIndex = qaActions.findIndex((a) => a.id === over.id)
                        if (oldIndex < 0 || newIndex < 0) return

                        const reordered = arrayMove(qaActions, oldIndex, newIndex)
                        setQaActions(reordered)
                        setQaSaving(true)
                        try {
                          const result = await quickActionsAPI.update(reordered)
                          setQaActions(result.actions || reordered)
                        } catch (e) {
                          toast.error('순서 저장에 실패했습니다.')
                        } finally {
                          setQaSaving(false)
                        }
                      }}
                    >
                      <SortableContext items={qaActions.map((a) => a.id)} strategy={verticalListSortingStrategy}>
                        <div className="space-y-2 max-h-[360px] overflow-y-auto pr-1">
                    {qaActions.map((action, idx) => (
                      qaEditingIdx === idx ? (
                        <div key={action.id} className="rounded-md border p-3 space-y-2 bg-muted/30">
                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <Label className="text-xs">버튼 텍스트 (최대 10자)</Label>
                              <Input
                                value={qaForm.label}
                                onChange={(e) => setQaForm(prev => ({ ...prev, label: e.target.value }))}
                                maxLength={10}
                                placeholder="예: 확장"
                                className="h-8 text-sm"
                              />
                            </div>
                            <div>
                              <Label className="text-xs">설명 (툴팁)</Label>
                              <Input
                                value={qaForm.caption}
                                onChange={(e) => setQaForm(prev => ({ ...prev, caption: e.target.value }))}
                                maxLength={100}
                                placeholder="예: 관련 자료 추가 검색"
                                className="h-8 text-sm"
                              />
                            </div>
                          </div>
                          <div>
                            <Label className="text-xs">AI 프롬프트</Label>
                            <textarea
                              value={qaForm.prompt}
                              onChange={(e) => setQaForm(prev => ({ ...prev, prompt: e.target.value }))}
                              maxLength={500}
                              placeholder="예: 해당 부분에 대해 더 많은 자료를 찾아봐줘"
                              className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[60px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                            />
                          </div>
                          <div className="flex justify-end gap-2">
                            <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setQaEditingIdx(null)}>
                              취소
                            </Button>
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={!qaForm.label.trim() || !qaForm.prompt.trim() || qaSaving}
                              onClick={async () => {
                                setQaSaving(true)
                                try {
                                  const updated = [...qaActions]
                                  updated[idx] = {
                                    id: action.id,
                                    label: qaForm.label.trim(),
                                    caption: qaForm.caption.trim(),
                                    prompt: qaForm.prompt.trim(),
                                    visible: action.visible,
                                  }
                                  const result = await quickActionsAPI.update(updated)
                                  setQaActions(result.actions || updated)
                                  setQaEditingIdx(null)
                                  toast.success('메뉴가 수정되었습니다.')
                                } catch (e) {
                                  toast.error(e?.response?.data?.detail?.message || '저장에 실패했습니다.')
                                } finally {
                                  setQaSaving(false)
                                }
                              }}
                            >
                              {qaSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : '저장'}
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <SortableQuickActionRow
                          key={action.id}
                          action={action}
                          onEdit={() => {
                            setQaEditingIdx(idx)
                            setQaForm({ id: action.id, label: action.label, caption: action.caption || '', prompt: action.prompt })
                          }}
                          onDelete={async () => {
                            setQaSaving(true)
                            try {
                              const updated = qaActions.filter((_, i) => i !== idx)
                              const result = await quickActionsAPI.update(updated)
                              setQaActions(result.actions || updated)
                              toast.success('메뉴가 삭제되었습니다.')
                            } catch (e) {
                              toast.error('삭제에 실패했습니다.')
                            } finally {
                              setQaSaving(false)
                            }
                          }}
                          onToggleVisible={async () => {
                            const turningOn = !action.visible
                            const visibleCount = qaActions.filter((a) => a.visible).length
                            if (turningOn && visibleCount >= 3) {
                              toast.warning('보이기 메뉴는 최대 3개까지 설정할 수 있습니다.')
                              return
                            }

                            setQaSaving(true)
                            try {
                              const updated = [...qaActions]
                              updated[idx] = { ...updated[idx], visible: turningOn }
                              const result = await quickActionsAPI.update(updated)
                              setQaActions(result.actions || updated)
                            } catch (e) {
                              toast.error(e?.response?.data?.detail?.message || '보이기 설정 저장에 실패했습니다.')
                            } finally {
                              setQaSaving(false)
                            }
                          }}
                        />
                      )
                    ))}
                        </div>
                      </SortableContext>
                    </DndContext>

                    {/* 새 항목 추가 폼 */}
                    {qaEditingIdx === 'new' && (
                      <div className="rounded-md border p-3 space-y-2 bg-muted/30">
                        <div className="grid grid-cols-2 gap-2">
                          <div>
                            <Label className="text-xs">버튼 텍스트 (최대 10자)</Label>
                            <Input
                              value={qaForm.label}
                              onChange={(e) => setQaForm(prev => ({ ...prev, label: e.target.value }))}
                              maxLength={10}
                              placeholder="예: 확장"
                              className="h-8 text-sm"
                            />
                          </div>
                          <div>
                            <Label className="text-xs">설명 (툴팁)</Label>
                            <Input
                              value={qaForm.caption}
                              onChange={(e) => setQaForm(prev => ({ ...prev, caption: e.target.value }))}
                              maxLength={100}
                              placeholder="예: 관련 자료 추가 검색"
                              className="h-8 text-sm"
                            />
                          </div>
                        </div>
                        <div>
                          <Label className="text-xs">AI 프롬프트</Label>
                          <textarea
                            value={qaForm.prompt}
                            onChange={(e) => setQaForm(prev => ({ ...prev, prompt: e.target.value }))}
                            maxLength={500}
                            placeholder="예: 해당 부분에 대해 더 많은 자료를 찾아봐줘"
                            className="w-full rounded-md border bg-background px-3 py-2 text-sm min-h-[60px] resize-none focus:outline-none focus:ring-2 focus:ring-ring"
                          />
                        </div>
                        <div className="flex justify-end gap-2">
                          <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={() => setQaEditingIdx(null)}>
                            취소
                          </Button>
                          <Button
                            size="sm"
                            className="h-7 text-xs"
                            disabled={!qaForm.label.trim() || !qaForm.prompt.trim() || qaSaving}
                            onClick={async () => {
                              setQaSaving(true)
                              try {
                                const newId = 'custom_' + Date.now()
                                const newAction = {
                                  id: newId,
                                  label: qaForm.label.trim(),
                                  caption: qaForm.caption.trim(),
                                  prompt: qaForm.prompt.trim(),
                                  visible: true,
                                }
                                const updated = [...qaActions, newAction]
                                const result = await quickActionsAPI.update(updated)
                                setQaActions(result.actions || updated)
                                setQaEditingIdx(null)
                                toast.success('메뉴가 추가되었습니다.')
                              } catch (e) {
                                toast.error(e?.response?.data?.detail?.message || '저장에 실패했습니다.')
                              } finally {
                                setQaSaving(false)
                              }
                            }}
                          >
                            {qaSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : '추가'}
                          </Button>
                        </div>
                      </div>
                    )}
                </div>
              </div>
            )}

            {activeMenu === 'my-info' && (
              <div className="space-y-10">
                {/* Identity header — avatar + name + status row */}
                {myInfoLoading ? (
                  <div className="text-sm text-muted-foreground">불러오는 중…</div>
                ) : myInfoUser ? (
                  <div className="flex items-center gap-5">
                    <div className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-muted text-2xl font-semibold uppercase text-foreground/70">
                      {(myInfoUser.username || '?').slice(0, 1)}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2 text-lg font-semibold leading-tight">
                        {myInfoUser.username || '—'}
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-[11px] font-normal text-muted-foreground">
                          <span className={`h-1.5 w-1.5 rounded-full ${String(myInfoUser.status).toLowerCase() === 'active' ? 'bg-emerald-500' : 'bg-zinc-400'}`} />
                          {String(myInfoUser.status || '—')}
                        </span>
                      </div>
                      <div className="mt-1 text-sm text-muted-foreground">{myInfoUser.email || '—'}</div>
                      <div className="mt-2 text-[11px] uppercase tracking-wide text-muted-foreground/70">{String(myInfoUser.role || '—')}</div>
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground">표시할 정보가 없습니다.</div>
                )}

              </div>
            )}
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>

    {/* Delete Model Confirmation Dialog - outside main Dialog to avoid portal conflicts */}
    <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>모델 삭제</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div>
              <span className="font-medium text-foreground">'{deleteTargetModel?.name}'</span> 모델을 삭제할까요?
              <br />
              <span className="text-muted-foreground">다시 사용하려면 재다운로드가 필요합니다.</span>
              {ollamaModel === deleteTargetModel?.name && (
                <span className="block mt-2 text-amber-600">
                  ⚠ 현재 선택된 모델입니다. 삭제 시 모델 선택이 해제됩니다.
                </span>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>취소</AlertDialogCancel>
          <AlertDialogAction
            onClick={confirmDeleteModel}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            삭제
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>

    {/* Persona Reset Confirmation Dialog */}
    <ConfirmDialog
      open={personaResetTarget !== null}
      onOpenChange={(open) => { if (!open) setPersonaResetTarget(null) }}
      title="AI 페르소나를 초기화할까요?"
      description="현재 편집한 내용이 제거되고 마지막 저장 상태로 되돌아갑니다."
      confirmText="초기화"
      cancelText="취소"
      variant="destructive"
      onConfirm={handlePersonaResetConfirm}
    />
    </>
    </IconContext.Provider>
  )
}

function KistiMcpReadOnlyPanel({ isAdmin }) {
  const [servers, setServers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    mcpAPI.listServers()
      .then((data) => { if (!cancelled) setServers(Array.isArray(data) ? data : (data?.servers || [])) })
      .catch((err) => { if (!cancelled) setError(err?.message || 'MCP 서버 목록을 불러오지 못했습니다.') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [])

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">MCP</h2>
        <p className="mt-1 text-xs text-muted-foreground">
          DOREA-XP는 KISTI-MCP 데모 엔트리만 제공합니다. 실제 호출에는 KISTI API 키가 필요합니다.
        </p>
      </div>
      {loading && <div className="text-sm text-muted-foreground">불러오는 중…</div>}
      {error && <div className="text-sm text-destructive">{error}</div>}
      {!loading && !error && servers.length === 0 && (
        <div className="text-sm text-muted-foreground">등록된 MCP 서버가 없습니다.</div>
      )}
      <ul className="space-y-3">
        {servers.map((server) => (
          <KistiMcpServerCard key={server.id || server.name} server={server} isAdmin={isAdmin} />
        ))}
      </ul>
    </div>
  )
}

function KistiMcpServerCard({ server, isAdmin }) {
  const envKeys = Array.isArray(server?.config_json?.env_keys) ? server.config_json.env_keys : []
  const [status, setStatus] = useState(null)
  const [statusLoading, setStatusLoading] = useState(false)
  const [editValues, setEditValues] = useState({})
  const [saving, setSaving] = useState(false)

  const loadStatus = async () => {
    if (!isAdmin || !server.id || envKeys.length === 0) return
    setStatusLoading(true)
    try {
      const data = await mcpAPI.getSecretStatus(server.id)
      setStatus(data)
    } catch (e) {
      // non-critical
    } finally {
      setStatusLoading(false)
    }
  }

  useEffect(() => { loadStatus() }, [server.id, isAdmin])

  const handleSave = async () => {
    if (!isAdmin || !server.id) return
    const payload = {}
    for (const key of envKeys) {
      const v = (editValues[key] || '').trim()
      if (v) payload[key] = v
    }
    if (Object.keys(payload).length === 0) {
      toast.info('변경된 값이 없습니다.')
      return
    }
    setSaving(true)
    try {
      await mcpAPI.updateSecret(server.id, payload)
      toast.success('API 키가 저장되었습니다.')
      setEditValues({})
      await loadStatus()
    } catch (e) {
      const msg = e?.response?.data?.detail?.message || e?.message || 'API 키 저장에 실패했습니다.'
      toast.error(msg)
    } finally {
      setSaving(false)
    }
  }

  return (
    <li className="rounded-md border p-3 space-y-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="font-medium">{server.display_name || server.name}</div>
        <span className="text-[11px] text-muted-foreground font-mono">{server.name}</span>
      </div>
      {server.description && (
        <div className="text-xs text-muted-foreground">{server.description}</div>
      )}
      {isAdmin && envKeys.length > 0 && (
        <div className="space-y-2 pt-1">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-muted-foreground">API 키 ({envKeys.length}개)</div>
            {status && (
              <span className={`text-[11px] ${status.configured ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}`}>
                {status.configured ? '모든 키 설정됨' : `${Object.values(status.keys || {}).filter(k => k.configured).length}/${envKeys.length} 설정됨`}
              </span>
            )}
          </div>
          <div className="space-y-2">
            {envKeys.map((key) => {
              const ks = status?.keys?.[key]
              const masked = ks?.masked
              return (
                <div key={key} className="grid grid-cols-[200px_1fr] items-center gap-2">
                  <Label htmlFor={`mcp-${server.id}-${key}`} className="font-mono text-[11px] truncate" title={key}>
                    {key}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Input
                      id={`mcp-${server.id}-${key}`}
                      type="password"
                      value={editValues[key] ?? ''}
                      onChange={(e) => setEditValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      placeholder={masked || '미설정'}
                      className="h-8 text-xs font-mono"
                      autoComplete="off"
                    />
                  </div>
                </div>
              )
            })}
          </div>
          <div className="flex items-center justify-end gap-2 pt-1">
            <Button size="sm" variant="ghost" onClick={loadStatus} disabled={statusLoading}>
              {statusLoading ? '확인중…' : '새로고침'}
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? '저장중…' : '저장'}
            </Button>
          </div>
        </div>
      )}
      {!isAdmin && envKeys.length > 0 && (
        <div className="text-[11px] text-muted-foreground">
          API 키 설정은 관리자만 변경할 수 있습니다.
        </div>
      )}
    </li>
  )
}
