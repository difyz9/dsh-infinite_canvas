#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const start = source.indexOf('    function kieBase(');
const end = source.indexOf('    /** 已知网关', start);
assert.ok(start > 0 && end > start, 'KIE adapter source boundaries');
const adapter = source.slice(start, end);
function functionSource(name) {
  const start = source.search(new RegExp('    (?:async )?function ' + name + '\\('));
  const end = source.indexOf('\n    }\n', start);
  assert.ok(start >= 0 && end > start, name + ' function boundaries');
  return source.slice(start, end + '\n    }'.length);
}
const imageInput = {
  type: 'object', required: ['prompt'], additionalProperties: false,
  properties: {
    prompt: { type: 'string', minLength: 1 },
    aspect_ratio: { type: 'string', enum: ['auto', '16:9', '1:1'], default: 'auto' },
    resolution: { type: 'string', enum: ['1K', '2K'], default: '1K' },
  },
};
const videoInput = {
  oneOf: [
    { type: 'object', required: ['prompt', 'image_url', 'duration'], additionalProperties: false, properties: {
      prompt: { type: 'string' }, image_url: { type: 'string' },
      duration: { type: 'string', enum: ['5', '10'] },
    } },
    { type: 'object', required: ['task_id'], additionalProperties: false, properties: { task_id: { type: 'string' } } },
  ],
};
function documentFor(input, model) {
  return {
    paths: { '/api/v1/jobs/createTask': { post: { requestBody: { $ref: '#/components/requestBodies/Task%20' } } } },
    components: {
      requestBodies: { 'Task ': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Request' } } } } },
      schemas: {
        Request: { type: 'object', required: ['model', 'input'], additionalProperties: false, properties: {
          model: { type: 'string', const: model }, input: { $ref: '#/components/schemas/Input' }, callBackUrl: { type: 'string' },
        } },
        Input: input,
      },
    },
  };
}
function harness({ kind = 'image', input, handler, downloadFails = false } = {}) {
  const model = kind === 'image' ? 'fixture-image' : 'fixture/video';
  const doc = documentFor(input || (kind === 'image' ? imageInput : videoInput), model);
  const calls = [];
  const downloads = [];
  const logs = [];
  const hookState = [];
  let hookIndex = 0;
  let time = 100000;
  let aborted = false;
  const config = { apiKey: 'fixture-key', model, ...(kind === 'image' ? { baseUrl: 'https://api.kie.ai/api/v1/jobs/createTask' } : { url: 'https://api.kie.ai', vendor: 'kie' }) };
  const response = (data) => ({ ok: true, status: 200, text: JSON.stringify({ code: 200, data }) });
  const context = vm.createContext({
    Blob, FormData, Response, structuredClone, URL, console: { info: (message) => logs.push(message) },
    h: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const index = hookIndex++;
      if (!(index in hookState)) hookState[index] = initial;
      return [hookState[index], (value) => { hookState[index] = value; }];
    },
    useEffect: () => {},
    Date: { now: () => time },
    sleep: async (ms) => { time += ms; },
    genAborted: () => aborted,
    T: (key) => key,
    vendorBase: (raw) => String(raw).replace(/\/+$/, '').replace(/\/(api\/)?v1$/i, ''),
    parseExtraParams: (raw) => {
      if (!String(raw || '').trim()) return null;
      const value = JSON.parse(raw);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('extra must be an object');
      return value;
    },
    arrayBufferToBase64: (buf) => Buffer.from(buf).toString('base64'),
    retryableDownloadError: (e) => !e.status || e.status === 403 || e.status >= 500,
    downloadVideo: async (url, headers) => {
      downloads.push({ url, headers });
      if (downloadFails && downloads.length === 1) { const e = new Error('CDN unavailable'); e.status = 403; throw e; }
      return new Blob(['media'], { type: kind === 'image' ? 'image/png' : 'video/mp4' });
    },
    fetchViaProxy: async (url, options) => {
      calls.push({ url, ...options, at: time });
      const override = handler && handler(url, options, calls);
      if (override) return override;
      if (url.includes('/models?')) return response({ models: [{ model, taskType: [kind === 'image' ? 'Text to Image' : 'Image to Video'] }] });
      if (url.endsWith('/schema')) return response({ model, openapi: doc });
      if (url.endsWith('/credit')) return response(100);
      if (url.endsWith('/createTask')) return response({ taskId: 'task-123', recordId: 'not-the-task-id' });
      if (url.includes('/recordInfo?')) return response({ state: 'success', response: { resultUrls: ['https://tempfile.redpandaai.co/output.png'] } });
      if (url.endsWith('/file-stream-upload')) return { ok: true, status: 200, text: JSON.stringify({ code: 200, success: true, data: { downloadUrl: 'https://tempfile.redpandaai.co/frame.png' } }) };
      if (url.endsWith('/download-url')) return response('https://tempfile.redpandaai.co/direct.png');
      throw new Error('Unexpected request: ' + url);
    },
  });
  const runners = source.slice(source.indexOf('    const VIDEO_VENDOR_RUNNERS = {'), source.indexOf('    async function apiVideo('));
  vm.runInContext(adapter + runners + ['apiImage', 'apiVideo', 'detectVideoVendor', 'flattenImageModels', 'flattenVideoModels', 'resolveImageModelCfg', 'resolveVideoModelCfg', 'KieModelPicker'].map(functionSource).join('\n') + '\nglobalThis.kie = { kieBase, mergeKieExtra, kieRequest, kieDiscover, kieCatalog, kieSchema, kieValidate, kieInput, kieUploadImage, kieResult, kieMediaTask, apiImage, apiVideo, detectVideoVendor, resolveImageModelCfg, resolveVideoModelCfg, KieModelPicker };', context);
  return {
    api: context.kie, config, doc, calls, downloads, logs, abort: () => { aborted = true; }, response,
    renderPicker: (onPick) => { hookIndex = 0; return context.kie.KieModelPicker({ provider: config, kind, onPick }); },
  };
}
const json = (v) => JSON.parse(JSON.stringify(v));
function elements(tree) {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== 'object') return [];
  return [tree, ...elements(tree.children)];
}

