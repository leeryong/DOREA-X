import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog"

/**
 * 커스텀 확인 다이얼로그
 * window.confirm 대체용
 * 
 * Props:
 * - open: boolean (열림 상태)
 * - onOpenChange: (open: boolean) => void
 * - title: string (기본: "DOREA-X")
 * - description: string (본문 메시지)
 * - confirmText: string (확인 버튼 텍스트, 기본: "확인")
 * - cancelText: string (취소 버튼 텍스트, 기본: "취소")
 * - onConfirm: () => void (확인 클릭 시)
 * - onCancel: () => void (취소 클릭 시, optional)
 * - variant: "default" | "destructive" (삭제 등 위험한 동작은 destructive)
 */
export default function ConfirmDialog({
  open,
  onOpenChange,
  title = "DOREA-X",
  description,
  confirmText = "확인",
  cancelText = "취소",
  onConfirm,
  onCancel,
  variant = "default",
}) {
  const handleConfirm = () => {
    onConfirm?.()
    onOpenChange?.(false)
  }

  const handleCancel = () => {
    onCancel?.()
    onOpenChange?.(false)
  }

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">
            {description}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {cancelText ? (
            <AlertDialogCancel onClick={handleCancel}>
              {cancelText}
            </AlertDialogCancel>
          ) : null}
          <AlertDialogAction
            onClick={handleConfirm}
            className={variant === "destructive" ? "bg-destructive text-destructive-foreground hover:bg-destructive/90" : ""}
          >
            {confirmText}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
