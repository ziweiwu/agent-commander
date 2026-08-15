import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Stop the app's stylesheet from blocking the first paint.
 *
 * `index.html` paints a placeholder before the JS shell arrives, because over
 * Tailscale on a phone the shell is seconds away and a blank page reads as a
 * broken app. That placeholder did nothing at first: a render-blocking
 * `<link rel="stylesheet">` in the same head meant Chrome painted nothing at
 * all until the CSS resolved, measured at 5.6s to first paint on Slow 3G with
 * a 4x CPU slowdown.
 *
 * Loading it as a preload that promotes itself to a stylesheet on arrival
 * un-blocks the placeholder. There is no flash of unstyled app behind it: the
 * app only draws once its 350KB of JavaScript has parsed, by which point the
 * 36KB of CSS has long since landed. The `<noscript>` copy keeps the plain
 * stylesheet for anything that does not run the onload.
 */
function nonBlockingCss(): Plugin {
  return {
    name: 'non-blocking-css',
    apply: 'build',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link rel="stylesheet"([^>]*?)href="([^"]+)"([^>]*)>/g,
        (match, before: string, href: string, after: string) =>
          `<link rel="preload" as="style"${before}href="${href}"${after} ` +
          `onload="this.onload=null;this.rel='stylesheet'">` +
          `<noscript>${match}</noscript>`,
      )
    },
  }
}

export default defineConfig({
  root: 'src/web',
  plugins: [react(), nonBlockingCss()],
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    target: 'es2022',
  },
  css: {
    modules: {
      // Readable in devtools; the hash still guarantees uniqueness.
      generateScopedName: '[name]__[local]___[hash:base64:5]',
    },
  },
})
