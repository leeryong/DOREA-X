const PROCESSING_HISTORY_SESSION_KEY = 'dorea-x.processing-history.session-started-at'

function nowIso() {
  return new Date().toISOString()
}

export function startProcessingHistorySession() {
  const startedAt = nowIso()
  try {
    sessionStorage.setItem(PROCESSING_HISTORY_SESSION_KEY, startedAt)
  } catch {}
  return startedAt
}

export function getOrCreateProcessingHistorySessionStart() {
  try {
    const stored = sessionStorage.getItem(PROCESSING_HISTORY_SESSION_KEY)
    if (stored) return stored
  } catch {}
  return startProcessingHistorySession()
}

export function resetProcessingHistorySession() {
  return startProcessingHistorySession()
}

export function clearProcessingHistorySession() {
  try {
    sessionStorage.removeItem(PROCESSING_HISTORY_SESSION_KEY)
  } catch {}
}
