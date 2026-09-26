import { defineConfig } from 'vite'
import path from 'path'
import { fileURLToPath } from 'url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'

// ESM-safe __dirname (not available natively in "type":"module" projects)
const __dirname = path.dirname(fileURLToPath(import.meta.url))


function figmaAssetResolver() {
  return {
    name: 'figma-asset-resolver',
    resolveId(id: string) {
      if (id.startsWith('figma:asset/')) {
        const filename = id.replace('figma:asset/', '')
        return path.resolve(__dirname, 'src/assets', filename)
      }
    },
  }
}

export default defineConfig({
  server: {
    proxy: {
      '/api/anthropic': {
        target: 'https://api.anthropic.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/anthropic/, ''),
      },
      '/api/gemini': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/gemini/, ''),
      },
      '/api/groq': {
        target: 'https://api.groq.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/groq/, ''),
      },
      '/api/gcloud': {
        target: 'https://generativelanguage.googleapis.com',
        changeOrigin: true,
        rewrite: (path: string) => path.replace(/^\/api\/gcloud/, ''),
      },
      '/api/mcp': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  plugins: [
    figmaAssetResolver(),
    // The React and Tailwind plugins are both required for Make, even if
    // Tailwind is not being actively used – do not remove them
    react(),
    tailwindcss(),
  ],
  resolve: {
    alias: {
      // Alias @ to the src directory
      '@': path.resolve(__dirname, './src'),
    },
  },

  // File types to support raw imports. Never add .css, .tsx, or .ts files to this.
  assetsInclude: ['**/*.svg', '**/*.csv'],

  build: {
    // The one large chunk is the healing engine (~1,000 rules), loaded only when a heal starts.
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      output: {
        // Stable vendor code in its own long-cached chunks; the healing engine and
        // secondary views are already split via dynamic import() / React.lazy.
        manualChunks: {
          react: ['react', 'react-dom'],
          motion: ['motion'],
          icons: ['lucide-react'],
        },
      },
    },
  },
})
