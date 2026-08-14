import { defineConfig } from 'vite'

export default defineConfig({
  base: '/work_school/',
  build: {
    target: 'es2022',
    sourcemap: true,
  },
})
