import { defineConfig, type Plugin } from 'vite';
import solid from 'vite-plugin-solid';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/** KaTeX's stylesheet lists every font as woff2, woff and ttf; webviews (Chromium) only need woff2. */
function katexWoff2Only(): Plugin {
  return {
    name: 'katex-woff2-only',
    enforce: 'pre',
    transform(code, id) {
      if (!/katex[\\/]dist[\\/]katex(\.min)?\.css/.test(id)) return null;
      return code.replace(/,\s*url\([^)]*\.(?:woff|ttf)\)\s*format\("(?:woff|truetype)"\)/g, '');
    },
  };
}

export default defineConfig({
  root,
  // relative URLs: the webview loads dist/webview/* from its own resource root, not from "/"
  base: './',
  plugins: [katexWoff2Only(), solid()],
  resolve: { alias: { '@shared': fileURLToPath(new URL('../shared', import.meta.url)) } },
  server: { port: 5173, host: '127.0.0.1' },
  build: {
    outDir: fileURLToPath(new URL('../dist/webview', import.meta.url)),
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    // small assets inline; fonts stay files (index.css stays small, a font loads only when used)
    assetsInlineLimit: (file: string, content: Buffer) => !/\.(woff2?|ttf|otf|eot)$/i.test(file) && content.length < 100_000,
    rollupOptions: {
      output: {
        entryFileNames: 'index.js',
        chunkFileNames: 'chunk-[name]-[hash].js',
        assetFileNames: (info) => (info.names?.[0]?.endsWith('.css') ? 'index.css' : 'asset-[name]-[hash][extname]'),
      },
    },
  },
});
