// Bundles the phone editor (CodeMirror 6 + live preview) into media/editor.js.
import { build } from 'esbuild';

await build({
  entryPoints: ['web/editor.mjs'],
  bundle: true,
  minify: true,
  format: 'iife',
  globalName: 'PocketEditor',
  outfile: 'media/editor.js',
  target: 'es2020',
  legalComments: 'eof',
  logLevel: 'info',
});
