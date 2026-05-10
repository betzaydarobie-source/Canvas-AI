import { createServer } from 'node:http';
import { readFile, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Agent, setGlobalDispatcher } from 'undici';

// 关键：Node 原生 fetch（基于 undici）默认对 header/body 有 5 分钟超时，
// gpt-image-2 这类慢模型经常 5-10 分钟才返回，会被 undici 本身掐断（返 "fetch failed"）。
// 把全局 dispatcher 调到 15 分钟，和我们业务层 TIMEOUT_SLOW_MS 保持一致。
setGlobalDispatcher(new Agent({
  headersTimeout: 900_000,   // 等 header 15 分钟
  bodyTimeout:    900_000,   // 等 body 15 分钟
  connectTimeout:  30_000,   // 建连 30 秒够
  keepAliveTimeout: 10_000,
  keepAliveMaxTimeout: 600_000,
}));

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Load .env if present (no dependency required)
const envPath = path.join(__dirname, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const PORT      = process.env.PORT || 3000;
// 环境变量名优先新的，回退到旧的，方便老 .env 文件兼容
const API_KEY   = process.env.API_KEY  || process.env.YUNWU_API_KEY;
const API_BASE  = (process.env.API_BASE || process.env.YUNWU_API_BASE || 'https://www.yccloudapi.online/v1').replace(/\/+$/, '');
const MODEL     = process.env.IMAGE_MODEL || 'dall-e-3';
const SIZE      = process.env.IMAGE_SIZE || '1024x1024';
const TIMEOUT_MS = 300_000;        // 默认 5 分钟上限
const TIMEOUT_SLOW_MS = 900_000;   // 慢模型（gpt-image-2 等）延长到 15 分钟
const MJ_POLL_INTERVAL = 3000;

// 有些模型上游耗时很长（gpt-image-2 在 Azure 上经常 3-10 分钟），
// 超过默认 5 分钟会被 AbortController 中断。这里单独给它们一个长超时。
function isSlowModel(model) {
  return /^gpt-image-2/i.test(model);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function sendJSON(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

// 走 chat-completions 返图的模型（把图片嵌在 markdown 里的那些）
const CHAT_IMAGE_MODELS = new Set([
  'gpt-4o-image-vip',
  'sora_image',
  'gpt-image-1-all',
  'gpt-image-1.5-all',
]);
function isChatImageModel(model) {
  if (CHAT_IMAGE_MODELS.has(model)) return true;
  if (/^gemini-/i.test(model)) return true;  // 所有 Gemini 图像模型都走 chat
  if (/^grok-\d/i.test(model)) return true;  // grok-3/4/4.1/4.2 等走 chat；grok-imagine-* 走 images
  return false;
}

// 走 Midjourney 异步接口的模型
function isMjModel(model) {
  return model === 'mj_imagine';
}

// 支持 /v1/images/edits（multipart 带参考图）的模型：GPT Image 1/1.5/2 系列 + Flux Kontext
// 带参考图调用时要走这个端点，不能走 chat/completions（上游报 unsupported）
function isEditsCapable(model) {
  return /^gpt-image-(1|1-mini|1-all|1\.5|1\.5-all|2|2-all)$/i.test(model)
      || /flux[\.-]?1?[-\.]kontext/i.test(model);
}

async function handleGenerate(req, res) {
  // 注意：这里不能提前判断 !API_KEY —— 前端可能在 body._apiKey 里带自己的 key，
  //       真正的检查在下面读完 body 后做（effectiveKey = overrideKey || API_KEY）
  let prompt, requestedModel, requestedSize, rawRefs, overrideKey;
  try {
    const body = JSON.parse(await readBody(req));
    prompt = (body.prompt || '').toString().trim();
    requestedModel = (body.model || '').toString().trim();
    requestedSize = (body.size || '').toString().trim();
    rawRefs = Array.isArray(body.references) ? body.references : [];
    overrideKey = typeof body._apiKey === 'string' ? body._apiKey.trim() : '';
    // 注意：_apiBase 被刻意忽略，API 地址锁定到 env 里的 API_BASE
  } catch {
    return sendJSON(res, 400, { error: '请求体格式错误' });
  }
  if (!prompt) return sendJSON(res, 400, { error: '缺少 prompt' });
  if (prompt.length > 4000) return sendJSON(res, 400, { error: '描述过长（上限 4000 字）' });

  // 模型校验：只允许简单标识符，避免注入
  const model = requestedModel || MODEL;
  if (!/^[a-zA-Z0-9._:/ _-]{1,100}$/.test(model)) {
    return sendJSON(res, 400, { error: 'model 参数格式无效' });
  }

  // size 校验：格式 <w>x<h>，各 256~8192
  let size = requestedSize || SIZE;
  const sm = size.match(/^(\d{2,5})[xX×](\d{2,5})$/);
  if (!sm) return sendJSON(res, 400, { error: 'size 格式无效（应为 WxH）' });
  const W = +sm[1], H = +sm[2];
  if (W < 64 || W > 8192 || H < 64 || H > 8192) {
    return sendJSON(res, 400, { error: 'size 超出范围（64–8192）' });
  }
  size = `${W}x${H}`;

  // references 校验：必须是 data:image/... 的 data URL
  const references = rawRefs
    .filter(r => typeof r === 'string'
      && /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(r)
      && r.length < 8_000_000)
    .slice(0, 8);

  // API 地址锁死到 env 里的 API_BASE（前端任何 _apiBase 都会被忽略）
  const effectiveKey  = overrideKey || API_KEY;
  const effectiveBase = API_BASE;
  if (!effectiveKey) {
    return sendJSON(res, 500, { error: '服务器未配置 API_KEY（请在设置里填入你的 Key）' });
  }

  const controller = new AbortController();
  // 慢模型（gpt-image-2）用长超时，避免 5 分钟卡 504
  const timeoutMs = isSlowModel(model) ? TIMEOUT_SLOW_MS : TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // 路由优先级（有参考图时）：
  //   1. MJ 异步模型 → /mj/submit/imagine（带 base64Array）
  //   2. GPT Image / Flux Kontext 系列 → /v1/images/edits（multipart）
  //   3. 其他多模态（Gemini、gpt-4o-image 等） → /v1/chat/completions
  //   4. 纯图像模型无参考图 → /v1/images/generations
  const hasRefs = references.length > 0;
  const endpoint = isMjModel(model) ? 'mj'
                 : (hasRefs && isEditsCapable(model)) ? 'edits'
                 : (hasRefs || isChatImageModel(model)) ? 'chat'
                 : 'images';

  try {
    // 日志里脱敏 key，用前缀 + 后缀指代
    const keyTag = overrideKey ? `custom(${overrideKey.slice(0, 4)}…${overrideKey.slice(-3)})` : 'env';
    console.log(`[generate] [${endpoint}] "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"  model=${model}  size=${size}  refs=${references.length}  key=${keyTag}`);
    const opts = { size, base: effectiveBase, key: effectiveKey, signal: controller.signal };
    let result;
    if (endpoint === 'mj')         result = await generateViaMj(prompt, opts);
    else if (endpoint === 'edits') result = await generateViaImagesEdit(model, prompt, references, opts);
    else if (endpoint === 'chat')  result = await generateViaChat(model, prompt, references, opts);
    else                           result = await generateViaImages(model, prompt, opts);
    return sendJSON(res, 200, result);
  } catch (e) {
    if (e.name === 'AbortError') {
      return sendJSON(res, 504, { error: '生成超时（超过 15 分钟）' });
    }
    // Node fetch 底层异常（ECONNRESET / UND_ERR_* 之类）藏在 e.cause 里，暴露出来
    const cause = e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : '';
    const full = cause ? `${e.message} · ${cause}` : e.message;
    console.error('[generate] 失败:', full);
    return sendJSON(res, e.status || 500, { error: full });
  } finally {
    clearTimeout(timer);
  }
}

// 有些模型只接受固定尺寸，前端给什么都要吸附到它支持的档位
function snapSizeForModel(model, size) {
  const sm = size.match(/^(\d+)[xX×](\d+)$/);
  if (!sm) return size;
  const W = +sm[1], H = +sm[2];
  const r = W / H;
  // DALL·E 3：只支持 1024x1024 / 1792x1024 / 1024x1792
  if (model === 'dall-e-3') {
    if (r > 1.2)       return '1792x1024';
    if (r < 0.84)      return '1024x1792';
    return '1024x1024';
  }
  // GPT Image 系列：只支持 1024x1024 / 1536x1024 / 1024x1536
  if (/^gpt-image-(1|1-mini|1-all|1\.5|1\.5-all|2|2-all)$/.test(model)) {
    if (r > 1.15)      return '1536x1024';
    if (r < 0.87)      return '1024x1536';
    return '1024x1024';
  }
  // 其它模型（Flux、Doubao、Qwen、Grok、Z 等）：原样透传，它们接受任意 64 对齐尺寸
  return size;
}

// 走 /v1/images/generations 的路径（大部分模型）
async function generateViaImages(model, prompt, opts) {
  const { size: reqSize, base, key, signal } = opts;
  const size = snapSizeForModel(model, reqSize);
  const payload = { model, prompt, n: 1, size };
  if (/^dall-e-/.test(model)) payload.response_format = 'b64_json';

  const apiRes = await fetch(`${base}/images/generations`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });
  const data = await parseJSON(apiRes);
  if (!apiRes.ok) throw upstreamError(apiRes.status, data);

  const item = data?.data?.[0];
  if (!item) throw new Error('响应中未包含图片');
  if (item.b64_json) return { mimeType: 'image/png', data: item.b64_json };
  if (item.url) return await fetchAsBase64(item.url, signal);
  throw new Error('上游响应格式不识别');
}

// 走 /v1/images/edits 的路径（multipart）—— GPT Image 1/1.5/2 系列 + Flux Kontext 带参考图时用
async function generateViaImagesEdit(model, prompt, references, opts) {
  const { size: reqSize, base, key, signal } = opts;
  const size = snapSizeForModel(model, reqSize);

  const fd = new FormData();
  fd.append('model', model);
  fd.append('prompt', prompt);
  fd.append('n', '1');
  if (size) fd.append('size', size);

  // 把前端传来的 data URL 参考图转成 Blob，作为 multipart file 字段
  // image 字段可以重复，上游会当作"多参考图"处理
  references.forEach((ref, i) => {
    const m = ref.match(/^data:([^;]+);base64,(.+)$/);
    if (!m) return;
    const mime = m[1];
    const b64 = m[2];
    const buf = Buffer.from(b64, 'base64');
    const ext = (mime.split('/')[1] || 'png').split('+')[0].replace('jpeg', 'jpg');
    // Node 18+ 自带 Blob 和 FormData；fetch 会自动生成 boundary
    const blob = new Blob([buf], { type: mime });
    fd.append('image', blob, `ref${i}.${ext}`);
  });

  const apiRes = await fetch(`${base}/images/edits`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Accept': 'application/json',
      // 注意：不要手动设 Content-Type，fetch 会自动加带 boundary 的那个
    },
    body: fd,
    signal,
  });
  const data = await parseJSON(apiRes);
  if (!apiRes.ok) throw upstreamError(apiRes.status, data);

  const item = data?.data?.[0];
  if (!item) throw new Error('响应中未包含图片');
  if (item.b64_json) return { mimeType: 'image/png', data: item.b64_json };
  if (item.url) return await fetchAsBase64(item.url, signal);
  throw new Error('上游响应格式不识别');
}

