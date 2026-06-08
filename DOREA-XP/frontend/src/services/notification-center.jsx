import React, { createContext, useContext, useState, useCallback, useRef } from 'react'

const NotificationContext = createContext(null)

const MAX_NOTIFICATIONS = 100

export function NotificationProvider({ children }) {
  const [notifications, setNotifications] = useState([])
  const idCounter = useRef(0)

  const push = useCallback((type, message, meta = {}) => {
    const id = `notif_${Date.now()}_${++idCounter.current}`
    setNotifications(prev => {
      const next = [{ id, type, message, meta, timestamp: Date.now(), read: false }, ...prev]
      return next.length > MAX_NOTIFICATIONS ? next.slice(0, MAX_NOTIFICATIONS) : next
    })
  }, [])

  const markAsRead = useCallback((id) => {
    setNotifications(prev =>
      prev.map(n => n.id === id ? { ...n, read: true } : n)
    )
  }, [])

  const markAllAsRead = useCallback(() => {
    setNotifications(prev => prev.map(n => ({ ...n, read: true })))
  }, [])

  const remove = useCallback((id) => {
    setNotifications(prev => prev.filter(n => n.id !== id))
  }, [])

  const clearAll = useCallback(() => {
    setNotifications([])
  }, [])

  const unreadCount = notifications.filter(n => !n.read).length

  return (
    <NotificationContext.Provider value={{
      notifications,
      unreadCount,
      push,
      markAsRead,
      markAllAsRead,
      remove,
      clearAll,
    }}>
      {children}
    </NotificationContext.Provider>
  )
}

export function useNotifications() {
  const ctx = useContext(NotificationContext)
  if (!ctx) {
    throw new Error('useNotifications must be used within NotificationProvider')
  }
  return ctx
}

// Global push reference — set by provider, used by toast.js (non-React code)
let _globalPush = null

export function _setGlobalPush(pushFn) {
  _globalPush = pushFn
}

export function pushNotification(type, message, meta) {
  if (_globalPush) _globalPush(type, message, meta)
}
