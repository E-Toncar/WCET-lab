// Builds the standalone pages.
//   dist/      -> complete HTML files for GitHub Pages (or any static host)
//   artifact/  -> same pages; index.html without a document skeleton (the artifact host adds one)
const fs = require('fs');
const path = require('path');
const src = (f) => fs.readFileSync(path.join(__dirname, 'src', f), 'utf8');
const css = src('common.css');

function fill(t) {
  return t
    .replace('/*CSS*/', () => css)
    .replace('/*EXAMPLES*/', () => src('tcrest-examples.js'))
    .replace('/*CORE*/', () => '');
}
function page(name, core) {
  let t = src(name);
  t = fill(t).replace('<script>\n\n</script>', () => '<script>\n' + core + '\n</script>');
  return t;
}
function skeleton(body) {
  return '<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n' +
    '<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0}[hidden]{display:none!important}img{max-width:100%}</style>\n' +
    '</head>\n<body>\n' + body + '\n</body>\n</html>\n';
}
const pages = {
  'index.html': fill(src('index.html')),
  'sweet.html': page('sweet.html', src('sweet-core.js')),
  'tcrest.html': page('tcrest.html', src('tcrest-core.js')),
};
for (const d of ['dist', 'artifact']) fs.mkdirSync(path.join(__dirname, d), { recursive: true });
for (const [n, body] of Object.entries(pages)) {
  if (body.includes('/*CORE*/') || body.includes('/*CSS*/')) throw new Error('placeholder left in ' + n);
  fs.writeFileSync(path.join(__dirname, 'dist', n), skeleton(body));
  fs.writeFileSync(path.join(__dirname, 'artifact', n), n === 'index.html' ? body : skeleton(body));
}
console.log('built', Object.keys(pages).join(', '));
