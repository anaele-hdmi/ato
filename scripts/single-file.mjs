// Builds one self-contained HTML page (all JS/CSS inlined) for hosts that take a single file.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const dir = 'dist/assets';
const files = readdirSync(dir);
const js = readFileSync(`${dir}/${files.find((f) => f.endsWith('.js'))}`, 'utf8').replace(/<\/script/gi, '<\\/script');
const css = readFileSync(`${dir}/${files.find((f) => f.endsWith('.css'))}`, 'utf8');
const html = `<title>跡</title>
<style>${css}</style>
<div id="stage"><canvas id="view"></canvas><div id="veil"></div></div>
<script type="module">${js}</script>
`;
writeFileSync(process.argv[2] ?? 'dist/ato-single.html', html);
console.log('wrote', html.length, 'bytes');
