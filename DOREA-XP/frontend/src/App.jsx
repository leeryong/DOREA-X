import React from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import LoginLanding from './pages/LoginLanding.jsx'
import MainShell from './pages/MainShell.jsx'
import ToastHost from './components/ToastHost.jsx'

function RequireAuth({ children }) {
  const token = localStorage.getItem('access_token')
  if (!token) return <Navigate to="/" replace />
  return children
}

export default function App() {
  return (
    <>
      <ToastHost />
      <Routes>
      <Route path="/" element={<LoginLanding />} />
      <Route
        path="/app"
        element={
          <RequireAuth>
            <MainShell />
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </>
  )
}
