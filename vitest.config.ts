import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

/**
 * Two projects, because the suites have genuinely different needs: pure logic
 * and server code run in node with no setup, and only the component tests pay
 * for jsdom and React Testing Library.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['test/**/*.test.ts'],
          exclude: ['test/ui/**'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        test: {
          name: 'ui',
          include: ['test/ui/**/*.test.tsx'],
          environment: 'jsdom',
          setupFiles: ['test/ui/setup.ts'],
        },
      },
    ],
  },
})
