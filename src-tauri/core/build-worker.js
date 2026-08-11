// build-worker.js
// ESBuild를 사용하여 kordoc_worker.cjs와 그 모든 node_modules 의존성을 단일 번들 파일로 압축합니다.
const esbuild = require('esbuild');
const fs = require('fs');

const fixCreateRequirePlugin = {
  name: 'fix-create-require',
  setup(build) {
    build.onLoad({ filter: /kordoc[\/\\]dist[\/\\]index\.cjs$/ }, async (args) => {
      let contents = await fs.promises.readFile(args.path, 'utf8');
      contents = contents.replace(/require\d+\(["']cfb["']\)/g, 'require("cfb")');
      return { contents, loader: 'js' };
    });
  },
};

esbuild.build({
  entryPoints: ['kordoc_worker.cjs'],
  bundle: true,
  outfile: 'worker_bundle.cjs',
  platform: 'node',
  target: 'node18',
  minify: false,
  loader: {
    '.node': 'file',
  },
  plugins: [fixCreateRequirePlugin],
  external: [
    'puppeteer-core',
    'onnxruntime-node',
    'sharp',
    'canvas',
    '@huggingface/transformers',
  ],
}).then(() => {
  console.log('✅ [ESBuild] worker_bundle.cjs 번들링 완료!');
}).catch((err) => {
  console.error('❌ [ESBuild] 번들링 실패:', err);
  process.exit(1);
});
