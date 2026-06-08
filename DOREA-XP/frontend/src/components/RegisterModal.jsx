import React, { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import api from '../services/api'

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"

// 예약된 아이디 체크
function isReservedUsername(username) {
  const reserved = ['admin', 'administrator', 'root', 'system']
  return reserved.includes(String(username || '').trim().toLowerCase())
}

// 이메일 형식 검증
function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  return emailRegex.test(email)
}

// 한국 전화번호 형식 검증 (휴대폰, 유선)
function isValidPhoneNumber(phone) {
  if (!phone) return true // 선택 필드이므로 빈 값 허용
  // 숫자만 추출
  const digits = phone.replace(/[^0-9]/g, '')
  // 휴대폰: 010, 011, 016, 017, 018, 019로 시작하는 10-11자리
  // 유선: 02(서울), 031-064(지역번호)로 시작하는 9-11자리
  const mobileRegex = /^01[016789]\d{7,8}$/
  const landlineRegex = /^0(2|[3-6][1-5])\d{6,8}$/
  return mobileRegex.test(digits) || landlineRegex.test(digits)
}

// 전화번호 포맷팅
function formatPhoneNumber(value) {
  const digits = value.replace(/[^0-9]/g, '')
  
  if (digits.startsWith('02')) {
    // 서울 지역번호
    if (digits.length <= 2) return digits
    if (digits.length <= 5) return `${digits.slice(0, 2)}-${digits.slice(2)}`
    if (digits.length <= 9) return `${digits.slice(0, 2)}-${digits.slice(2, 5)}-${digits.slice(5)}`
    return `${digits.slice(0, 2)}-${digits.slice(2, 6)}-${digits.slice(6, 10)}`
  } else if (digits.startsWith('01')) {
    // 휴대폰
    if (digits.length <= 3) return digits
    if (digits.length <= 7) return `${digits.slice(0, 3)}-${digits.slice(3)}`
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`
  } else {
    // 기타 지역번호
    if (digits.length <= 3) return digits
    if (digits.length <= 6) return `${digits.slice(0, 3)}-${digits.slice(3)}`
    if (digits.length <= 10) return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`
    return `${digits.slice(0, 3)}-${digits.slice(3, 7)}-${digits.slice(7, 11)}`
  }
}