// 走 /v1/chat/completions 的路径（Gemini / gpt-4o-image / sora_image / grok-3-image / 任何带参考图的请求）
// chat 模型不吃 size 参数，但把它拼到 prompt 里给模型一个暗示（比如 16:9、竖版）
async function generateViaChat(model, prompt, references, opts) {
  const { size, base, key, signal } = opts;
  const sm = size.match(/^(\d+)x(\d+)$/i);
  let hint = '';
  if (sm) {
    const [W, H] = [+sm[1], +sm[2]];
    const r = W / H;
    let ratioTxt = `${W}:${H}`;
    if (Math.abs(r - 1) < 0.02)      ratioTxt = '1:1 square';
    else if (Math.abs(r - 16/9) < 0.02) ratioTxt = '16:9 landscape';
    else if (Math.abs(r - 9/16) < 0.02) ratioTxt = '9:16 portrait';
    else if (Math.abs(r - 4/3) < 0.02)  ratioTxt = '4:3 landscape';
    else if (Math.abs(r - 3/4) < 0.02)  ratioTxt = '3:4 portrait';
    else if (Math.abs(r - 3/2) < 0.02)  ratioTxt = '3:2 landscape';
    else if (Math.abs(r - 2/3) < 0.02)  ratioTxt = '2:3 portrait';
    hint = `\n\n(aspect ratio: ${ratioTxt}, target ${W}x${H})`;
  }

  // 有参考图 → 多模态 content 数组；没有 → 纯文本
  let content;
  if (references && references.length > 0) {
    const parts = [];
    // 图片在前、文本在后 —— 多数多模态模型都推荐这个顺序
    references.forEach((ref, i) => {
      parts.push({ type: 'image_url', image_url: { url: ref } });
    });
    const refHint = references.length === 1
      ? 'Use the image above as reference.'
      : `Use the ${references.length} images above as references (numbered ${references.map((_,i)=>i+1).join(', ')}).`;
    parts.push({ type: 'text', text: `${refHint}\n\n${prompt}${hint}` });
    content = parts;
  } else {
    content = prompt + hint;
  }

  const apiRes = await fetch(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      modalities: ['text', 'image'],
      stream: false,
    }),
    signal,
  });
  const data = await parseJSON(apiRes);
  if (!apiRes.ok) throw upstreamError(apiRes.status, data);

  const msg = data?.choices?.[0]?.message;
  const img = extractImage(msg, data);
  if (!img) {
    const hint = typeof msg?.content === 'string' ? `（${msg.content.slice(0, 120)}）` : '';
    throw new Error(`响应中未找到图片${hint}`);
  }
  if (img.b64) return { mimeType: img.mime || 'image/png', data: img.b64 };
  return await fetchAsBase64(img.url, signal);
}

