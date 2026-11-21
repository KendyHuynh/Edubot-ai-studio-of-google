import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import fs from 'fs';
import path from 'path';
import {defineConfig} from 'vite';

export default defineConfig(({command}) => {
  const buildBase = process.env.VITE_BASE_PATH || './';
  return {
    base: command === 'build' ? buildBase : '/',
    build: {
      outDir: 'docs',
      emptyOutDir: true,
    },
    plugins: [
      react(),
      tailwindcss(),
      // Prepares GitHub Pages SPA fallback (404.html + .nojekyll) in docs/ and mirrors to dist/ for Express production mode.
      {
        name: 'github-pages-docs-build',
        apply: 'build',
        closeBundle(error?: Error): void {
          if (error) {
            return;
          }
          const docsDir = path.resolve(__dirname, 'docs');
          const distDir = path.resolve(__dirname, 'dist');
          const srcAssets = path.resolve(__dirname, 'src/assets');

          // Remove AI Studio chat-uploaded preview images from the published static docs/ folder
          const chatUploadsDir = path.join(docsDir, 'assets', 'aistudio');
          if (fs.existsSync(chatUploadsDir)) {
            fs.rmSync(chatUploadsDir, {recursive: true, force: true});
          }

          if (fs.existsSync(docsDir) && fs.existsSync(srcAssets)) {
            fs.cpSync(srcAssets, path.join(docsDir, 'src/assets'), {
              recursive: true,
              force: true,
            });
          }

          const indexHtml = path.join(docsDir, 'index.html');
          if (fs.existsSync(indexHtml)) {
            fs.copyFileSync(indexHtml, path.join(docsDir, '404.html'));
            fs.writeFileSync(path.join(docsDir, '.nojekyll'), '');
          }

          // Keep dist/ mirrored so `NODE_ENV=production npm start` (Express) works seamlessly too
          if (fs.existsSync(docsDir)) {
            fs.rmSync(distDir, {recursive: true, force: true});
            fs.cpSync(docsDir, distDir, {recursive: true, force: true});
          }
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
