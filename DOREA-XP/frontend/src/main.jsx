import React, { useEffect } from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { ThemeProvider } from 'next-themes'
import { NotificationProvider, useNotifications, _setGlobalPush } from './services/notification-center'
import App from './App.jsx'
import './styles/globals.css'

// Bridge: syncs React context push to global reference for toast.js
function NotificationBridge({ children }) {
  const { push } = useNotifications()
  useEffect(() => {
    _setGlobalPush(push)
    return () => _setGlobalPush(null)
  }, [push])
  return children
}

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="light">
      <NotificationProvider>
        <NotificationBridge>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </NotificationBridge>
      </NotificationProvider>
    </ThemeProvider>
  </React.StrictMode>
)