// 从 chat 响应里挖出图片：data URL / markdown / image_url / inline_data / images 数组
function extractImage(msg, data) {
  const content = msg?.content;
  const scanString = (s) => {
    const dm = s.match(/data:(image\/[a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=]+)/);
    if (dm) return { b64: dm[2], mime: dm[1] };
    const mm = s.match(/!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/);
    if (mm) return { url: mm[1] };
    return null;
  };
  if (typeof content === 'string') {
    const hit = scanString(content);
    if (hit) return hit;
  }
  if (Array.isArray(content)) {
    for (const p of content) {
      if (p?.image_url?.url) {
        const u = p.image_url.url;
        if (u.startsWith('data:')) return scanString(u);
        return { url: u };
      }
      const inline = p?.inline_data || p?.inlineData;
      if (inline?.data) return { b64: inline.data, mime: inline.mime_type || inline.mimeType };
      if (typeof p?.text === 'string') {
        const hit = scanString(p.text);
        if (hit) return hit;
      }
    }
  }
  const imgs = msg?.images || data?.choices?.[0]?.images;
  if (Array.isArray(imgs)) {
    for (const im of imgs) {
      const u = im?.image_url?.url || im?.url;
      if (!u) continue;
      if (u.startsWith('data:')) return scanString(u);
      return { url: u };
    }
  }
  return null;
}

