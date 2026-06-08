import React from "react"

export default function PixelLogo() {
  return (
    <div className="flex flex-col items-center gap-2">
      <img
        src="/logo-dorea.png"
        alt="DOREA-X"
        className="h-48 w-auto"
      />
      <div className="text-xs text-muted-foreground">PDF 문서 분석 및 AI 대화 시스템</div>
      <div className="text-[11px] text-muted-foreground/60 tracking-wide">v202603.1601</div>
    </div>
  )
}
