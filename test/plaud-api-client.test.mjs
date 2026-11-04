import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import process from 'node:process';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';

const root = process.cwd();
const moduleUrl = pathToFileURL(path.join(root, 'src/plaud-api.ts')).href;
const {createPlaudApiClient, PlaudApiError} = await import(moduleUrl);
const obsidianAdapterSource = fs.readFileSync(path.join(root, 'src/plaud-api-obsidian.ts'), 'utf8');

const LEGACY_ID = '0123456789abcdef0123456789abcdef';
const LIST_URL = 'https://api.plaud.ai/file-app/v4/recordings/all?sort_by=created&sort_order=desc&page_size=1000';

function clientReturning(json, token = 'tok_123') {
  const calls = [];
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token,
    request: async (req) => {
      calls.push(req);
      return {status: 200, json};
    }
  });
  return {client, calls};
}

function recording(overrides = {}) {
  return {
    file_id: `of_${LEGACY_ID}`,
    name: 'Standup',
    created_at_show_ms: 1750000000000,
    updated_at_show_ms: 1750000001000,
    version_ms: 1750000002500,
    parent_folder: {folder_id: 'folder_1', name: 'Work', system_folder_type: 0},
    ...overrides
  };
}

async function assertRejectsWith(run, category, message) {
  await assert.rejects(run, (error) => {
    assert.ok(error instanceof PlaudApiError);
    assert.equal(error.category, category);
    if (message) {
      assert.match(error.message, message);
    }
    return true;
  });
}

test('listFiles calls recordings/all with the bearer token', async () => {
  const {client, calls} = clientReturning({status: 0, data: {items: [recording()], next_cursor: ''}});

  await client.listFiles();

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, LIST_URL);
  assert.equal(calls[0].headers.Authorization, 'Bearer tok_123');
});

test('listFiles keeps the legacy id for migrated recordings so existing notes match', async () => {
  const {client} = clientReturning({status: 0, data: {items: [recording()]}});

  const [file] = await client.listFiles();

  assert.equal(file.id, LEGACY_ID);
  assert.equal(file.file_id, LEGACY_ID);
});

test('listFiles keeps new recording ids unchanged', async () => {
  const {client} = clientReturning({status: 0, data: {items: [recording({file_id: 'f_abc123'})]}});

  const [file] = await client.listFiles();

  assert.equal(file.id, 'f_abc123');
});

test('listFiles reports edit_time in seconds from the newest v4 timestamp', async () => {
  const {client} = clientReturning({status: 0, data: {items: [recording()]}});

  const [file] = await client.listFiles();

  assert.equal(file.edit_time, 1750000003);
});

test('listFiles reads the user folder name', async () => {
  const {client} = clientReturning({status: 0, data: {items: [recording()]}});

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, 'Work');
  assert.equal(file.is_trash, false);
});

test('listFiles treats system folders as no folder', async () => {
  const {client} = clientReturning({
    status: 0,
    data: {items: [recording({parent_folder: {folder_id: 'sys', name: 'Recordings', system_folder_type: 1}})]}
  });

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, undefined);
});

function clientWithHiddenContainer(breadcrumbs) {
  const calls = [];
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token: 'tok_123',
    request: async (req) => {
      calls.push(req.url);
      if (req.url.includes('/files/detail/')) {
        return {status: 200, json: {status: 0, data: {node: {breadcrumbs}, meta: {file_id: 'f_abc'}}}};
      }
      return {
        status: 200,
        json: {
          status: 0,
          data: {
            items: [recording({
              file_id: 'f_abc',
              parent_id: 'container',
              parent_folder: {folder_id: 'container', name: 'Standup (1)', system_folder_type: 0}
            })]
          }
        }
      };
    }
  });
  return {client, calls};
}

const containerCrumb = {node_id: 'container', name: 'Standup (1)', system_folder_type: 0};
const fileCrumb = {node_id: 'file', name: 'Standup', system_folder_type: 0};

