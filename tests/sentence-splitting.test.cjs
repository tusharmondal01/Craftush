const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const html = fs.readFileSync(path.join(__dirname, '../public/visuals/index.html'), 'utf8');
const source = html.slice(html.indexOf('/* ---------- STEP 1: split ---------- */'), html.indexOf('/* ---------- STEP 2: prompts ---------- */'));
const longSentence = 'Cicada spends seventeen years underground feeding on the roots of trees and waiting through changing seasons while its body develops slowly in complete darkness until the soil becomes warm enough for the entire generation to emerge together.';
function harness(mode = 'stops', pace = 'scene') {
  const nodes = new Map();
  const $ = selector => {
    if (!nodes.has(selector)) nodes.set(selector, { value: '', hidden: false, disabled: false, handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; }, querySelector() { return {}; } });
    return nodes.get(selector);
  };
  $('#splitMode').value = mode; $('#pace').value = pace;
  $('#minImg').value = '60'; $('#maxImg').value = '70';
  const state = { items: [], cost: { prompts: 0 } };
  const statuses = [];
  const context = vm.createContext({ $, state, console, URL: { revokeObjectURL() {} }, setStatus: (...args) => statuses.push(args), renderAll() {}, showStep() {}, needCode: () => false, tokens: () => [], fmtClock: () => '', uuid: () => 'test' });
  vm.runInContext(source, context);
  return { context, $, state, statuses, split: text => Array.from(context.splitSentences(text)), run: async text => { $('#script').value = text; await $('#splitBtn').handlers.click(); return Array.from(state.items, item => item.text); } };
}
test('sentence boundaries preserve wrapped lines, punctuation and script order', () => {
  const { split } = harness();
  for (const [input, expected] of [
    ['A butterfly rests\non the same leaf\n\nthrough the night. Then it flies.', ['A butterfly rests on the same leaf through the night.', 'Then it flies.']],
    ['Pehla scene khatam.Dusra scene shuru!Teesra scene?', ['Pehla scene khatam.', 'Dusra scene shuru!', 'Teesra scene?']],
    ['यह पूरा वाक्य है।अगला वाक्य यहाँ है॥', ['यह पूरा वाक्य है।', 'अगला वाक्य यहाँ है॥']],
    ['He said “Wait.” Then she asked “Why?”', ['He said “Wait.”', 'Then she asked “Why?”']],
    ['The value is 3.14 rupees. Dr. Rao met A. P. Singh near Mt. Everest. Next came the climb.', ['The value is 3.14 rupees.', 'Dr. Rao met A. P. Singh near Mt. Everest.', 'Next came the climb.']],
    ['Visit https://example.com/help or write to team@example.com. Then continue.', ['Visit https://example.com/help or write to team@example.com.', 'Then continue.']],
    ['One final thought without punctuation', ['One final thought without punctuation']],
    ['', []],
  ]) {
    assert.deepEqual(split(input), expected);
    assert.equal(split(input).join(' ').replace(/\s/g, ''), input.replace(/\s/g, ''));
  }
});
for (const pace of ['scene', 'fast', 'vfast', 'relaxed', 'count']) {
  test(`full-stop mode preserves a long sentence with ${pace} previously selected`, async () => {
    const h = harness('stops', pace);
    const expected = [longSentence, 'Yes!', 'Then it appears above ground.'];
    assert.deepEqual(await h.run(expected.join(' ')), expected);
    assert.equal(h.$('#pace').disabled, true);
    assert.equal(h.$('#textModelSel').disabled, false, 'model selection remains available for prompt writing');
    assert.equal(h.$('#countRange').hidden, true);
    assert.equal(h.$('#splitHelp').hidden, false);
    assert.match(h.statuses.at(-1)[1], /3 complete sentences/);
  });
}
test('an AI failure falls back to intact full-stop sentences', async () => {
  const h = harness('smart', 'count');
  h.context.smartSplit = async () => { throw new Error('Service unavailable'); };
  assert.deepEqual(await h.run(longSentence + ' Then it emerges.'), [longSentence, 'Then it emerges.']);
  assert.match(h.statuses.at(-1)[1], /It split at full stops instead/);
});
test('switching back to smart restores cut speed and image-count controls', async () => {
  const h = harness('stops', 'count');
  h.$('#splitMode').value = 'smart'; h.$('#splitMode').handlers.change();
  assert.equal(h.$('#pace').disabled, false);
  assert.equal(h.$('#textModelSel').disabled, false);
  assert.equal(h.$('#countRange').hidden, false);
  h.$('#minImg').value = '4'; h.$('#maxImg').value = '4';
  h.context.smartSplit = async () => [longSentence];
  assert.equal((await h.run(longSentence)).length, 4);
});
test('all inline page scripts parse', () => {
  for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) new vm.Script(match[1]);
});