{
  const h = harness();
  let saved;
  const result = await h.api.kieMediaTask('City at night', [], h.config, { ratio: '16:9', size: '2K', onTask: (...args) => { saved = args; } }, 'image');
  assert.equal(result.type, 'image/png');
  const submit = h.calls.find((c) => c.url.endsWith('/createTask'));
  assert.equal(submit.url, 'https://api.kie.ai/api/v1/jobs/createTask');
  assert.deepEqual(json(submit.body), { model: 'fixture-image', input: { prompt: 'City at night', aspect_ratio: '16:9', resolution: '2K' } });
  assert.equal(submit.headers.Authorization, 'Bearer fixture-key');
  assert.equal(submit.body.callBackUrl, undefined);
  assert.deepEqual(saved, ['task-123', 'https://api.kie.ai/api/v1/jobs/recordInfo?taskId=task-123']);
  assert.deepEqual(json(h.downloads[0].headers), {}, 'never leak API credentials to media CDN');
  const discovery = h.calls.filter((c) => c.url.includes('/models'));
  assert.ok(discovery[1].at - discovery[0].at >= 1100, 'discovery rate limit');
  assert.ok(h.calls.some((c) => c.url.endsWith('/credit')));
}
console.log('PASS image task: catalog/schema, nested input, controls, auth, task persistence, download');

{
  const h = harness({ kind: 'video' });
  const frame = new Blob(['image bytes'], { type: 'image/png' });
  const result = await h.api.kieMediaTask('Move slowly', [frame], h.config, { duration: 5 }, 'video');
  assert.equal(result.type, 'video/mp4');
  const upload = h.calls.find((c) => c.url.endsWith('/file-stream-upload'));
  assert.equal(upload.url, 'https://kieai.redpandaai.co/api/file-stream-upload');
  assert.match(upload.bodyContentType, /multipart\/form-data; boundary=/);
  const multipart = Buffer.from(upload.bodyRaw, 'base64').toString();
  assert.match(multipart, /name="file"; filename="frame.png"/);
  assert.match(multipart, /images\/dsh-infinite-canvas/);
  assert.match(multipart, /image bytes/);
  assert.ok(h.calls.some((c) => c.url.endsWith('/models/fixture/video/schema')), 'do not encode model slash');
  assert.deepEqual(json(h.calls.find((c) => c.url.endsWith('/createTask')).body.input), { prompt: 'Move slowly', image_url: 'https://tempfile.redpandaai.co/frame.png', duration: '5' });
}
console.log('PASS video task: schema oneOf, typed duration, multipart upload, unencoded model ID');

