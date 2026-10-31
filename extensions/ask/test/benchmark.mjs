// Warm component CPU benchmark, not an end-to-end terminal or model latency measurement.
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../node_modules/@earendil-works/', import.meta.url);
const imp = (suffix) => import(new URL(suffix, root).href);
const { loadExtensions } = await imp('pi-coding-agent/dist/core/extensions/loader.js');
const { getThemeByName } = await imp('pi-coding-agent/dist/modes/interactive/theme/theme.js');
const { KeybindingsManager } = await imp('pi-coding-agent/dist/core/keybindings.js');
const { TuiMainScreen, setKeybindings } = await imp('pi-tui/dist/index.js');
const theme = getThemeByName('dark');
const kb = new KeybindingsManager();
setKeybindings(kb);
const path = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../index.ts', import.meta.url));
const loaded = await loadExtensions([path], fileURLToPath(new URL('../', import.meta.url)));
if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
const tool = loaded.extensions[0].tools.get('ask_user').definition;
const iterations = 100;
const options = [{ value: 'a', label: 'Alpha' }, { value: 'b', label: 'Beta' }, { value: 'c', label: 'Gamma' }];
const question = (id, preview) => ({
  id, label: `Q${id}`, prompt: 'Choose a target', kind: 'single',
  options: options.map((option, i) => ({ ...option, description: 'A short explanation', preview: i === 0 ? preview : undefined })),
});
const scenarios = {
  ordinary: [question('1'), question('2'), question('3')],
  snippet: [question('1', '```ts\n' + 'const config = { enabled: true };\n'.repeat(12) + '```')],
  '1000-line preview': [question('1', Array.from({ length: 1000 }, (_, i) => `config.item${i} = "value${i}"`).join('\n'))],
  '40000-CJK preview': [question('1', '字'.repeat(40000))],
};
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p) => Number(sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)].toFixed(4));
  return { p50: percentile(0.5), p95: percentile(0.95) };
};
const results = {};
for (const [name, questions] of Object.entries(scenarios)) {
  const samples = { execute: [], firstRender: [], cachedRender: [], invalidatedRender: [], noOpUpRender: [] };
  for (let i = -3; i < iterations; i++) {
    const tui = new TuiMainScreen({ columns: 100, rows: 30, write() {} }, false);
    tui.requestRender = () => {};
    let component;
    const measure = (key, fn) => {
      const start = performance.now();
      const result = fn();
      if (i >= 0) samples[key].push(performance.now() - start);
      return result;
    };
    const promise = measure('execute', () => tool.execute(`benchmark-${i}`, { questions }, undefined, undefined, {
      mode: 'tui', hasUI: true, ui: { custom(factory) {
        return new Promise((done) => {
          component = factory(tui, theme, kb, done);
          tui.setFocus(component);
        });
      } },
    }));
    if (questions[0].options[0].preview) {
      // Expand before timing. Boundary Up also supports comparisons with older
      // versions where expansion temporarily moved choice focus.
      component.handleInput('\x0f');
      for (let j = 0; j < 12; j++) component.handleInput('\x1b[A');
    }
    measure('firstRender', () => component.render(100));
    measure('cachedRender', () => component.render(100));
    component.invalidate();
    measure('invalidatedRender', () => component.render(100));
    component.handleInput('\x1b[A');
    measure('noOpUpRender', () => component.render(100));
    component.handleInput('\x1b');
    await promise;
  }
  results[name] = Object.fromEntries(Object.entries(samples).map(([name, values]) => [name, summary(values)]));
}
console.log(JSON.stringify({
  extension: path, node: process.version, iterations, unit: 'milliseconds',
  scope: 'Warm component CPU only, 100x30 fake terminal. Previews explicitly expanded before timing; ordinary descriptions stay visible without a preview. Excludes startup, expansion input handling, model/network, host scheduling, and actual terminal painting.',
  results,
}, null, 2));
