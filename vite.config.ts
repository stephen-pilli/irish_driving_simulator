import { defineConfig } from 'vite'

export default defineConfig({
  // Relative asset URLs, so a build runs from any path - opened as a file,
  // served from a subdirectory, or published as a standalone page - and not
  // only from the root of a domain.
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', sourcemap: true },
})
