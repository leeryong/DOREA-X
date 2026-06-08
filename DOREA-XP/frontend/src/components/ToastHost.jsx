import React, { useEffect } from "react"
import { toast as sonnerToast } from "sonner"
import { onToast } from "../services/toast"
import { Toaster } from "./ui/sonner"

export default function ToastHost() {
  useEffect(() => {
    return onToast((t) => {
      const message = t?.message ?? ""
      const meta = t?.meta
      const description = meta?.request_id ? `request_id: ${meta.request_id}` : undefined

      if (t?.type === "error") return sonnerToast.error(message, { description })
      if (t?.type === "success") return sonnerToast.success(message, { description })
      if (t?.type === "warning") return sonnerToast.warning(message, { description })
      if (t?.type === "info") return sonnerToast.info(message, { description })
      return sonnerToast(message, { description })
    })
  }, [])

  return <Toaster position="bottom-center" offset={80} />
}