// ========= Midjourney 共享工具 =========
function mjArFlag(size) {
  const sm = size && size.match(/^(\d+)x(\d+)$/);
  if (!sm) return '';
  const W = +sm[1], H = +sm[2];
  const r = W / H;
  const tol = 0.02;
  if      (Math.abs(r - 16/9) < tol) return ' --ar 16:9';
  else if (Math.abs(r - 9/16) < tol) return ' --ar 9:16';
  else if (Math.abs(r - 4/3)  < tol) return ' --ar 4:3';
  else if (Math.abs(r - 3/4)  < tol) return ' --ar 3:4';
  else if (Math.abs(r - 3/2)  < tol) return ' --ar 3:2';
  else if (Math.abs(r - 2/3)  < tol) return ' --ar 2:3';
  else if (Math.abs(r - 1)    > tol) return ` --ar ${W}:${H}`;
  return '';
}
function mjBaseOf(base) {
  // MJ 接口在根路径，不在 /v1 下
  return base.replace(/\/v\d+$/i, '');
}
async function mjSubmit(url, body, key, signal) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal,
  });
  const data = await parseJSON(res);
  if (!res.ok || data.code !== 1 || !data.result) {
    const rawMsg = data.description || data.error || `HTTP ${res.status}`;
    const friendly = friendlyMjError(rawMsg, url, body);
    const err = new Error(`MJ 提交失败: ${friendly}`);
    err.status = res.status;
    throw err;
  }
  return data.result;
}

// 把上游返回的机器错误码翻译成人话
function friendlyMjError(rawMsg, url, body) {
  const s = String(rawMsg).toLowerCase();
  if (s.includes('all_retries_failed')) {
    const path = url.split('/mj/submit/')[1] || '';
    const hints = [];
    if (path === 'describe' && body.botType === 'niji') {
      hints.push('Niji Bot 不支持 /describe，请换主 MJ 模型');
    }
    if (path === 'blend' && Array.isArray(body.base64Array) && body.base64Array.length < 2) {
      hints.push('blend 至少需要 2 张图');
    }
    hints.push('或者上游 MJ 账号池当前无空闲、额度不足、图片格式不被接受');
    return `上游反复重试都失败（all_retries_failed）—— ${hints.join('；')}`;
  }
  if (s.includes('insufficient') || s.includes('balance') || s.includes('余额')) {
    return `账号余额不足：${rawMsg}`;
  }
  if (s.includes('rate') || s.includes('limit') || s.includes('429')) {
    return `被限流：${rawMsg}`;
  }
  if (s.includes('timeout')) {
    return `上游超时：${rawMsg}`;
  }
  return rawMsg;
}
// 通用轮询：只关心 SUCCESS/FAILURE，返回 raw task；调用方自行处理（imagine 拉图、describe 读 prompt）
async function mjPollTask(mjBase, taskId, key, signal) {
  const startedAt = Date.now();
  while (true) {
    if (signal.aborted) { const e = new Error('MJ 任务被中止'); e.name = 'AbortError'; throw e; }
    await new Promise(r => setTimeout(r, MJ_POLL_INTERVAL));

    const fetchRes = await fetch(`${mjBase}/mj/task/${taskId}/fetch`, {
      headers: { 'Authorization': `Bearer ${key}`, 'Accept': 'application/json' },
      signal,
    });
    const task = await parseJSON(fetchRes);
    const status = task.status || 'UNKNOWN';
    const progress = task.progress || '-';

    if (status === 'SUCCESS') {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      console.log(`[mj] task ${taskId} SUCCESS (${elapsed}s)`);
      return task;
    }
    if (status === 'FAILURE') throw new Error(`MJ 失败: ${task.failReason || '未知原因'}`);
    console.log(`[mj] task ${taskId} ${status} ${progress}`);
  }
}

