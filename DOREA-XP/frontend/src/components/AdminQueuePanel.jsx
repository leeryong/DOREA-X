import { useState, useEffect, useRef, useCallback } from 'react'
import api from '../services/api'
import { toast } from '../services/toast'
import { getOrCreateProcessingHistorySessionStart, resetProcessingHistorySession } from '../services/processingHistorySession'
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { RefreshCw, Clock, Users, Zap, Loader2, FileText, User, History, Trash2 } from "lucide-react"

function formatTime(seconds) {
  if (seconds < 60) return `${Math.round(seconds)}초`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}분 ${Math.round(seconds % 60)}초`
  return `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`
}

function formatDateTime(dateStr) {
  if (!dateStr) return '-'
  const d = new Date(dateStr)
  return d.toLocaleString('ko-KR', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatProvider(_provider) {
  return 'OpenDataLoader'
}

function parseGpuUsage(item) {
  const raw =
    item?.uses_gpu ??
    item?.use_gpu ??
    item?.gpu_enabled ??
    item?.is_gpu ??
    item?.gpu

  if (typeof raw === 'boolean') return raw
  if (typeof raw === 'number') return raw !== 0
  if (typeof raw === 'string') {
    const v = raw.trim().toLowerCase()
    if (['true', '1', 'y', 'yes', 'gpu', 'enabled', 'on'].includes(v)) return true
    if (['false', '0', 'n', 'no', 'cpu', 'disabled', 'off'].includes(v)) return false
  }
  return null
}

function renderGpuLabel(item) {
  const gpu = parseGpuUsage(item)
  if (gpu === true) return 'GPU'
  if (gpu === false) return 'CPU'
  return '확인중'
}

function formatProviderWithCompute(item) {
  return `${formatProvider(item?.analysis_provider)} · ${renderGpuLabel(item)}`
}

function formatDuration(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 0) return '-'
  return formatTime(seconds)
}

function getStatusBadge(status) {
  const normalized = String(status || '').toLowerCase()
  if (normalized === 'completed') {
    return { label: '완료', className: 'border-emerald-200 text-emerald-700 dark:border-emerald-900 dark:text-emerald-300' }
  }
  if (normalized === 'failed') {
    return { label: '실패', className: 'border-rose-200 text-rose-700 dark:border-rose-900 dark:text-rose-300' }
  }
  return { label: normalized || '-', className: '' }
}

export default function AdminQueuePanel({ isAdmin }) {
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [sessionStartedAt, setSessionStartedAt] = useState(() => getOrCreateProcessingHistorySessionStart())
  const intervalRef = useRef(null)

  const loadQueue = useCallback(async (silent = false) => {
    if (!isAdmin) return
    try {
      if (!silent) setLoading(true)
      setError(null)
      const res = await api.get('/admin/queue', {
        params: {
          history_since: sessionStartedAt,
          history_limit: 200,
        },
      })
      setData(res.data)
    } catch (e) {
      setError('큐 상태를 불러오지 못했습니다.')
      if (!silent) toast.error('큐 상태를 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [isAdmin, sessionStartedAt])

  const clearHistory = useCallback(() => {
    const nextStartedAt = resetProcessingHistorySession()
    setSessionStartedAt(nextStartedAt)
    setData((prev) => (prev ? { ...prev, history: [] } : prev))
    toast.success('처리이력을 초기화했습니다.')
  }, [])

  // 초기 로딩
  useEffect(() => {
    loadQueue()
  }, [loadQueue])

  // 자동 새로고침 (5초)
  useEffect(() => {
    if (autoRefresh && isAdmin) {
      intervalRef.current = setInterval(() => {
        loadQueue(true)
      }, 5000)
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current)
        intervalRef.current = null
      }
    }
  }, [autoRefresh, isAdmin, loadQueue])

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground">
        관리자 권한이 필요합니다.
      </div>
    )
  }

  const historyItems = Array.isArray(data?.history) ? data.history : []

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">QUEUE관리</div>
          <div className="text-sm text-muted-foreground">
            문서 처리 대기열 모니터링
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="auto-refresh"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            <Label htmlFor="auto-refresh" className="text-sm">
              자동 새로고침 (5초)
            </Label>
          </div>
          <Button variant="outline" size="sm" onClick={() => loadQueue()} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
            새로고침
          </Button>
        </div>
      </div>

      {error ? (
        <div className="flex items-center justify-center h-40 text-destructive">
          {error}
        </div>
      ) : !data ? (
        <div className="flex items-center justify-center h-40 text-muted-foreground">
          로딩 중...
        </div>
      ) : (
        <>
          {/* Stats Cards */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <FileText className="h-4 w-4" />
                  대기 건수
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.stats.total_queued}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <Users className="h-4 w-4" />
                  활성 사용자
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.stats.active_users}</div>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <Clock className="h-4 w-4" />
                  평균 처리시간
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{formatTime(data.stats.avg_processing_time)}</div>
              </CardContent>
            </Card>
          </div>

          {/* Current Processing */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                현재 처리 중
              </CardTitle>
            </CardHeader>
            <CardContent>
              {data.current ? (
                <div className="flex items-center gap-4 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                  <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate" title={data.current.filename}>
                      {data.current.filename}
                    </div>
                    <div className="text-sm text-muted-foreground flex items-center gap-3">
                      <span className="flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {data.current.username} (ID: {data.current.user_id})
                      </span>
                      <span>|</span>
                      <span>상태: {data.current.status}</span>
                      <span>|</span>
                      <span>
                        Provider: <Badge variant="outline" className="ml-1">{formatProviderWithCompute(data.current)}</Badge>
                      </span>
                      <span>|</span>
                      <span>경과: {formatTime(data.current.elapsed_seconds)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground py-3 text-center">
                  현재 처리 중인 항목 없음
                </div>
              )}
            </CardContent>
          </Card>

          {/* Queue List */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  대기열
                  {data.queue.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {data.queue.length}건
                    </Badge>
                  )}
                </CardTitle>
                <span className="text-xs text-muted-foreground whitespace-nowrap">
                  서버 시간: {formatDateTime(data.server_time)}
                </span>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {data.queue.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  대기 중인 항목 없음
                </div>
              ) : (
                <ScrollArea className="h-[300px]">
                  <div className="px-6 pb-4">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">순서</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">파일명</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">사용자</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">Provider</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">대기 시작</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground">ETA (예상)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {data.queue.map((item) => (
                          <tr key={item.file_id} className="border-b last:border-0 hover:bg-muted/50">
                            <td className="py-2 px-2">
                              <Badge variant="outline">{item.position}</Badge>
                            </td>
                            <td className="py-2 px-2">
                              <div className="truncate max-w-[200px]" title={item.filename}>
                                {item.filename}
                              </div>
                            </td>
                            <td className="py-2 px-2">
                              <div className="flex items-center gap-1 text-muted-foreground">
                                <User className="h-3 w-3" />
                                {item.username}
                                <span className="text-xs">(ID:{item.user_id})</span>
                              </div>
                            </td>
                            <td className="py-2 px-2">
                              <Badge variant="outline">{formatProviderWithCompute(item)}</Badge>
                            </td>
                            <td className="py-2 px-2 text-muted-foreground">
                              {formatDateTime(item.enqueued_at)}
                            </td>
                            <td className="py-2 px-2 text-right">
                              ~{formatTime(item.eta_seconds)} (예상)
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-3">
              <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                <div>
                  <CardTitle className="text-base flex items-center gap-2">
                    <History className="h-4 w-4 text-sky-600" />
                    처리이력
                    {historyItems.length > 0 && (
                      <Badge variant="secondary" className="ml-2">
                        {historyItems.length}건
                      </Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="mt-1">
                    로그인 세션 기준 누적 · 시작 시각 {formatDateTime(sessionStartedAt)}
                  </CardDescription>
                </div>
                <Button variant="outline" size="sm" onClick={clearHistory} disabled={loading}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  이력 초기화
                </Button>
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {historyItems.length === 0 ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  현재 로그인 세션에 누적된 처리이력이 없습니다.
                </div>
              ) : (
                <ScrollArea className="h-[320px]">
                  <div className="px-6 pb-4 overflow-x-auto">
                    <table className="w-full min-w-[980px] text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">최종 처리시각</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">파일명</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">사용자</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">레이아웃 모델</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">GPU</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground">총 처리시간</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">PDF 변환시각</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">상태</th>
                        </tr>
                      </thead>
                      <tbody>
                        {historyItems.map((item) => {
                          const statusBadge = getStatusBadge(item.status)
                          return (
                            <tr key={`${item.file_id}-${item.processing_completed_at || item.converted_at || item.filename}`} className="border-b last:border-0 hover:bg-muted/50">
                              <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
                                {formatDateTime(item.processing_completed_at)}
                              </td>
                              <td className="py-2 px-2">
                                <div className="truncate max-w-[220px] font-medium" title={item.filename}>
                                  {item.filename}
                                </div>
                              </td>
                              <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
                                {item.username} <span className="text-xs">(ID:{item.user_id})</span>
                              </td>
                              <td className="py-2 px-2 whitespace-nowrap">
                                <Badge variant="outline">{formatProvider(item.analysis_provider)}</Badge>
                              </td>
                              <td className="py-2 px-2 whitespace-nowrap">
                                <Badge variant="outline">{renderGpuLabel(item)}</Badge>
                              </td>
                              <td className="py-2 px-2 text-right whitespace-nowrap font-medium">
                                {formatDuration(item.processing_duration_seconds)}
                              </td>
                              <td className="py-2 px-2 text-muted-foreground whitespace-nowrap">
                                {formatDateTime(item.converted_at)}
                              </td>
                              <td className="py-2 px-2 whitespace-nowrap">
                                <Badge variant="outline" className={statusBadge.className}>{statusBadge.label}</Badge>
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                </ScrollArea>
              )}
            </CardContent>
          </Card>

        </>
      )}
    </div>
  )
}