{
  const h = harness();
  const input = h.api.kieInput(h.doc, imageInput, 'test', [], {}, { aspect_ratio: '1:1' });
  assert.equal(input.aspect_ratio, '1:1');
  assert.equal(input.resolution, '1K');
  assert.throws(() => h.api.kieInput(h.doc, imageInput, 'test', [], { ratio: '9:16' }, {}), /aspect_ratio.*one of/);
  assert.throws(() => h.api.kieInput(h.doc, imageInput, '', [], {}, {}), /required input.prompt/);
  assert.throws(() => h.api.kieValidate(h.doc, imageInput.properties.prompt, ''), /length/);
  assert.throws(() => h.api.kieInput(h.doc, imageInput, 'test', ['https://example.com/image.png'], {}, {}), /no supported image/);
  assert.throws(() => h.api.kieInput(h.doc, videoInput, 'test', ['https://example.com/image.png'], {}, {}), /required input.duration/);
  assert.throws(() => h.api.kieInput(h.doc, videoInput, 'test', ['a', 'b'], { duration: 5 }, {}), /one image only/);
  assert.throws(() => h.api.kieInput(h.doc, videoInput, 'test', ['a'], { duration: 5 }, { image_url: 'b' }), /conflicts/);
  const arrays = { allOf: [{ type: 'object', required: ['prompt'], properties: { prompt: { type: 'string' } } }, { required: ['image_urls'], properties: { image_urls: { type: 'array', maxItems: 2, items: { type: 'string' } } } }] };
  assert.deepEqual(json(h.api.kieInput(h.doc, arrays, 'test', ['a', 'b'], {}, {})), { prompt: 'test', image_urls: ['a', 'b'] });
  assert.throws(() => h.api.kieInput(h.doc, arrays, 'test', ['a', 'b', 'c'], {}, {}), /item count/);
  const escaped = { components: { schemas: { 'a/b~c ': { type: 'number' } } } };
  assert.equal(h.api.kieSchema(escaped, { $ref: '#/components/schemas/a~1b~0c%20' }).type, 'number');
  assert.throws(() => h.api.kieSchema({}, { $ref: '#/missing' }), /unresolved/);
  assert.deepEqual(json(h.api.mergeKieExtra({ input: { duration: '5', resolution: '720p' } }, { input: { duration: '10' } })), { input: { duration: '10', resolution: '720p' } });
  assert.throws(() => h.api.mergeKieExtra({ input: 'invalid' }, {}), /input must be an object/);
}
console.log('PASS schema validation: defaults, explicit overrides, required, enums, allOf, arrays, refs');

