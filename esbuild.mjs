import * as esbuild from 'esbuild';
import { argv } from 'process';

const watch = argv.includes('--watch');

const sharedOptions = {
  bundle: true,
  minify: false,
  sourcemap: true,
  logLevel: 'info',
};

// Extension host bundle (Node.js / CommonJS)
const extensionBuild = esbuild.context({
  ...sharedOptions,
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['vscode', 'duckdb', 'nock', 'mock-aws-s3', 'aws-sdk'],
});

// Webview bundle (browser ESM → IIFE)
const webviewBuild = esbuild.context({
  ...sharedOptions,
  entryPoints: ['src/webview/main.tsx'],
  outfile: 'dist/webview.js',
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  define: {
    'process.env.NODE_ENV': '"production"',
  },
});

const [ext, web] = await Promise.all([extensionBuild, webviewBuild]);

if (watch) {
  await Promise.all([ext.watch(), web.watch()]);
  console.log('Watching for changes…');
} else {
  await Promise.all([ext.rebuild(), web.rebuild()]);
  await Promise.all([ext.dispose(), web.dispose()]);
}
