import React, { useState } from 'react'
import { useAccentTheme } from './AccentThemeProvider'
import { Button } from '@/components/ui/button'
import { Palette, Check } from 'lucide-react'

export default function AccentDropdown() {
  const { accent, setAccent, options } = useAccentTheme()
  const [open, setOpen] = useState(false)

  const handleSelect = (value) => {
    console.log('[AccentDropdown] changing accent to:', value)
    setAccent(value)
    setOpen(false)
  }

  return (
    <div className="relative">
      <Button 
        variant="outline" 
        size="sm" 
        className="gap-1.5"
        onClick={() => setOpen(!open)}
      >
        <Palette className="size-4" />
        <span className="hidden sm:inline">테마</span>
      </Button>
      
      {open && (
        <>
          {/* Backdrop to close on outside click */}
          <div 
            className="fixed inset-0 z-40" 
            onClick={() => setOpen(false)} 
          />
          
          {/* Dropdown menu */}
          <div className="absolute right-0 top-full mt-1 z-50 w-40 rounded-md border bg-popover p-1 shadow-md">
            {options.map((opt) => (
              <button
                key={opt.value}
                onClick={() => handleSelect(opt.value)}
                className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm hover:bg-accent hover:text-accent-foreground"
              >
                <span
                  className="size-3 rounded-full border"
                  style={{ backgroundColor: opt.color }}
                />
                <span className="flex-1 text-left">{opt.label}</span>
                {accent === opt.value && <Check className="size-4" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
