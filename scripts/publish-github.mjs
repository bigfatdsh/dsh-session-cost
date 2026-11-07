#!/usr/bin/env node
// dsh-session-cost 发布脚本：把本目录的源码推到 GitHub（走 api.github.com，本机 github.com:22 不通）。
//
// 用法：
//   node scripts/publish-github.mjs --dry-run   # 只看会推哪些文件
//   node scripts/publish-github.mjs             # 推送到 bigfatdsh/dsh-session-cost
//
// 环境变量：REPO（默认 bigfatdsh/dsh-session-cost）、BRANCH（默认 main）。
// token 从 macOS 钥匙串取（`security find-internet-password -s github.com -w`），不落文件。
//
// 只推有变化的文件：先取远端文件 sha 比对，一样就跳过，重复跑不会制造空提交。

import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const REPO = process.env.REPO ?? 'bigfatdsh/dsh-session-cost';
const BRANCH = process.env.BRANCH ?? 'main';
const API = 'https://api.github.com';
const DRY = process.argv.includes('--dry-run');

const TOKEN = (() => {
  try {
    return execSync('security find-internet-password -s github.com -w', { encoding: 'utf8' }).trim();
  } catch {
    console.error('取不到 GitHub token（钥匙串里没有 github.com 的互联网密码）。');
    process.exit(1);
  }
})();

const headers = {
  Accept: 'application/vnd.github+json',
  Authorization: `Bearer ${TOKEN}`,
  'User-Agent': 'dsh-session-cost-publish',
  'Content-Type': 'application/json',
};

/** 要发布的文件：package.json 的 files（目录递归），外加 package.json 自身。 */
function collect() {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const out = new Set(['package.json']);
  const walk = (rel) => {
    const abs = path.join(root, rel);
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        if (name === 'node_modules' || name === '.DS_Store') continue;
        walk(path.join(rel, name));
      }
    } else {
      out.add(rel);
    }
  };
  for (const entry of pkg.files ?? []) if (fs.existsSync(path.join(root, entry))) walk(entry);
  // 发布脚本自身也进仓库，换台机器还能继续发。
  if (fs.existsSync(path.join(root, 'scripts/publish-github.mjs'))) out.add('scripts/publish-github.mjs');
  return [...out].sort();
}

async function api(endpoint, init = {}) {
  const response = await fetch(`${API}${endpoint}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, ok: response.ok, body };
}

async function ensureRepo() {
  const existing = await api(`/repos/${REPO}`);
  if (existing.ok) return 'exists';
  if (existing.status !== 404) throw new Error(`检查仓库失败：${existing.status} ${JSON.stringify(existing.body).slice(0, 200)}`);
  const created = await api('/user/repos', {
    method: 'POST',
    body: JSON.stringify({
      name: REPO.split('/')[1],
      description: 'WPAC agent preset for DeepSeek Harness: W/P/A/C prompt engineering (author: 姜涛)',
      private: false,
      has_issues: true,
      has_wiki: false,
    }),
  });
  if (!created.ok) throw new Error(`创建仓库失败：${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  return 'created';
}

async function remoteSha(file) {
  const res = await api(`/repos/${REPO}/contents/${encodeURI(file)}?ref=${BRANCH}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`读取远端 ${file} 失败：${res.status}`);
  return res.body?.sha ?? null;
}

function blobSha(buffer) {
  return createHash('sha1').update(`blob ${buffer.length}\0`).update(buffer).digest('hex');
}

async function main() {
  console.log(`发布 ${root} → ${REPO}@${BRANCH}${DRY ? '（dry-run）' : ''}`);
  if (!DRY) console.log(`仓库：${await ensureRepo()}`);
  let pushed = 0;
  let skipped = 0;
  for (const file of collect()) {
    const buffer = fs.readFileSync(path.join(root, file));
    const sha = await remoteSha(file);
    if (sha !== null && sha === blobSha(buffer)) {
      console.log(`  = ${file} 未变化`);
      skipped += 1;
      continue;
    }
    if (DRY) {
      console.log(`  ⇢ ${file} 会推送（${(buffer.length / 1024).toFixed(1)} KB）`);
      pushed += 1;
      continue;
    }
    const res = await api(`/repos/${REPO}/contents/${encodeURI(file)}`, {
      method: 'PUT',
      body: JSON.stringify({
        message: `dsh-session-cost ${file}`,
        content: buffer.toString('base64'),
        branch: BRANCH,
        ...(sha ? { sha } : {}),
      }),
    });
    if (!res.ok) throw new Error(`推送 ${file} 失败：${res.status} ${JSON.stringify(res.body).slice(0, 200)}`);
    console.log(`  ✓ ${file}（${(buffer.length / 1024).toFixed(1)} KB）`);
    pushed += 1;
  }
  console.log(`\n${DRY ? '[dry] ' : ''}${pushed} 个文件${DRY ? '会推送' : '已推送'}，${skipped} 个未变化 · ${REPO}@${BRANCH}`);
}

main().catch((error) => {
  console.error(`发布失败：${error?.message ?? error}`);
  process.exit(1);
});
