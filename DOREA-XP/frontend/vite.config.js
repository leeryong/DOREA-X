import path from "path"
import { fileURLToPath } from "url"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const rhwpStudioDevTarget = process.env.VITE_RHWP_STUDIO_DEV_TARGET || "http://localhost:7700"

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/rhwp/": {
        target: rhwpStudioDevTarget,
        changeOrigin: true,
      },
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  optimizeDeps: {
    include: [
      '@toast-ui/editor',
      '@toast-ui/editor-plugin-color-syntax',
    ],
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          'toast-editor': ['@toast-ui/editor', '@toast-ui/editor-plugin-color-syntax'],
        },
      },
    },
  },
})