test('listFiles finds the real folder above a hidden container', async () => {
  const {client, calls} = clientWithHiddenContainer([
    {node_id: 'folder_1', name: 'Work', system_folder_type: 0},
    containerCrumb,
    fileCrumb
  ]);

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, 'Work');
  assert.equal(calls.length, 2);
  assert.equal(calls[1], 'https://api.plaud.ai/file-app/v4/files/detail/f_abc');
});

test('listFiles uses the nearest folder above a hidden container', async () => {
  const {client} = clientWithHiddenContainer([
    {node_id: 'folder_1', name: 'Work', system_folder_type: 0},
    {node_id: 'folder_2', name: 'Team', system_folder_type: 0},
    containerCrumb,
    fileCrumb
  ]);

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, 'Team');
});

test('listFiles treats a hidden container at the top level as no folder', async () => {
  const {client} = clientWithHiddenContainer([containerCrumb, fileCrumb]);

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, undefined);
});

test('listFiles treats a hidden container in a system folder as no folder', async () => {
  const {client} = clientWithHiddenContainer([
    {node_id: 'system', name: 'Recordings', system_folder_type: 1},
    containerCrumb,
    fileCrumb
  ]);

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, undefined);
});

test('listFiles makes no extra request when parent_folder already skips the container', async () => {
  const {client, calls} = clientReturning({
    status: 0,
    data: {items: [recording({parent_id: 'container'})]}
  });

  const [file] = await client.listFiles();

  assert.equal(file.folder_name, 'Work');
  assert.equal(calls.length, 1);
});

test('listFiles follows next_cursor across pages', async () => {
  const pages = [
    {status: 0, data: {items: [recording({file_id: 'f_1'})], next_cursor: 'next/page'}},
    {status: 0, data: {items: [recording({file_id: 'f_2'})], next_cursor: ''}}
  ];
  const urls = [];
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token: 'tok_123',
    request: async (req) => {
      urls.push(req.url);
      return {status: 200, json: pages.shift()};
    }
  });

  const files = await client.listFiles();

  assert.deepEqual(files.map((file) => file.id), ['f_1', 'f_2']);
  assert.equal(urls[0], LIST_URL);
  assert.equal(urls[1], `${LIST_URL}&cursor=next%2Fpage`);
});

test('listFiles refuses a list that never ends', async () => {
  const {client} = clientReturning({status: 0, data: {items: [], next_cursor: 'again'}});

  await assertRejectsWith(() => client.listFiles(), 'invalid_response', /did not end/);
});

test('getFileDetail requests migrated recordings by their v4 id', async () => {
  const {client, calls} = clientReturning({
    status: 0,
    data: {meta: {file_id: `of_${LEGACY_ID}`}, node: {name: 'Standup'}, objects: []}
  });

  await client.getFileDetail(LEGACY_ID);

  assert.equal(calls[0].url, `https://api.plaud.ai/file-app/v4/files/detail/of_${LEGACY_ID}`);
});

test('getFileDetail requests new recordings by their own id', async () => {
  const {client, calls} = clientReturning({status: 0, data: {meta: {file_id: 'f_abc'}, objects: []}});

  await client.getFileDetail('f_abc');

  assert.equal(calls[0].url, 'https://api.plaud.ai/file-app/v4/files/detail/f_abc');
});

test('getFileDetail maps v4 fields to the plugin detail shape', async () => {
  const {client} = clientReturning({
    status: 0,
    data: {
      node: {name: 'Standup'},
      meta: {file_id: `of_${LEGACY_ID}`, start_time: 1750000000000, duration: 60000},
      objects: []
    }
  });

  const detail = await client.getFileDetail(LEGACY_ID);

  assert.equal(detail.id, LEGACY_ID);
  assert.equal(detail.file_id, LEGACY_ID);
  assert.equal(detail.file_name, 'Standup');
  assert.equal(detail.start_time, 1750000000000);
  assert.equal(detail.duration, 60000);
});

