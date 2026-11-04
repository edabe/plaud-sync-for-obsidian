import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/plaud-content-hydrator.ts')).href;
const {hydratePlaudDetailContent} = await import(moduleUrl);

test('hydrates summary and transcript from content_list signed links', async () => {
  const calls = [];
  const detail = {
    file_id: 'f_1',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://example.test/sum'},
      {data_type: 'transaction', data_link: 'https://example.test/trans'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
    calls.push(url);
    if (url.endsWith('/sum')) {
      return {ai_content: 'Summary from signed content'};
    }
    return [
      {speaker: 'Speaker 1', content: 'Hello world'}
    ];
  });

  assert.deepEqual(calls, ['https://example.test/sum', 'https://example.test/trans']);
  assert.equal(hydrated.summary, 'Summary from signed content');
  assert.ok(Array.isArray(hydrated.transcript));
  assert.equal(hydrated.transcript.length, 1);
});

test('does not fetch summary link when summary already exists', async () => {
  const calls = [];
  const detail = {
    file_id: 'f_2',
    summary: 'Already present',
    content_list: [
      {data_type: 'auto_sum_note', data_link: 'https://example.test/sum'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async (url) => {
    calls.push(url);
    return {ai_content: 'Should not be used'};
  });

  assert.deepEqual(calls, []);
  assert.equal(hydrated.summary, 'Already present');
});

test('parses transcript payload when content URL returns JSON string', async () => {
  const detail = {
    file_id: 'f_3',
    content_list: [
      {data_type: 'transaction', data_link: 'https://example.test/trans'}
    ]
  };

  const hydrated = await hydratePlaudDetailContent(detail, async () => {
    return JSON.stringify([{speaker: 'S', content: 'Line'}]);
  });

  assert.ok(Array.isArray(hydrated.transcript));
  assert.equal(hydrated.transcript[0].content, 'Line');
});

const v4Detail = (dataType) => ({
  file_id: 'f_1',
  content_list: [{data_type: dataType, data_link: 'https://example.test/content'}]
});

test('hydrates a Markdown summary', async () => {
  const hydrated = await hydratePlaudDetailContent(v4Detail('auto_sum_note'), async () => '# Summary\n\nDecisions');

  assert.equal(hydrated.summary, '# Summary\n\nDecisions');
});

for (const key of ['trans_result', 'segments']) {
  test(`hydrates transcript segments wrapped in ${key}`, async () => {
    const segments = [{speaker: 'Speaker 1', content: 'Hello'}];
    const hydrated = await hydratePlaudDetailContent(v4Detail('transaction'), async () => ({[key]: segments}));

    assert.deepEqual(hydrated.transcript, segments);
  });
}

test('a failed content download fails the recording', async () => {
  await assert.rejects(
    () => hydratePlaudDetailContent(v4Detail('transaction'), async () => {
      throw new Error('expired link');
    }),
    /expired link/
  );
});

test('unrecognized transcript content fails the recording', async () => {
  await assert.rejects(
    () => hydratePlaudDetailContent(v4Detail('transaction'), async () => ({unknown: true})),
    /unrecognized format/
  );
});

test('unrecognized summary content fails the recording', async () => {
  await assert.rejects(
    () => hydratePlaudDetailContent(v4Detail('auto_sum_note'), async () => ({unknown: true})),
    /unrecognized format/
  );
});

for (const [label, content] of [['empty array', []], ['empty text', ''], ['empty segments', {segments: []}]]) {
  test(`an empty transcript (${label}) does not fail the recording`, async () => {
    const hydrated = await hydratePlaudDetailContent(v4Detail('transaction'), async () => content);

    assert.equal(hydrated.file_id, 'f_1');
  });
}