export default function RegisterModal({ open, onClose, onSuccess }) {
  // 기본 필드
  const [username, setUsername] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [passwordConfirm, setPasswordConfirm] = useState('')
  const [phone, setPhone] = useState('')
  
  // 상태
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  
  // 아이디 중복 확인 상태
  const [usernameChecked, setUsernameChecked] = useState(false)
  const [usernameAvailable, setUsernameAvailable] = useState(false)
  const [checkingUsername, setCheckingUsername] = useState(false)

  const usernameRef = useRef(null)

  // 모달 열릴 때 초기화
  useEffect(() => {
    if (open) {
      setError('')
      setLoading(false)
      setUsername('')
      setEmail('')
      setPassword('')
      setPasswordConfirm('')
      setPhone('')
      setUsernameChecked(false)
      setUsernameAvailable(false)
      setTimeout(() => usernameRef.current?.focus(), 0)
    }
  }, [open])

  // 아이디 변경 시 중복확인 초기화
  useEffect(() => {
    setUsernameChecked(false)
    setUsernameAvailable(false)
  }, [username])

  // 유효성 검사
  const reserved = useMemo(() => isReservedUsername(username), [username])
  const emailValid = useMemo(() => isValidEmail(email), [email])
  const passwordMatch = useMemo(() => password === passwordConfirm, [password, passwordConfirm])
  const phoneValid = useMemo(() => isValidPhoneNumber(phone), [phone])
  
  // 폼 유효성
  const isFormValid = useMemo(() => {
    return (
      username.trim().length >= 3 &&
      !reserved &&
      usernameChecked &&
      usernameAvailable &&
      emailValid &&
      password.length >= 8 &&
      passwordMatch &&
      phoneValid
    )
  }, [username, reserved, usernameChecked, usernameAvailable, emailValid, password, passwordMatch, phoneValid])

  // 아이디 중복 확인
  const checkUsername = useCallback(async () => {
    if (!username.trim() || username.trim().length < 3) {
      setError('아이디는 3자 이상이어야 합니다.')
      return
    }
    
    if (reserved) {
      setError('예약된 아이디는 사용할 수 없습니다.')
      return
    }

    setCheckingUsername(true)
    setError('')
    
    try {
      const res = await api.get(`/auth/check-username?username=${encodeURIComponent(username.trim())}`)
      setUsernameChecked(true)
      setUsernameAvailable(res.data.available)
      
      if (!res.data.available) {
        setError('이미 사용 중인 아이디입니다.')
      }
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || '중복 확인 실패'
      setError(String(msg))
      setUsernameChecked(false)
      setUsernameAvailable(false)
    } finally {
      setCheckingUsername(false)
    }
  }, [username, reserved])

  // 전화번호 입력 핸들러
  const handlePhoneChange = useCallback((e) => {
    const formatted = formatPhoneNumber(e.target.value)
    setPhone(formatted)
  }, [])

  // 폼 제출
  async function submit(e) {
    e.preventDefault()
    setError('')

    // 최종 검증
    if (!usernameChecked || !usernameAvailable) {
      setError('아이디 중복확인을 해주세요.')
      return
    }

    if (!emailValid) {
      setError('올바른 이메일 형식을 입력해주세요.')
      return
    }

    if (!passwordMatch) {
      setError('비밀번호가 일치하지 않습니다.')
      return
    }

    if (!phoneValid) {
      setError('올바른 전화번호 형식을 입력해주세요.')
      return
    }

    setLoading(true)
    try {
      await api.post('/auth/register', { 
        username: username.trim(), 
        email: email.trim(), 
        password,
        phone: phone ? phone.replace(/[^0-9]/g, '') : null
      })
      onSuccess?.({ username: username.trim() })
      onClose?.()
    } catch (err) {
      const msg = err?.response?.data?.detail || err?.message || '회원가입 실패'
      setError(String(msg))
    } finally {
      setLoading(false)
    }
  }

  if (!open) return null


  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose?.() }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>회원가입</DialogTitle>
          <DialogDescription>계정을 생성합니다. 아이디는 중복확인이 필요합니다.</DialogDescription>
        </DialogHeader>

        {error ? (
          <Alert variant="destructive">
            <AlertTitle>오류</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}

        <form onSubmit={submit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="reg-username">아이디 *</Label>
            <div className="flex gap-2">
              <Input
                id="reg-username"
                ref={usernameRef}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="영문, 숫자 3자 이상"
                autoComplete="username"
                required
                minLength={3}
                className={
                  usernameChecked
                    ? (usernameAvailable
                        ? "border-emerald-500 focus-visible:ring-emerald-500/30"
                        : "border-destructive focus-visible:ring-destructive/30")
                    : reserved
                      ? "border-destructive focus-visible:ring-destructive/30"
                      : ""
                }
              />
              <Button
                type="button"
                variant="outline"
                onClick={checkUsername}
                disabled={checkingUsername || !username.trim() || username.trim().length < 3 || reserved}
              >
                {checkingUsername ? "확인 중..." : "중복확인"}
              </Button>
            </div>
            {reserved ? <div className="text-xs text-destructive">예약된 아이디입니다.</div> : null}
            {usernameChecked && usernameAvailable ? (
              <div className="text-xs text-emerald-600">사용 가능한 아이디입니다.</div>
            ) : null}
            {usernameChecked && !usernameAvailable && !reserved ? (
              <div className="text-xs text-destructive">이미 사용 중인 아이디입니다.</div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reg-email">이메일 *</Label>
            <Input
              id="reg-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="example@email.com"
              autoComplete="email"
              required
              className={email && !emailValid ? "border-destructive focus-visible:ring-destructive/30" : ""}
            />
            {email && !emailValid ? (
              <div className="text-xs text-destructive">올바른 이메일 형식을 입력해주세요.</div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reg-password">비밀번호 *</Label>
            <Input
              id="reg-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="8자 이상"
              autoComplete="new-password"
              required
              minLength={8}
            />
            <div className="text-xs text-muted-foreground">영문, 숫자를 포함한 8자 이상</div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="reg-password-confirm">비밀번호 확인 *</Label>
            <Input
              id="reg-password-confirm"
              type="password"
              value={passwordConfirm}
              onChange={(e) => setPasswordConfirm(e.target.value)}
              placeholder="비밀번호를 다시 입력하세요"
              autoComplete="new-password"
              required
              minLength={8}
              className={passwordConfirm && !passwordMatch ? "border-destructive focus-visible:ring-destructive/30" : ""}
            />
            {passwordConfirm && !passwordMatch ? (
              <div className="text-xs text-destructive">비밀번호가 일치하지 않습니다.</div>
            ) : null}
            {passwordConfirm && passwordMatch && password.length >= 8 ? (
              <div className="text-xs text-emerald-600">비밀번호가 일치합니다.</div>
            ) : null}
          </div>

          <div className="space-y-2">
            <Label htmlFor="reg-phone">연락처</Label>
            <Input
              id="reg-phone"
              type="tel"
              value={phone}
              onChange={handlePhoneChange}
              placeholder="010-0000-0000"
              autoComplete="tel"
              className={phone && !phoneValid ? "border-destructive focus-visible:ring-destructive/30" : ""}
            />
            <div className="text-xs text-muted-foreground">휴대폰 또는 유선 전화번호 (선택사항)</div>
            {phone && !phoneValid ? (
              <div className="text-xs text-destructive">올바른 전화번호 형식을 입력해주세요.</div>
            ) : null}
          </div>

          <DialogFooter>
            <Button type="button" variant="secondary" onClick={onClose} disabled={loading}>
              취소
            </Button>
            <Button type="submit" disabled={loading || !isFormValid}>
              {loading ? "처리 중..." : "가입하기"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
