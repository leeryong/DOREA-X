import { useState } from 'react'
import { useNotifications } from '@/services/notification-center'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Button } from '@/components/ui/button'
import { Separator } from '@/components/ui/separator'
import { BellOff, Check, Trash2, AlertCircle, Info, CheckCircle2, AlertTriangle } from 'lucide-react'
import { BellSimpleIcon } from '@phosphor-icons/react'

const TYPE_CONFIG = {
  error: { icon: AlertCircle, color: 'text-destructive', bg: 'bg-destructive/10' },
  warning: { icon: AlertTriangle, color: 'text-amber-500', bg: 'bg-amber-500/10' },
  success: { icon: CheckCircle2, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  info: { icon: Info, color: 'text-blue-500', bg: 'bg-blue-500/10' },
}

function formatNotificationTimestamp(timestamp) {
  const date = new Date(timestamp)
  if (Number.isNaN(date.getTime())) return '-'

  const pad = (value) => String(value).padStart(2, '0')

  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export default function NotificationCenter({ buttonClassName = 'rounded-2xl h-11 w-11', iconClassName = 'size-[24px]' }) {
  const { notifications, unreadCount, markAsRead, markAllAsRead, clearAll } = useNotifications()
  const [open, setOpen] = useState(false)

  return (
    <div className="relative">
      <Button
        variant="outline"
        size="icon"
        className={`relative ${buttonClassName}`}
        onClick={() => setOpen(prev => !prev)}
        title="알림센터"
      >
        <BellSimpleIcon className={iconClassName} weight="regular" />
        {unreadCount > 0 && (
          <span className="pointer-events-none absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-destructive-foreground">
            {unreadCount > 99 ? '99+' : unreadCount}
          </span>
        )}
      </Button>

      {open && (
        <>
        {/* Backdrop: 화면 전체를 덮어 바깥 클릭 시 닫힘 */}
        <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
        <div
          className="absolute right-0 top-full mt-2 z-50 w-[30rem] max-h-[32rem] flex flex-col rounded-md border bg-popover text-popover-foreground shadow-md overflow-hidden animate-in fade-in-0 zoom-in-95"
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
            <span className="text-sm font-semibold">알림</span>
            <div className="flex items-center gap-1">
              {unreadCount > 0 && (
                <Button variant="ghost" size="sm" className="h-7 text-xs" onClick={markAllAsRead}>
                  <Check className="h-3 w-3 mr-1" />
                  모두 읽음
                </Button>
              )}
              {notifications.length > 0 && (
                <Button variant="ghost" size="sm" className="h-7 text-xs text-muted-foreground" onClick={clearAll}>
                  <Trash2 className="h-3 w-3 mr-1" />
                  전체 삭제
                </Button>
              )}
            </div>
          </div>

          {/* List */}
          {notifications.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 text-sm text-muted-foreground">
              <BellOff className="size-8 mb-2 opacity-30" />
              알림 없음
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto">
              <div className="flex flex-col">
                {notifications.map((n, idx) => {
                  const cfg = TYPE_CONFIG[n.type] || TYPE_CONFIG.info
                  const Icon = cfg.icon
                  return (
                    <div key={n.id}>
                      <button
                        className={`w-full text-left px-4 py-3 flex gap-3 items-start hover:bg-muted/50 transition-colors ${
                          n.read ? 'opacity-60' : ''
                        }`}
                        onClick={() => markAsRead(n.id)}
                      >
                        <div className={`mt-0.5 shrink-0 rounded-full p-1 ${cfg.bg}`}>
                          <Icon className={`h-3.5 w-3.5 ${cfg.color}`} />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm leading-snug break-words">{n.message}</div>
                          {/* 에러 알림: 운영 힌트 + 에러코드 표시 */}
                          {n.type === 'error' && n.meta?.hint && (
                            <div className="text-xs text-muted-foreground mt-1 leading-snug">
                              💡 {n.meta.hint}
                            </div>
                          )}
                          {n.type === 'error' && n.meta?.error_code && (
                            <div className="text-[11px] text-muted-foreground/70 mt-0.5 font-mono">
                              {n.meta.error_code}
                            </div>
                          )}
                          <div className="text-xs text-muted-foreground mt-1">일시 {formatNotificationTimestamp(n.timestamp)}</div>
                        </div>
                        {!n.read && (
                          <div className="mt-2 h-2 w-2 shrink-0 rounded-full bg-primary" />
                        )}
                      </button>
                      {idx < notifications.length - 1 && <Separator />}
                    </div>
                  )
                })}
              </div>
            </div>
          )}
        </div>
        </>
      )}
    </div>
  )
}
