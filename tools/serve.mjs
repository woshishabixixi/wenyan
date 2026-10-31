#!/usr/bin/env node
/* 文言文生词 · 本地静态服务器（零依赖）
 *
 * 用法：node tools/serve.mjs
 *       然后在浏览器打开 http://127.0.0.1:8787
 * 换端口：PORT=9000 node tools/serve.mjs   （Windows PowerShell: $env:PORT=9000; node tools/serve.mjs）
 */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT) || 8787;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

async function resolveTarget(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    return { error: 400 };
  }
  if (decoded.includes('\0')) return { error: 400 };
  let full = normalize(join(ROOT, decoded));
  if (full !== ROOT && !full.startsWith(ROOT + sep)) return { error: 403 };

  let info;
  try {
    info = await stat(full);
  } catch (err) {
    return { error: 404, path: decoded };
  }
  if (info.isDirectory()) {
    if (!decoded.endsWith('/')) return { redirect: decoded + '/' };
    full = join(full, 'index.html');
    try {
      info = await stat(full);
    } catch (err) {
      return { error: 404, path: decoded + 'index.html' };
    }
    if (!info.isFile()) return { error: 404, path: decoded + 'index.html' };
  } else if (!info.isFile()) {
    return { error: 404, path: decoded };
  }
  return { file: full, size: info.size };
}

const server = createServer(async (req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, '405 只支持 GET / HEAD\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let pathname;
  try {
    pathname = new URL(req.url, 'http://' + (req.headers.host || HOST)).pathname;
  } catch (err) {
    send(res, 400, '400 请求地址无法解析\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const target = await resolveTarget(pathname);
  if (target.redirect) {
    send(res, 301, '', { Location: target.redirect });
    return;
  }
  if (target.error === 400) {
    send(res, 400, '400 路径不合法\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  if (target.error === 403) {
    send(res, 403, '403 不允许访问该路径\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }
  if (target.error === 404) {
    const msg =
      '404 找不到这个文件：' + target.path + '\n\n' +
      '可能原因：\n' +
      '  1. 文件名拼写不对；\n' +
      '  2. 这个文件还没有生成（例如 index.html 由应用本体任务产出）；\n' +
      '  3. 请确认是在 wenyan-srs 目录里运行 node tools/serve.mjs。\n\n' +
      '首页地址：/\n';
    send(res, 404, msg, { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  let body;
  try {
    body = await readFile(target.file);
  } catch (err) {
    send(res, 500, '500 读取文件失败：' + target.file + '\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    return;
  }

  const type = MIME[extname(target.file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': type,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
  });
  res.end(req.method === 'HEAD' ? undefined : body);
});

server.listen(PORT, HOST, () => {
  console.log('文言文生词 · 本地预览');
  console.log('目录：' + ROOT);
  console.log('打开：http://' + HOST + ':' + PORT + '/');
  console.log('停止：按 Ctrl+C');
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error('端口 ' + PORT + ' 已被占用。换一个端口：PORT=8790 node tools/serve.mjs');
  } else {
    console.error('启动失败：', err);
  }
  process.exitCode = 1;
});