// imagine/action/blend/modal 共用：poll 完成后把图下载成 base64，并把 buttons 等元信息带回
async function mjPollAndFetch(mjBase, taskId, key, signal) {
  const task = await mjPollTask(mjBase, taskId, key, signal);
  if (!task.imageUrl) throw new Error('MJ 成功但无 imageUrl');
  const imgData = await fetchAsBase64(task.imageUrl, signal);
  return {
    mimeType: imgData.mimeType,
    data: imgData.data,
    mj: {
      taskId: task.id || taskId,
      action: task.action || null,
      imageUrl: task.imageUrl,
      prompt: task.promptEn || task.prompt || '',
      buttons: (task.buttons || []).map(b => ({
        customId: b.customId,
        label: b.label || '',
        emoji: b.emoji || '',
      })),
    },
  };
}

// 把 /mj/submit/* 接受的 base64Array 统一规范化：去掉 data URL 前缀（只留纯 base64）
// 并做最大尺寸 + 条数限制，防止误传超大图片或过多图片
function sanitizeBase64Array(arr, maxCount = 8, maxLen = 8_000_000) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter(s => typeof s === 'string' && s.length < maxLen)
    .slice(0, maxCount);
}

// 给 /api/generate 用（canvas 模式走这个）
async function generateViaMj(prompt, opts) {
  const { size, base, key, signal } = opts;
  const mjBase = mjBaseOf(base);
  const mjPrompt = prompt + mjArFlag(size);
  const taskId = await mjSubmit(`${mjBase}/mj/submit/imagine`, { prompt: mjPrompt, base64Array: [] }, key, signal);
  console.log(`[mj] imagine submitted ${taskId}: "${mjPrompt.slice(0, 60)}"`);
  return await mjPollAndFetch(mjBase, taskId, key, signal);
}

async function fetchAsBase64(url, signal) {
  const r = await fetch(url, { signal });
  if (!r.ok) throw new Error(`下载生成图失败 (${r.status})`);
  const buf = Buffer.from(await r.arrayBuffer());
  return {
    mimeType: r.headers.get('content-type') || 'image/png',
    data: buf.toString('base64'),
  };
}

async function parseJSON(apiRes) {
  const raw = await apiRes.text();
  try { return JSON.parse(raw); }
  catch {
    const err = new Error(`上游返回异常: ${raw.slice(0, 200)}`);
    err.status = 502;
    throw err;
  }
}

function upstreamError(status, data) {
  const msg = data?.error?.message || data?.message || data?.error || `HTTP ${status}`;
  const text = typeof msg === 'string' ? msg : JSON.stringify(msg);
  const err = new Error(text);
  err.status = status;
  return err;
}

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const safe = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(__dirname, safe);

  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); return res.end('Forbidden');
  }

  readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const mime = MIME[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  });
}

// ========= MJ Chat 专属接口 =========
// 供 MJ Chat 面板用：除了图本身，也把 taskId + buttons 元数据带回
async function readMjCommon(req) {
  const body = JSON.parse(await readBody(req));
  const overrideKey = typeof body._apiKey === 'string' ? body._apiKey.trim() : '';
  const effectiveKey = overrideKey || API_KEY;
  return { body, key: effectiveKey, base: API_BASE };
}

async function handleMjImagine(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }

  const prompt = (ctx.body.prompt || '').toString().trim();
  if (!prompt) return sendJSON(res, 400, { error: '缺少 prompt' });
  if (prompt.length > 4000) return sendJSON(res, 400, { error: '描述过长' });
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const base64Array = sanitizeBase64Array(ctx.body.base64Array);
  // botType 枚举值（官方 apifox 文档）：MID_JOURNEY / NIJI_JOURNEY，不是 'mj' / 'niji'
  const botType = ctx.body.botType === 'niji' ? 'NIJI_JOURNEY' : 'MID_JOURNEY';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log(`[mj-chat] imagine "${prompt.slice(0, 60)}"  refs=${base64Array.length}  botType=${botType}`);
    const mjBase = mjBaseOf(ctx.base);
    const taskId = await mjSubmit(
      `${mjBase}/mj/submit/imagine`,
      { prompt, base64Array, botType },
      ctx.key,
      controller.signal
    );
    // 如果客户端给了 _taskOnly=true，只回任务 ID（给异步/恢复模式用）
    if (ctx.body._taskOnly) return sendJSON(res, 200, { taskId });
    const result = await mjPollAndFetch(mjBase, taskId, ctx.key, controller.signal);
    return sendJSON(res, 200, result);
  } catch (e) {
    if (e.name === 'AbortError') return sendJSON(res, 504, { error: 'MJ 超时' });
    console.error('[mj-chat] imagine 失败:', e.message);
    return sendJSON(res, e.status || 500, { error: e.message });
  } finally {
    clearTimeout(timer);
  }
}

