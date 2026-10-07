import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire('/Users/eden/.workbuddy/binaries/node/workspace/');
const { Resvg } = require('@resvg/resvg-js');

const here = pathToFileURL(process.cwd() + '/');
const svg = readFileSync(new URL('./omnisense-logo.svg', here), 'utf8');
const outDir = new URL('../assets/icons/', here);

const master = new Resvg(svg, { fitTo: { mode: 'width', value: 512 } }).render();
writeFileSync(new URL('../brand/omnisense-logo-512.png', here), master.asPng());

for (const size of [128, 48, 16]) {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
  writeFileSync(new URL(`icon-${size}.png`, outDir), r.asPng());
  console.log('wrote icon-' + size + '.png');
}
console.log('done');
