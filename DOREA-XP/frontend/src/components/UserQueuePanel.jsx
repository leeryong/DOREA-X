import { useState, useEffect, useRef, useCallback } from 'react'
import api from '../services/api'
import { toast } from '../services/toast'
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import { RefreshCw, Clock, Users, Zap, Loader2, FileText } from "lucide-react"

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

export default function UserQueuePanel() {
  const [data, setData] = useState(null)
  const [myItems, setMyItems] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const intervalRef = useRef(null)

  const loadAll = useCallback(async (silent = false) => {
    try {
      if (!silent) setLoading(true)
      setError(null)
      const [statusRes, myRes] = await Promise.all([
        api.get('/queue/status'),
        api.get('/queue/my-items'),
      ])
      setData(statusRes.data)
      setMyItems(myRes.data)
    } catch (e) {
      setError('처리현황을 불러오지 못했습니다.')
      if (!silent) toast.error('처리현황을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    loadAll()
  }, [loadAll])

  useEffect(() => {
    if (autoRefresh) {
      intervalRef.current = setInterval(() => loadAll(true), 5000)
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
  }, [autoRefresh, loadAll])

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header — admin과 동일 레이아웃 */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">처리현황</div>
          <div className="text-sm text-muted-foreground">
            문서 처리 대기열 모니터링
          </div>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <Switch
              id="user-auto-refresh"
              checked={autoRefresh}
              onCheckedChange={setAutoRefresh}
            />
            <Label htmlFor="user-auto-refresh" className="text-sm">
              자동 새로고침 (5초)
            </Label>
          </div>
          <Button variant="outline" size="sm" onClick={() => loadAll()} disabled={loading}>
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
          {/* Stats Cards — admin과 동일 */}
          <div className="grid grid-cols-3 gap-4">
            <Card>
              <CardHeader className="pb-2">
                <CardDescription className="flex items-center gap-1.5">
                  <FileText className="h-4 w-4" />
                  전체 대기 건수
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{data.total_queued}</div>
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
                <div className="text-2xl font-bold">{data.active_users}</div>
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
                <div className="text-2xl font-bold">{formatTime(data.avg_processing_time)}</div>
              </CardContent>
            </Card>
          </div>

          {/* 현재 처리 중 — admin과 동일 카드 스타일 */}
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-4 w-4 text-amber-500" />
                현재 처리 중
              </CardTitle>
            </CardHeader>
            <CardContent>
              {myItems?.current ? (
                <div className="flex items-center gap-4 p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800">
                  <Loader2 className="h-5 w-5 animate-spin text-amber-600" />
                  <div className="flex-1 min-w-0">
                    <div className="font-medium truncate" title={myItems.current.filename}>
                      {myItems.current.filename}
                    </div>
                    <div className="text-sm text-muted-foreground flex items-center gap-2 flex-wrap">
                      <span>상태: processing</span>
                      <span>|</span>
                      <span>Provider: <Badge variant="outline" className="ml-1">{formatProviderWithCompute(myItems.current)}</Badge></span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground py-3 text-center">
                  현재 처리 중인 내 항목 없음
                </div>
              )}
            </CardContent>
          </Card>

          {/* 대기열 — admin과 동일 테이블 스타일 (사용자 컬럼 제외) */}
          <Card>
            <CardHeader className="pb-3">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base flex items-center gap-2">
                  <Clock className="h-4 w-4" />
                  내 대기열
                  {myItems?.queued?.length > 0 && (
                    <Badge variant="secondary" className="ml-2">
                      {myItems.queued.length}건
                    </Badge>
                  )}
                </CardTitle>
                {myItems?.server_time && (
                  <span className="text-xs text-muted-foreground whitespace-nowrap">
                    서버 시간: {formatDateTime(myItems.server_time)}
                  </span>
                )}
              </div>
            </CardHeader>
            <CardContent className="p-0">
              {!myItems?.queued?.length ? (
                <div className="text-sm text-muted-foreground py-6 text-center">
                  대기 중인 내 항목 없음
                </div>
              ) : (
                <ScrollArea className="h-[300px]">
                  <div className="px-6 pb-4">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="border-b">
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">순서</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">파일명</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">Provider</th>
                          <th className="text-left py-2 px-2 font-medium text-muted-foreground">대기 시작</th>
                          <th className="text-right py-2 px-2 font-medium text-muted-foreground">ETA (예상)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {myItems.queued.map((item) => (
                          <tr key={item.file_id} className="border-b last:border-0 hover:bg-muted/50">
                            <td className="py-2 px-2">
                              <Badge variant="outline">{item.position}</Badge>
                            </td>
                            <td className="py-2 px-2">
                              <div className="truncate max-w-[280px]" title={item.filename}>
                                {item.filename}
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
        </>
      )}
    </div>
  )
}
