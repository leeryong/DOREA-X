import { pushNotification } from './notification-center'

let listeners = new Set()

export function onToast(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

function emit(toast) {
  // Sonner listeners (existing)
  for (const fn of listeners) fn(toast)
  // Dual-write: only push errors to notification center (critical issues with root cause)
  if (!toast.meta?.noHistory && toast.type === 'error') {
    pushNotification(toast.type, toast.message, toast.meta)
  }
}

export const toast = {
  error: (message, meta = {}) => emit({ type: 'error', message, meta }),
  info: (message, meta = {}) => emit({ type: 'info', message, meta }),
  success: (message, meta = {}) => emit({ type: 'success', message, meta }),
  warning: (message, meta = {}) => emit({ type: 'warning', message, meta })
}
