// Round 3 verification: manifest + HTML script paths + built ESM import graph.
const fs = require('fs');
const problems = [];

const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
const refs = {
  SW: manifest.background && manifest.background.service_worker,
  side_panel: manifest.side_panel && manifest.side_panel.default_path,
  options: manifest.options_ui && manifest.options_ui.page,
};
for (const [k, p] of Object.entries(refs)) {
  if (!p || !fs.existsSync(p)) problems.push(`manifest ${k} missing: ${p}`);
}
if (!manifest.background || manifest.background.type !== 'module') problems.push('SW not type=module');

for (const html of ['sidepanel.html', 'options.html', 'permission.html']) {
  const c = fs.readFileSync(html, 'utf8');
  const tags = [...c.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  for (const attrs of tags) {
    const m = /src="([^"]+)"/.exec(attrs);
    if (!m) continue; // inline script
    const src = m[1];
    if (src.startsWith('http')) continue;
    if (!fs.existsSync(src)) problems.push(`${html}: missing script ${src}`);
    if (src.startsWith('dist/') && !/type="module"/.test(attrs)) {
      problems.push(`${html}: dist script without type="module": ${src}`);
    }
  }
  const commentScripts = [...c.matchAll(/<!--[\s\S]*?-->/g)].join('');
  void commentScripts;
  console.log(html, '->', tags.filter((a) => /src=/.test(a)).map((a) => /src="([^"]+)"/.exec(a)[1]).join(' | '));
}

// Built ESM entries: every relative import must resolve (stays inside dist/).
const seen = new Set();
function walk(file) {
  if (seen.has(file)) return;
  seen.add(file);
  const src = fs.readFileSync(file, 'utf8');
  for (const m of src.matchAll(/from\s*"(\.[^"]+)"/g)) {
    const target = 'dist/' + m[1].replace(/^\.\//, '');
    if (!fs.existsSync(target)) problems.push(`${file}: unresolved import ${m[1]}`);
    else walk(target);
  }
}
walk('dist/sidepanel.js');
walk('dist/options.js');
console.log('modules reachable from dist entries:', [...seen].sort().join(', '));

// No classic consumer of the global bundle remains in runtime pages.
const consumers = ['sidepanel.js', 'options.js', 'permission.js', 'sidepanel.html', 'options.html', 'permission.html'];
for (const f of consumers) {
  const code = fs.readFileSync(f, 'utf8').split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  if (code.includes('LiveTranslateShared')) problems.push(`${f} still references LiveTranslateShared`);
}

console.log(problems.length ? 'PROBLEMS:\n' + problems.join('\n') : 'ALL-PATHS-OK');
