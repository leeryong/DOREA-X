import React, { useRef, useState } from "react"
import { useNavigate } from "react-router-dom"
import api from "../services/api"
import { startProcessingHistorySession } from '../services/processingHistorySession'
import RegisterModal from "../components/RegisterModal.jsx"
// import PixelLogo from "../components/PixelLogo.jsx"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Card,
  CardContent,
} from "@/components/ui/card"

export default function LoginLanding() {
  const [usernameOrEmail, setUsernameOrEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [loading, setLoading] = useState(false)
  const [registerOpen, setRegisterOpen] = useState(false)

  const idRef = useRef(null)
  const navigate = useNavigate()

  async function submit(e) {
    e.preventDefault()
    setError("")
    setLoading(true)
    try {
      const res = await api.post("/auth/login", {
        username_or_email: usernameOrEmail,
        password,
      })
      const token = res?.data?.access_token
      if (!token) throw new Error("access_token이 없습니다")
      localStorage.setItem("access_token", token)
      startProcessingHistorySession()
      navigate("/app")
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || "로그인 실패"
      setError(String(msg))
    } finally {
      setLoading(false)
    }
  }

  return (
    <div
      className="min-h-svh w-full px-6 py-10 flex flex-col items-center justify-center"
      style={{ backgroundColor: "#f2fcfd" }}
    >
      {/* Logo + version above card */}
      <div className="flex flex-col items-center mb-6" style={{ width: '800px', maxWidth: '100%' }}>
        <img src="/DOREAX.jpg" alt="DOREA-XP (공개용)" className="w-full h-auto object-contain" />
          <div className="text-xs text-muted-foreground mt-2">DOREA-XP (공개용)</div>
      </div>

      <Card className="w-full max-w-[400px]">
        <CardContent className="pt-6">
          {error ? (
            <div className="mb-4 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {error}
            </div>
          ) : null}

          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="username">아이디 또는 이메일</Label>
              <Input
                id="username"
                ref={idRef}
                value={usernameOrEmail}
                onChange={(e) => setUsernameOrEmail(e.target.value)}
                placeholder="아이디 또는 이메일을 입력하세요"
                autoComplete="username"
                required
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="password">비밀번호</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="비밀번호를 입력하세요"
                autoComplete="current-password"
                required
              />
            </div>

            <div className="flex gap-2 pt-2">
              <Button className="flex-1" type="submit" disabled={loading}>
                {loading ? "로그인 중..." : "로그인"}
              </Button>
              <Button
                className="flex-1"
                type="button"
                variant="secondary"
                onClick={() => setRegisterOpen(true)}
                disabled={loading}
              >
                회원가입
              </Button>
            </div>


          </form>
        </CardContent>
        <RegisterModal
          open={registerOpen}
          onClose={() => setRegisterOpen(false)}
          onSuccess={({ username }) => {
            setUsernameOrEmail(username)
            setPassword("")
            setError("")
            setTimeout(() => idRef.current?.focus(), 0)
          }}
        />
      </Card>
    </div>
  )
}