for (const fixture of [
  { name: 'business error', handler: () => ({ ok: true, status: 200, text: '{"code":401,"msg":"Unauthorized"}' }), pattern: /401.*Unauthorized/ },
  { name: 'HTTP error', handler: () => ({ ok: false, status: 503, text: 'Unavailable' }), pattern: /HTTP 503/ },
  { name: 'malformed JSON', handler: () => ({ ok: true, status: 200, text: 'not json' }), pattern: /invalid JSON/ },
  { name: 'null schema', handler: (url) => url.endsWith('/schema') && ({ ok: true, status: 200, text: '{"code":200,"data":{"openapi":null}}' }), pattern: /schema unavailable/ },
  { name: 'wrong endpoint', handler: (url) => url.endsWith('/schema') && ({ ok: true, status: 200, text: '{"code":200,"data":{"openapi":{"paths":{"/other":{}}}}}' }), pattern: /not a createTask/ },
  { name: 'empty catalog', handler: (url) => url.includes('/models?') && ({ ok: true, status: 200, text: '{"code":200,"data":{"models":[]}}' }), pattern: /not in the current/ },
  { name: 'zero balance', handler: (url) => url.endsWith('/credit') && ({ ok: true, status: 200, text: '{"code":200,"data":0}' }), pattern: /insufficient credits/ },
]) {
  const h = harness(fixture);
  await assert.rejects(h.api.kieMediaTask('test', [], h.config, {}, 'image'), fixture.pattern, fixture.name);
  assert.ok(!h.calls.some((c) => c.url.endsWith('/createTask')), fixture.name + ': no paid task');
}
{
  const h = harness();
  await assert.rejects(h.api.kieMediaTask('test', [], { ...h.config, apiKey: '' }, {}, 'image'), /API Key/);
  await assert.rejects(h.api.kieMediaTask('test', [], { ...h.config, extra: '{"duration":5}' }, {}, 'image'), /extra parameters/);
  await assert.rejects(h.api.kieMediaTask('test', [], { ...h.config, extra: '{"input":[]}' }, {}, 'image'), /input must be an object/);
  await assert.rejects(h.api.kieUploadImage(h.config, new Blob(['avif'], { type: 'image/avif' })), /PNG, JPEG or WebP/);
  assert.equal(await h.api.kieUploadImage(h.config, 'https://example.com/frame.png'), 'https://example.com/frame.png');
}
console.log('PASS explicit failures before billable submit: HTTP/business errors, schema, balance, extras, upload');

{
  const h = harness();
  for (const state of ['waiting', 'queuing', 'generating', 'future-state']) assert.equal(h.api.kieResult({ state }), '');
  assert.equal(h.api.kieResult({ state: 'success', resultJson: '{"resultUrls":["https://example.com/result.png"]}' }), 'https://example.com/result.png');
  assert.throws(() => h.api.kieResult({ state: 'fail', failCode: '422', failMsg: 'bad input' }), /422.*bad input/);
  assert.throws(() => h.api.kieResult({ state: 'success', resultJson: 'broken' }), /invalid resultJson/);
  assert.throws(() => h.api.kieResult({ state: 'success', response: {} }), /without a result URL/);
  assert.throws(() => h.api.kieResult(null), /invalid task response/);
}
{
  let queries = 0;
  const h = harness({ handler: (url) => {
    if (!url.includes('/recordInfo?')) return;
    queries++;
    if (queries === 1) return { ok: false, status: 503, text: 'retry' };
    if (queries === 2) return { ok: true, status: 200, text: '{"code":200,"data":{"state":"generating"}}' };
  } });
  await h.api.kieMediaTask('test', [], h.config, {}, 'image');
  assert.equal(queries, 3);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/createTask')).length, 1, 'never retry a paid submit');
  assert.equal(h.logs.length, 1, 'query retry is visible');
}
{
  const h = harness({ handler: (url) => url.includes('/recordInfo?') && ({ ok: true, status: 200, text: '{"code":429,"msg":"rate limit"}' }) });
  await assert.rejects(h.api.kieMediaTask('test', [], h.config, {}, 'image'), /task-123.*429/);
  assert.equal(h.calls.filter((c) => c.url.includes('/recordInfo?')).length, 5);
}
{
  const h = harness({ handler: (url) => url.includes('/recordInfo?') && ({ ok: true, status: 200, text: '{"code":401,"msg":"Unauthorized"}' }) });
  await assert.rejects(h.api.kieMediaTask('test', [], h.config, {}, 'image'), /401/);
  assert.equal(h.calls.filter((c) => c.url.includes('/recordInfo?')).length, 1);
}
{
  const h = harness({ handler: (url) => url.includes('/recordInfo?') && ({ ok: true, status: 200, text: '{"code":200,"data":{"state":"waiting"}}' }) });
  await assert.rejects(h.api.kieMediaTask('test', [], h.config, {}, 'image'), /timed out.*task-123/);
}
{
  const h = harness();
  await assert.rejects(h.api.kieMediaTask('test', [], h.config, { onTask: () => h.abort() }, 'image'), /stoppedNote/);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/createTask')).length, 1);
  assert.ok(!h.calls.some((c) => c.url.includes('/recordInfo?')));
}
{
  const h = harness({ downloadFails: true });
  await h.api.kieMediaTask('test', [], h.config, {}, 'image');
  assert.equal(h.downloads.length, 2);
  assert.match(h.downloads[1].url, /direct.png$/);
  assert.ok(h.calls.some((c) => c.url.endsWith('/download-url')));
}
console.log('PASS lifecycle: terminal states, resultJson fallback, bounded polling/retries, cancellation, fresh download URL');
{
  const h = harness({ handler: (url) => url.endsWith('/createTask') && ({ ok: true, status: 200, text: '{"code":402,"msg":"Insufficient credits"}' }) });
  await assert.rejects(h.api.kieMediaTask('test', [], h.config, {}, 'image'), /402.*Insufficient/);
  assert.equal(h.calls.filter((c) => c.url.endsWith('/createTask')).length, 1);
  assert.ok(!h.calls.some((c) => c.url.includes('/recordInfo?')));
}
for (const kind of ['image', 'video']) {
  const h = harness({ kind });
  const picked = [];
  const render = () => h.renderPicker((value) => picked.push(value));
  await elements(render()).find((e) => e.type === 'button').props.onClick();
  const select = elements(render()).find((e) => e.type === 'select');
  assert.ok(select, 'catalog dropdown renders after loading');
  select.props.onChange({ target: { value: h.config.model } });
  assert.deepEqual(picked, [h.config.model]);
  assert.ok(h.calls[0].url.includes(encodeURIComponent(kind === 'image' ? 'Text to Image' : 'Image to Video')));
}
{
  const h = harness();
  h.config.apiKey = '';
  await elements(h.renderPicker()).find((e) => e.type === 'button').props.onClick();
  const error = elements(h.renderPicker()).find((e) => e.props.role === 'alert');
  assert.ok(error);
  assert.match(error.children.join(''), /API Key/);
}
console.log('PASS no paid-submit retry, model picker selection and visible configuration errors');