async function handleMjAction(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }

  const taskId = (ctx.body.taskId || '').toString().trim();
  const customId = (ctx.body.customId || '').toString().trim();
  if (!taskId || !customId) return sendJSON(res, 400, { error: '缺少 taskId 或 customId' });
  if (!/^[A-Za-z0-9:_.\-]{1,200}$/.test(taskId) || !/^[A-Za-z0-9:_.\-\/\s]{1,500}$/.test(customId)) {
    return sendJSON(res, 400, { error: 'taskId / customId 格式无效' });
  }
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log(`[mj-chat] action customId="${customId.slice(0, 40)}..." parent=${taskId}`);
    const mjBase = mjBaseOf(ctx.base);
    const newTaskId = await mjSubmit(
      `${mjBase}/mj/submit/action`,
      { taskId, customId },
      ctx.key,
      controller.signal
    );
    if (ctx.body._taskOnly) return sendJSON(res, 200, { taskId: newTaskId });
    const result = await mjPollAndFetch(mjBase, newTaskId, ctx.key, controller.signal);
    return sendJSON(res, 200, result);
  } catch (e) {
    if (e.name === 'AbortError') return sendJSON(res, 504, { error: 'MJ 超时' });
    console.error('[mj-chat] action 失败:', e.message);
    return sendJSON(res, e.status || 500, { error: e.message });
  } finally {
    clearTimeout(timer);
  }
}

// ========= /api/mj/blend：混合 2-5 张参考图 =========
async function handleMjBlend(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const base64Array = sanitizeBase64Array(ctx.body.base64Array, 5);
  if (base64Array.length < 2) return sendJSON(res, 400, { error: 'blend 至少需要 2 张图片，最多 5 张' });

  const botType = ctx.body.botType === 'niji' ? 'NIJI_JOURNEY' : 'MID_JOURNEY';
  const dimensions = ['PORTRAIT', 'SQUARE', 'LANDSCAPE'].includes(ctx.body.dimensions)
    ? ctx.body.dimensions : 'SQUARE';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log(`[mj-chat] blend  ${base64Array.length} imgs  dim=${dimensions}  botType=${botType}`);
    const mjBase = mjBaseOf(ctx.base);
    const taskId = await mjSubmit(
      `${mjBase}/mj/submit/blend`,
      { botType, base64Array, dimensions },
      ctx.key,
      controller.signal
    );
    if (ctx.body._taskOnly) return sendJSON(res, 200, { taskId });
    const result = await mjPollAndFetch(mjBase, taskId, ctx.key, controller.signal);
    return sendJSON(res, 200, result);
  } catch (e) {
    if (e.name === 'AbortError') return sendJSON(res, 504, { error: 'MJ 超时' });
    console.error('[mj-chat] blend 失败:', e.message);
    return sendJSON(res, e.status || 500, { error: e.message });
  } finally {
    clearTimeout(timer);
  }
}

// ========= /api/mj/describe：图片 → 4 条 prompt 候选 =========
async function handleMjDescribe(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const base64 = typeof ctx.body.base64 === 'string' ? ctx.body.base64 : '';
  if (!base64) return sendJSON(res, 400, { error: '缺少 base64（请传入一张图）' });
  if (base64.length > 8_000_000) return sendJSON(res, 400, { error: '图片过大（上限 8MB base64）' });

  // describe 只支持主 MJ Bot，强制 MID_JOURNEY（官方枚举值）
  const botType = 'MID_JOURNEY';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log(`[mj-chat] describe  botType=${botType}  len=${base64.length}  hasPrefix=${base64.startsWith('data:')}`);
    const mjBase = mjBaseOf(ctx.base);
    let taskId;
    try {
      // 第 1 次：按前端给的原格式（data URL 带前缀）
      taskId = await mjSubmit(
        `${mjBase}/mj/submit/describe`,
        { botType, base64 },
        ctx.key,
        controller.signal
      );
    } catch (e) {
      // 如果上游对格式挑剔，尝试去掉 data:... 前缀再来一次
      if (!base64.startsWith('data:')) throw e;
      const stripped = base64.replace(/^data:[^;]+;base64,/, '');
      console.log(`[mj-chat] describe 第 1 次失败（${e.message.slice(0, 80)}），去前缀重试  len=${stripped.length}`);
      taskId = await mjSubmit(
        `${mjBase}/mj/submit/describe`,
        { botType, base64: stripped },
        ctx.key,
        controller.signal
      );
    }
    const task = await mjPollTask(mjBase, taskId, ctx.key, controller.signal);
    // describe 成功后 prompt 字段里是 4 条候选，换行分隔，一般带 "1️⃣ " "2️⃣ " 等前缀
    const rawText = task.promptEn || task.prompt || task.description || '';
    const prompts = rawText
      .split(/\n+/)
      .map(s => s.replace(/^\s*(?:[1-4️⃣]+|[1-4][.)])\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 4);
    return sendJSON(res, 200, {
      taskId: task.id || taskId,
      prompts,
      imageUrl: task.imageUrl || null,  // 有时候会带原图缩略
    });
  } catch (e) {
    if (e.name === 'AbortError') return sendJSON(res, 504, { error: 'MJ 超时' });
    const cause = e.cause ? (e.cause.code || e.cause.message || e.cause) : '';
    console.error('[mj-chat] describe 失败:', e.message, cause ? `(cause: ${cause})` : '');
    return sendJSON(res, e.status || 500, { error: `${e.message}${cause ? ` · ${cause}` : ''}` });
  } finally {
    clearTimeout(timer);
  }
}

