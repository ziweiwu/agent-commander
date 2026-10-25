import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { brotliCompressSync, constants as zlib, gzipSync } from 'node:zlib'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** The bundle files the server may hand out compressed: compiled scripts and stylesheets. */
const COMPRESSIBLE = /^assets\/[^/]+\.(?:js|css)$/

/** Brotli at its slowest and smallest, which a build can afford and a request could not. */
const BROTLI_BEST = {
  params: {
    [zlib.BROTLI_PARAM_QUALITY]: zlib.BROTLI_MAX_QUALITY,
    [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT,
  },
}

/** Write `compressed` to `path` only when it would actually save bytes. */
function writeIfSmaller(path: string, raw: Buffer, compressed: Buffer): void {
  if (compressed.length < raw.length) writeFileSync(path, compressed)
}

/** Write the brotli and gzip copies of one emitted file beside it. */
function compressBeside(path: string): void {
  const raw = readFileSync(path)
  writeIfSmaller(`${path}.br`, raw, brotliCompressSync(raw, BROTLI_BEST))
  writeIfSmaller(`${path}.gz`, raw, gzipSync(raw, { level: zlib.Z_BEST_COMPRESSION }))
}

/**
 * Write a brotli and a gzip copy beside every script and stylesheet the build emits.
 *
 * The bundle is ~860KB of text, and over Tailscale on a phone a push tap is
 * usually a cold start, because iOS evicts the page. Compressing here rather
 * than per request costs the server nothing and needs no compression crate:
 * `serve_asset` in `rust/src/routes.rs` hands `ServeDir` the request and it
 * serves whichever copy the `Accept-Encoding` allows, from disk.
 *
 * Only this build's own output is compressed, and Vite names every file of it
 * after its content, so a compressed copy can never outlive the bytes it was
 * made from. The manifest and the icons are copied from `public/`, are not in
 * the bundle this hook is handed, and are never given a copy.
 */
function precompress(): Plugin {
  return {
    name: 'precompress',
    apply: 'build',
    writeBundle(output, bundle) {
      const dir = output.dir
      if (dir === undefined) throw new Error('precompress: the build names no output dir')
      const emitted = Object.keys(bundle).filter((name) => COMPRESSIBLE.test(name))
      emitted.forEach((name) => compressBeside(join(dir, name)))
    },
  }
}

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
  plugins: [react(), nonBlockingCss(), precompress()],
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
