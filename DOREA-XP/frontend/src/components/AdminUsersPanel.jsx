import React, { useEffect, useState } from 'react'
import api from '../services/api'
import { toast } from '../services/toast'
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { Separator } from "@/components/ui/separator"
import { RefreshCw, Search, User, Trash2, Save, Settings, Eye } from "lucide-react"

// 등급 프리셋 매핑
const LEVEL_PRESETS = [
  { value: '0', label: '관리자', level: 0, status: 'active' },
  { value: '8', label: '일반 회원', level: 8, status: 'active' },
  { value: '9', label: '승인 대기', level: 9, status: 'pending' },
  { value: '10', label: '비활성', level: 10, status: 'deactivated' },
]

function getLevelPreset(level) {
  const preset = LEVEL_PRESETS.find(p => p.level === level)
  if (preset) return preset.value
  // 1~7은 일반 회원으로 처리
  if (level >= 1 && level <= 7) return '8'
  return '8'
}

function getStatusBadgeVariant(status) {
  switch (status) {
    case 'active': return 'default'
    case 'pending': return 'secondary'
    case 'deactivated': return 'destructive'
    default: return 'outline'
  }
}

function getStatusLabel(status) {
  switch (status) {
    case 'active': return '활성'
    case 'pending': return '대기'
    case 'deactivated': return '비활성'
    default: return status
  }
}

