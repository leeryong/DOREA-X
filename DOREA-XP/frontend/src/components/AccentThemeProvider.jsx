import React, { createContext, useContext, useState, useEffect } from 'react'

const AccentThemeContext = createContext(null)

export const ACCENT_OPTIONS = [
  { value: 'default', label: '기본', color: 'oklch(0.556 0 0)' },
  { value: 'blue', label: 'Blue', color: 'oklch(0.488 0.243 264.376)' },
  { value: 'emerald', label: 'Emerald', color: 'oklch(0.60 0.13 163)' },
  { value: 'orange', label: 'Orange', color: 'oklch(0.646 0.222 41.116)' },
  { value: 'violet', label: 'Violet', color: 'oklch(0.541 0.281 293.009)' },
  { value: 'rose', label: 'Rose', color: 'oklch(0.586 0.253 17.585)' },
]

export function AccentThemeProvider({ children, defaultAccent = 'default' }) {
  const [accent, setAccent] = useState(defaultAccent)

  useEffect(() => {
    const root = document.documentElement
    if (accent === 'default') {
      root.removeAttribute('data-accent')
    } else {
      root.setAttribute('data-accent', accent)
    }
  }, [accent])

  return (
    <AccentThemeContext.Provider value={{ accent, setAccent, options: ACCENT_OPTIONS }}>
      {children}
    </AccentThemeContext.Provider>
  )
}

export function useAccentTheme() {
  const ctx = useContext(AccentThemeContext)
  if (!ctx) {
    throw new Error('useAccentTheme must be used within AccentThemeProvider')
  }
  return ctx
}