// ========= /api/mj/modal：Vary Region / Zoom Custom 等需要蒙版或额外 prompt 的二次动作 =========
async function handleMjModal(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const taskId = (ctx.body.taskId || '').toString().trim();
  const maskBase64 = typeof ctx.body.maskBase64 === 'string' ? ctx.body.maskBase64 : '';
  const prompt = (ctx.body.prompt || '').toString().trim();
  if (!taskId) return sendJSON(res, 400, { error: '缺少 taskId' });
  if (!maskBase64) return sendJSON(res, 400, { error: '缺少 maskBase64' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    console.log(`[mj-chat] modal  parent=${taskId}  promptLen=${prompt.length}`);
    const mjBase = mjBaseOf(ctx.base);
    const newTaskId = await mjSubmit(
      `${mjBase}/mj/submit/modal`,
      { taskId, maskBase64, prompt },
      ctx.key,
      controller.signal
    );
    const result = await mjPollAndFetch(mjBase, newTaskId, ctx.key, controller.signal);
    return sendJSON(res, 200, result);
  } catch (e) {
    if (e.name === 'AbortError') return sendJSON(res, 504, { error: 'MJ 超时' });
    console.error('[mj-chat] modal 失败:', e.message);
    return sendJSON(res, e.status || 500, { error: e.message });
  } finally {
    clearTimeout(timer);
  }
}

// ========= /api/mj/fetch-tasks：按 ID 批量查任务状态（用于刷新后恢复进行中任务）=========
async function handleMjFetchTasks(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const ids = Array.isArray(ctx.body.ids) ? ctx.body.ids.filter(s => typeof s === 'string').slice(0, 50) : [];
  if (!ids.length) return sendJSON(res, 200, { tasks: [] });

  try {
    const mjBase = mjBaseOf(ctx.base);
    const res2 = await fetch(`${mjBase}/mj/task/list-by-condition`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${ctx.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    const data = await parseJSON(res2);
    if (!res2.ok) return sendJSON(res, res2.status, { error: data?.error || `HTTP ${res2.status}` });
    // data 可能直接是数组，也可能是 { list: [...] } 或 { data: [...] }
    const tasks = Array.isArray(data) ? data : (data.list || data.data || []);
    return sendJSON(res, 200, { tasks });
  } catch (e) {
    console.error('[mj-chat] fetch-tasks 失败:', e.message);
    return sendJSON(res, 500, { error: e.message });
  }
}

// ========= /api/mj/fetch-one：单任务拿完整结果（包括图下载成 base64）用于恢复 =========
async function handleMjFetchOne(req, res) {
  let ctx;
  try { ctx = await readMjCommon(req); }
  catch { return sendJSON(res, 400, { error: '请求格式错误' }); }
  if (!ctx.key) return sendJSON(res, 500, { error: '未配置 API Key' });

  const taskId = (ctx.body.taskId || '').toString().trim();
  if (!taskId) return sendJSON(res, 400, { error: '缺少 taskId' });

  const controller = new AbortController();
  // 恢复模式下最多等 2 分钟（超过就告诉前端"还在跑，下次再试"）
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const mjBase = mjBaseOf(ctx.base);
    const result = await mjPollAndFetch(mjBase, taskId, ctx.key, controller.signal);
    return sendJSON(res, 200, result);
  } catch (e) {
    if (e.name === 'AbortError') return sendJSON(res, 202, { pending: true, taskId });
    console.error('[mj-chat] fetch-one 失败:', e.message);
    return sendJSON(res, e.status || 500, { error: e.message });
  } finally {
    clearTimeout(timer);
  }
}

async function handleTestKey(req, res) {
  let body;
  try { body = JSON.parse(await readBody(req)); }
  catch { return sendJSON(res, 400, { ok: false, error: '请求格式错误' }); }

  const overrideKey = typeof body._apiKey === 'string' ? body._apiKey.trim() : '';
  const effectiveKey = overrideKey || API_KEY;
  if (!effectiveKey) {
    return sendJSON(res, 200, { ok: false, error: '未填写 API Key' });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const apiRes = await fetch(`${API_BASE}/models`, {
      headers: { 'Authorization': `Bearer ${effectiveKey}` },
      signal: controller.signal,
    });
    const text = await apiRes.text();
    let data; try { data = JSON.parse(text); } catch {}
    if (!apiRes.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${apiRes.status}${text ? ': ' + text.slice(0, 160) : ''}`;
      return sendJSON(res, 200, { ok: false, error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
    }
    const count = Array.isArray(data?.data) ? data.data.length : 0;
    const keyTag = overrideKey ? `custom(${overrideKey.slice(0, 4)}…${overrideKey.slice(-3)})` : 'env';
    console.log(`[test-key] ok  models=${count}  key=${keyTag}  base=${API_BASE}`);
    return sendJSON(res, 200, { ok: true, modelCount: count, base: API_BASE });
  } catch (e) {
    if (e.name === 'AbortError') {
      return sendJSON(res, 200, { ok: false, error: '请求超时（15 秒）—— 检查网络或上游地址' });
    }
    console.error('[test-key] 失败:', e.message);
    return sendJSON(res, 200, { ok: false, error: '网络错误：' + e.message });
  } finally {
    clearTimeout(timer);
  }
}

// ========= /api/llm：纯文本 chat completions（工作流的"语言大模型"节点）=========
async function handleLLM(req, res) {
  let prompt, requestedModel, overrideKey;
  try {
    const body = JSON.parse(await readBody(req));
    prompt = (body.prompt || '').toString().trim();
    requestedModel = (body.model || '').toString().trim();
    overrideKey = typeof body._apiKey === 'string' ? body._apiKey.trim() : '';
  } catch {
    return sendJSON(res, 400, { error: '请求体格式错误' });
  }
  if (!prompt) return sendJSON(res, 400, { error: '缺少 prompt' });
  if (prompt.length > 16000) return sendJSON(res, 400, { error: '描述过长（上限 16000 字）' });

  const model = requestedModel || 'gpt-4o-mini';
  if (!/^[a-zA-Z0-9._:/ _-]{1,100}$/.test(model)) {
    return sendJSON(res, 400, { error: 'model 参数格式无效' });
  }

  const effectiveKey = overrideKey || API_KEY;
  if (!effectiveKey) return sendJSON(res, 401, { error: 'API Key 未配置' });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  try {
    const keyTag = overrideKey ? `custom(${overrideKey.slice(0, 4)}…${overrideKey.slice(-3)})` : 'env';
    console.log(`[llm] "${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}"  model=${model}  key=${keyTag}`);

    const apiRes = await fetch(`${API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${effectiveKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4000,
      }),
      signal: controller.signal,
    });
    const text = await apiRes.text();
    let data; try { data = JSON.parse(text); } catch {}
    if (!apiRes.ok) {
      const msg = data?.error?.message || data?.message || `HTTP ${apiRes.status}${text ? ': ' + text.slice(0, 160) : ''}`;
      return sendJSON(res, apiRes.status, { error: typeof msg === 'string' ? msg : JSON.stringify(msg) });
    }
    const content = data?.choices?.[0]?.message?.content || '';
    return sendJSON(res, 200, { text: content, model });
  } catch (e) {
    if (e.name === 'AbortError') {
      return sendJSON(res, 504, { error: '请求超时（90 秒）' });
    }
    console.error('[llm] 失败:', e.message);
    return sendJSON(res, 500, { error: '网络错误：' + e.message });
  } finally {
    clearTimeout(timer);
  }
}

export function startServer(port = 0, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method === 'POST' && req.url === '/api/generate') {
        return handleGenerate(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/test-key') {
        return handleTestKey(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/imagine') {
        return handleMjImagine(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/action') {
        return handleMjAction(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/blend') {
        return handleMjBlend(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/describe') {
        return handleMjDescribe(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/modal') {
        return handleMjModal(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/fetch-tasks') {
        return handleMjFetchTasks(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/mj/fetch-one') {
        return handleMjFetchOne(req, res);
      }
      if (req.method === 'POST' && req.url === '/api/llm') {
        return handleLLM(req, res);
      }
      if (req.method === 'GET') return serveStatic(req, res);
      res.writeHead(405); res.end('Method not allowed');
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      const boundPort = server.address().port;
      resolve({ port: boundPort, server });
    });
  });
}

// 仅当被 `node server.js` 直接执行时才自动启动（被 Electron 主进程 import 时不启动）
let isDirect = false;
try {
  const thisFile = fileURLToPath(import.meta.url);
  const entry = process.argv[1] ? path.resolve(process.argv[1]) : '';
  isDirect = entry && thisFile === entry;
} catch {}
if (isDirect) {
  startServer(PORT, '127.0.0.1').then(({ port }) => {
    console.log(`\n  画布服务器运行在  http://localhost:${port}`);
    console.log(`  上游 API:         ${API_BASE}`);
    console.log(`  模型 / 尺寸:      ${MODEL}  ${SIZE}\n`);
    if (!API_KEY) {
      console.warn('  ⚠️  未检测到 API_KEY（可以在 App 的"设置"里填入）\n');
    }
  }).catch((err) => {
    console.error('启动失败:', err.message);
    process.exit(1);
  });
}