test('getFileDetail exposes only finished transcript and summary links', async () => {
  const {client} = clientReturning({
    status: 0,
    data: {
      meta: {file_id: 'f_abc'},
      objects: [
        {object_type: 'AUDIO', content_url: 'https://s3.test/audio', task_status: null},
        {object_type: 'TRANSCRIPT', content_url: 'https://s3.test/trans', task_status: null},
        {object_type: 'SUMMARY', content_url: 'https://s3.test/sum', task_status: 1},
        {object_type: 'SUMMARY', content_url: 'https://s3.test/pending', task_status: 0},
        {object_type: 'TRANSCRIPT', content_url: '', task_status: 1}
      ]
    }
  });

  const detail = await client.getFileDetail('f_abc');

  assert.deepEqual(detail.content_list, [
    {data_type: 'transaction', data_link: 'https://s3.test/trans'},
    {data_type: 'auto_sum_note', data_link: 'https://s3.test/sum'}
  ]);
});

test('getFileDetail rejects a payload without a file id', async () => {
  const {client} = clientReturning({status: 0, data: {meta: {}, objects: []}});

  await assertRejectsWith(() => client.getFileDetail('f_abc'), 'invalid_response', /malformed/);
});

for (const status of [-3900, -420, -419]) {
  test(`maps Plaud status ${status} on HTTP 200 to auth category`, async () => {
    const {client} = clientReturning({status, msg: 'token rejected'});

    await assertRejectsWith(() => client.listFiles(), 'auth', /token rejected/);
  });
}

test('surfaces the account migration message', async () => {
  const {client} = clientReturning({
    status: -1800907,
    msg: 'Account migrated to 4.0. Please update and reinitialize.'
  });

  await assertRejectsWith(() => client.listFiles(), 'invalid_response', /Account migrated to 4\.0/);
});

test('region redirect names the API domain to use', async () => {
  const {client} = clientReturning({status: -302, data: {domains: {api: 'https://api-euc1.plaud.ai'}}});

  await assertRejectsWith(() => client.listFiles(), 'invalid_response', /Set API domain to https:\/\/api-euc1\.plaud\.ai/);
});

test('maps 401 to auth category', async () => {
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token: 'tok_123',
    request: async () => {
      const error = new Error('unauthorized');
      error.status = 401;
      throw error;
    }
  });

  await assertRejectsWith(() => client.listFiles(), 'auth');
});

test('maps 429 to rate_limit category', async () => {
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token: 'tok_123',
    request: async () => {
      const error = new Error('too many requests');
      error.status = 429;
      throw error;
    }
  });

  await assertRejectsWith(() => client.listFiles(), 'rate_limit');
});

test('maps 5xx to server category', async () => {
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token: 'tok_123',
    request: async () => {
      const error = new Error('server fail');
      error.status = 503;
      throw error;
    }
  });

  await assertRejectsWith(() => client.listFiles(), 'server');
});

test('maps invalid response shape to invalid_response category', async () => {
  const {client} = clientReturning({unexpected: true});

  await assertRejectsWith(() => client.listFiles(), 'invalid_response');
});

test('maps network exception to network category', async () => {
  const client = createPlaudApiClient({
    apiDomain: 'https://api.plaud.ai',
    token: 'tok_123',
    request: async () => {
      throw new Error('socket hang up');
    }
  });

  await assertRejectsWith(() => client.listFiles(), 'network');
});

test('obsidian adapter uses requestUrl transport', () => {
  assert.match(obsidianAdapterSource, /requestUrl\(/);
});

test('normalizes configured token that already includes bearer prefix', async () => {
  const {client, calls} = clientReturning({status: 0, data: {items: []}}, 'bearer tok_prefixed');

  await client.listFiles();

  assert.equal(calls[0].headers.Authorization, 'Bearer tok_prefixed');
});