{
  const h = harness();
  const settings = { imageProviders: [{ id: 'p', mode: 'kie', ...h.config, models: [{ id: 'm', model: h.config.model }] }], imageStar: 'p|m' };
  const config = h.api.resolveImageModelCfg(settings, '');
  assert.equal(config.mode, 'kie');
  await h.api.apiImage('test', [], { ...config, extra: '{"input":{"resolution":"2K"}}' }, { nodeExtra: '{"input":{"aspect_ratio":"1:1"}}' });
  const body = h.calls.find((c) => c.url.endsWith('/createTask')).body;
  assert.equal(body.input.resolution, '2K');
  assert.equal(body.input.aspect_ratio, '1:1');
}
{
  const h = harness({ kind: 'video' });
  const settings = { videoProviders: [{ id: 'p', ...h.config, models: [{ id: 'm', model: h.config.model }] }], videoStar: 'p|m' };
  const config = h.api.resolveVideoModelCfg(settings, '');
  assert.equal(config.vendor, 'kie');
  assert.equal(h.api.detectVideoVendor({ url: 'https://api.kie.ai/api/v1/jobs/createTask' }), 'kie');
  assert.equal(h.api.detectVideoVendor({ url: 'https://api.kie.ai', vendor: 'openai' }), 'openai');
  const frame = new Blob(['frame'], { type: 'image/png' });
  await h.api.apiVideo('test', frame, { ...config, extra: '{"input":{"duration":"10"}}' }, { duration: 5, nodeExtra: '{"input":{"duration":"5"}}' });
  assert.equal(h.calls.find((c) => c.url.endsWith('/createTask')).body.input.duration, '5');
  await assert.rejects(h.api.apiVideo('test', null, config, {}), /requires a first-frame/);
  await assert.rejects(h.api.apiVideo('test', frame, config, { refs: [frame] }), /first-frame image only/);
  await assert.rejects(h.api.apiVideo('test', frame, config, { audioRefs: [frame] }), /first-frame image only/);
  await assert.rejects(h.api.apiVideo('test', frame, config, { frameMode: 'off' }), /requires a first-frame/);
}
console.log('PASS actual image/video routing, flattened settings, nested node overrides and unsupported references');