export default function AdminUsersPanel({ isAdmin }) {
  const [users, setUsers] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [selectedUserId, setSelectedUserId] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  
  // 편집 상태 (선택된 유저의 수정 데이터)
  const [editData, setEditData] = useState(null)
  
  // 사용자 개인 설정 (읽기 전용)
  const [userSettings, setUserSettings] = useState(null)
  const [userSettingsLoading, setUserSettingsLoading] = useState(false)

  // 메모리 관리 상태
  const [memoryStats, setMemoryStats] = useState(null)
  const [memoryStatsLoading, setMemoryStatsLoading] = useState(false)
  const [forceDeleteOpen, setForceDeleteOpen] = useState(false)
  const [forceDeleteReason, setForceDeleteReason] = useState('')
  const [forceDeleteLoading, setForceDeleteLoading] = useState(false)

  async function loadUsers() {
    if (!isAdmin) return
    try {
      setLoading(true)
      setError(null)
      const res = await api.get('/users/?skip=0&limit=200')
      setUsers(res.data.users || [])
    } catch (e) {
      setError('회원 목록을 불러오지 못했습니다.')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadUsers()
  }, [isAdmin])

  // 유저 선택 시 편집 데이터 초기화 + 개인 설정 로드
  useEffect(() => {
    if (selectedUserId) {
      const user = users.find(u => u.id === selectedUserId)
      if (user) {
        setEditData({
          email: user.email || '',
          user_level: user.user_level,
          status: user.status,
        })
      }
      // 개인 설정 로드
      setUserSettings(null)
      setUserSettingsLoading(true)
      api.get(`/users/${selectedUserId}/settings`)
        .then(res => setUserSettings(res.data))
        .catch(() => setUserSettings(null))
        .finally(() => setUserSettingsLoading(false))
      // 메모리 통계 로드
      setMemoryStats(null)
      setMemoryStatsLoading(true)
      api.get(`/users/${selectedUserId}/memory-stats`)
        .then(res => setMemoryStats(res.data))
        .catch(() => setMemoryStats(null))
        .finally(() => setMemoryStatsLoading(false))
    } else {
      setEditData(null)
      setUserSettings(null)
    }
  }, [selectedUserId, users])

  async function saveUser() {
    if (!selectedUserId || !editData) return
    try {
      await api.patch(`/users/${selectedUserId}`, {
        email: editData.email,
        status: editData.status,
        user_level: editData.user_level
      })
      toast.success('회원 정보가 저장되었습니다')
      await loadUsers()
    } catch (e) {
      // toast handled by interceptor
    }
  }

  async function deleteUser() {
    if (!selectedUserId) return
    try {
      await api.delete(`/users/${selectedUserId}`)
      toast.success('삭제되었습니다')
      setSelectedUserId(null)
      await loadUsers()
    } catch (e) {
      // toast handled by interceptor
    }
  }

  function handleLevelPresetChange(presetValue) {
    const preset = LEVEL_PRESETS.find(p => p.value === presetValue)
    if (preset && editData) {
      setEditData({
        ...editData,
        user_level: preset.level,
        status: preset.status,
      })
    }
  }

  // 필터링된 유저 목록
  const filteredUsers = users.filter(u => {
    const matchesSearch = !searchQuery || 
      u.username?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      u.email?.toLowerCase().includes(searchQuery.toLowerCase())
    const matchesStatus = statusFilter === 'all' || u.status === statusFilter
    return matchesSearch && matchesStatus
  })

  const selectedUser = users.find(u => u.id === selectedUserId)

  if (!isAdmin) {
    return (
      <div className="flex items-center justify-center h-40 text-muted-foreground">
        관리자 권한이 필요합니다.
      </div>
    )
  }

  return (
    <div className="space-y-6 h-full flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-semibold">회원관리</div>
          <div className="text-sm text-muted-foreground">
            전체 {users.length}명
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={loadUsers} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          새로고침
        </Button>
      </div>

      {/* Content: List + Detail */}
      <div className="flex gap-4 flex-1 min-h-0">
        {/* Left: User List */}
        <div className="w-80 shrink-0 flex flex-col gap-3">
          {/* Filters */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="검색..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="pl-8"
              />
            </div>
            <Select value={statusFilter} onValueChange={setStatusFilter}>
              <SelectTrigger className="w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">전체</SelectItem>
                <SelectItem value="active">활성</SelectItem>
                <SelectItem value="pending">대기</SelectItem>
                <SelectItem value="deactivated">비활성</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* User List */}
          <ScrollArea className="flex-1 border rounded-lg">
            {loading ? (
              <div className="flex items-center justify-center h-40 text-muted-foreground">
                로딩 중...
              </div>
            ) : error ? (
              <div className="flex items-center justify-center h-40 text-destructive">
                {error}
              </div>
            ) : filteredUsers.length === 0 ? (
              <div className="flex items-center justify-center h-40 text-muted-foreground">
                회원이 없습니다.
              </div>
            ) : (
              <div className="p-2 space-y-1">
                {filteredUsers.map(u => (
                  <div
                    key={u.id}
                    onClick={() => setSelectedUserId(u.id)}
                    className={`flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors ${
                      selectedUserId === u.id 
                        ? 'bg-accent border border-primary/30' 
                        : 'hover:bg-muted/50'
                    }`}
                  >
                    <Avatar className="h-9 w-9">
                      <AvatarFallback className="bg-primary/10 text-primary text-sm">
                        {u.username?.[0]?.toUpperCase() || 'U'}
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1 min-w-0">
                      <div className="font-medium text-sm truncate">{u.username}</div>
                      <div className="text-xs text-muted-foreground truncate">{u.email}</div>
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <Badge variant={getStatusBadgeVariant(u.status)} className="text-[10px]">
                        {getStatusLabel(u.status)}
                      </Badge>
                      <span className="text-[10px] text-muted-foreground">Lv.{u.user_level}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </ScrollArea>
        </div>

        {/* Right: User Detail */}
        <div className="flex-1 min-w-0">
          {selectedUser && editData ? (
            <Card className="h-full flex flex-col">
              <CardHeader>
                <div className="flex items-center gap-4">
                  <Avatar className="h-14 w-14">
                    <AvatarFallback className="bg-primary/10 text-primary text-xl">
                      {selectedUser.username?.[0]?.toUpperCase() || 'U'}
                    </AvatarFallback>
                  </Avatar>
                  <div>
                    <CardTitle className="text-lg">{selectedUser.username}</CardTitle>
                    <CardDescription>ID: {selectedUser.id}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="flex-1 min-h-0 overflow-y-auto space-y-5">
                {/* Email */}
                <div className="flex items-center gap-3">
                  <Label className="shrink-0 w-14">이메일</Label>
                  <Input
                    value={editData.email}
                    onChange={e => setEditData({ ...editData, email: e.target.value })}
                    placeholder="email@example.com"
                    className="flex-1"
                  />
                </div>

                {/* Level Preset */}
                <div className="flex items-center gap-3">
                  <Label className="shrink-0 w-14">등급</Label>
                  <Select 
                    value={getLevelPreset(editData.user_level)} 
                    onValueChange={handleLevelPresetChange}
                  >
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVEL_PRESETS.map(preset => (
                        <SelectItem key={preset.value} value={preset.value}>
                          {preset.label} (Lv.{preset.level})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Actions */}
                <div className="flex gap-2 pt-4">
                  <Button onClick={saveUser} className="flex-1">
                    <Save className="h-4 w-4 mr-2" />
                    저장
                  </Button>
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button variant="destructive">
                        <Trash2 className="h-4 w-4 mr-2" />
                        삭제
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>회원 삭제</AlertDialogTitle>
                        <AlertDialogDescription>
                          정말 "{selectedUser.username}" 회원을 삭제하시겠습니까?
                          이 작업은 되돌릴 수 없습니다.
                        </AlertDialogDescription>
                      </AlertDialogHeader>
                      <AlertDialogFooter>
                        <AlertDialogCancel>취소</AlertDialogCancel>
                        <AlertDialogAction onClick={deleteUser}>삭제</AlertDialogAction>
                      </AlertDialogFooter>
                    </AlertDialogContent>
                  </AlertDialog>
                </div>

                {/* Read-Only Personal Settings (Admin Diagnostic) */}
                <Separator className="my-4" />
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Eye className="h-4 w-4" />
                    개인 설정 (읽기 전용)
                  </div>
                  {userSettingsLoading ? (
                    <div className="text-xs text-muted-foreground">로딩 중...</div>
                  ) : !userSettings || !userSettings.has_settings ? (
                    <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3">
                      개인 설정이 없습니다 (시스템 기본값 사용 중).
                    </div>
                  ) : (
                    <div className="space-y-2 bg-muted/50 rounded-md p-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">기본 모델</span>
                        <span className="font-mono text-xs">{userSettings.default_model || '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">온도</span>
                        <span className="font-mono text-xs">{userSettings.temperature ?? '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">최대 토큰</span>
                        <span className="font-mono text-xs">{userSettings.max_tokens ?? '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">OCR 언어</span>
                        <span className="font-mono text-xs">{userSettings.ocr_language || '-'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">OCR 사용</span>
                        <span className="font-mono text-xs">{userSettings.use_ocr ? '예' : '아니오'}</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">개인 API 키</span>
                        <span className="font-mono text-xs">
                          {userSettings.has_personal_api_key
                            ? <Badge variant="outline" className="text-[10px]">{userSettings.personal_api_key_masked}</Badge>
                            : '없음'}
                        </span>
                      </div>
                    </div>
                  )}
                </div>

                {/* Memory Governance (Admin v1: metadata + force-delete) */}
                <Separator className="my-4" />
                <div className="space-y-3">
                  <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                    <Settings className="h-4 w-4" />
                    메모리 관리
                  </div>
                  {memoryStatsLoading ? (
                    <div className="text-xs text-muted-foreground">로딩 중...</div>
                  ) : !memoryStats ? (
                    <div className="text-xs text-muted-foreground bg-muted/50 rounded-md p-3">
                      메모리 정보를 불러올 수 없습니다.
                    </div>
                  ) : (
                    <div className="space-y-2 bg-muted/50 rounded-md p-3 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">메모리 상태</span>
                        <Badge variant={memoryStats.memory_enabled ? 'default' : 'secondary'} className="text-[10px]">
                          {memoryStats.memory_enabled ? '활성' : '비활성'}
                        </Badge>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">메모리 수</span>
                        <span className="font-mono text-xs">{memoryStats.memory_count}개</span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted-foreground">마지막 업데이트</span>
                        <span className="font-mono text-xs">{memoryStats.last_updated ? new Date(memoryStats.last_updated).toLocaleDateString('ko-KR') : '-'}</span>
                      </div>
                      {memoryStats.memory_count > 0 && (
                        <div className="pt-2">
                          <AlertDialog open={forceDeleteOpen} onOpenChange={setForceDeleteOpen}>
                            <Button
                              variant="destructive"
                              size="sm"
                              className="text-xs"
                              onClick={() => { setForceDeleteOpen(true); setForceDeleteReason('') }}
                            >
                              <Trash2 className="h-3 w-3 mr-1" /> 강제 삭제
                            </Button>
                            <AlertDialogContent>
                              <AlertDialogHeader>
                                <AlertDialogTitle>사용자 메모리 강제 삭제</AlertDialogTitle>
                                <AlertDialogDescription asChild>
                                  <div className="space-y-3">
                                    <p>{memoryStats.username}님의 메모리 {memoryStats.memory_count}개를 모두 삭제합니다.</p>
                                    <div className="space-y-1">
                                      <Label className="text-xs">삭제 사유 (선택)</Label>
                                      <Input
                                        value={forceDeleteReason}
                                        onChange={(e) => setForceDeleteReason(e.target.value)}
                                        placeholder="예: 정책 위반, 사용자 요청 등"
                                        className="h-8 text-sm"
                                      />
                                    </div>
                                  </div>
                                </AlertDialogDescription>
                              </AlertDialogHeader>
                              <AlertDialogFooter>
                                <AlertDialogCancel>취소</AlertDialogCancel>
                                <AlertDialogAction
                                  onClick={async () => {
                                    setForceDeleteLoading(true)
                                    try {
                                      await api.delete(`/users/${selectedUserId}/memory`, { data: { reason: forceDeleteReason || null } })
                                      toast.success('메모리가 삭제되었습니다.')
                                      setForceDeleteOpen(false)
                                      // Reload stats
                                      const res = await api.get(`/users/${selectedUserId}/memory-stats`)
                                      setMemoryStats(res.data)
                                    } catch (e) {
                                      toast.error('메모리 삭제에 실패했습니다.')
                                    } finally { setForceDeleteLoading(false) }
                                  }}
                                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                                  disabled={forceDeleteLoading}
                                >
                                  삭제
                                </AlertDialogAction>
                              </AlertDialogFooter>
                            </AlertDialogContent>
                          </AlertDialog>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </CardContent>
            </Card>
          ) : (
            <Card className="h-full flex items-center justify-center">
              <div className="text-center text-muted-foreground">
                <User className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>좌측에서 회원을 선택하세요</p>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}
