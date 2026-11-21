import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(({command}) => {
  const buildBase = process.env.VITE_BASE_PATH || './';
  return {
    base: command === 'build' ? buildBase : '/',
    plugins: [
      react(),
      tailwindcss(),
      // Copies src/assets into dist/ and prepares GitHub Pages SPA fallback (404.html + .nojekyll).
      {
        name: 'copy-unbundled-src-assets',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');
          const distAssets = path.resolve(distDir, 'src/assets');
          if (fs.existsSync(distDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, distAssets, {recursive: true, force: true});
          }
          const indexHtml = path.join(distDir, 'index.html');
          if (fs.existsSync(indexHtml)) {
            fs.copyFileSync(indexHtml, path.join(distDir, '404.html'));
            fs.writeFileSync(path.join(distDir, '.nojekyll'), '');
          }
          // Mirror static output into /docs so GitHub Pages can deploy from `main /docs`
          // without needing `.github/workflows` permissions during AI Studio GitHub push.
          const docsDir = path.resolve(__dirname, 'docs');
          fs.rmSync(docsDir, {recursive: true, force: true});
          fs.cpSync(distDir, docsDir, {
            recursive: true,
            force: true,
            filter: (src) => !src.includes(`${path.sep}assets${path.sep}aistudio`),
          });
        },
      },
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modify—file watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
      // Disable file watching when DISABLE_HMR is true to save CPU during agent edits.
      watch: process.env.DISABLE_HMR === 'true' ? null : {},
    },
  };
});
