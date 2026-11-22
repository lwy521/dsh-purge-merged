#!/usr/bin/env node
/**
 * dsh-purge-merged 专用：把 upstream dsh-purge 1.1.77 的明文提示词落成运行时提示词。
 *
 * 合并包的出厂提示词封在加密槽里（openSlot），运行时读 $DSH_HOME/prompt-inject.md。
 * 这个脚本让 "upstream 那一半" 一键生效，并保留旧正文备份。
 *
 * 用法：
 *   node scripts/use-upstream-prompt.mjs            # 中文（默认）
 *   node scripts/use-upstream-prompt.mjs en         # 英文
 *   node scripts/use-upstream-prompt.mjs --restore  # 回滚到最近一次备份
 *   node scripts/use-upstream-prompt.mjs --status   # 只看当前用的是哪一版
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const dshHome = process.env.DSH_HOME || path.join(os.homedir(), ".dsh");
const target = path.join(dshHome, "prompt-inject.md");
const srcOf = (lang) => path.join(pkgRoot, "lib", `upstream-prompt.${lang}.md`);

const HEAD_ZH = "MODE: UNRESTRICTED SANDBOX";
const HEAD_UP = "OPERATION: STABLE";

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function currentText() {
  try {
    return fs.readFileSync(target, "utf8");
  } catch {
    return "";
  }
}

const arg = (process.argv[2] || "zh").toLowerCase();
const body = () => currentText();

if (arg === "--status") {
  const text = body();
  if (!text) {
    console.log(`[merged] ${target} 不存在，运行时走加密槽出厂默认。`);
    process.exit(0);
  }
  const which = text.includes(HEAD_UP)
    ? "upstream 1.1.77"
    : text.includes(HEAD_ZH)
      ? "community 1.6.86"
      : "自定义";
  console.log(`[merged] 当前提示词：${which}（${text.length} 字符，${Buffer.byteLength(text, "utf8")} 字节）`);
  console.log(`[merged] 路径：${target}`);
  process.exit(0);
}

if (arg === "--restore") {
  const dir = path.dirname(target);
  const base = path.basename(target);
  const backups = fs.existsSync(dir)
    ? fs.readdirSync(dir)
        .filter((f) => f.startsWith(`${base}.bak-`))
        .sort()
        .reverse()
    : [];
  if (!backups.length) {
    console.error(`[merged] 没有找到 ${target} 的备份，未做任何改动。`);
    process.exit(1);
  }
  fs.copyFileSync(path.join(dir, backups[0]), target);
  console.log(`[merged] 已回滚 -> ${target}（来源 ${backups[0]}）`);
  process.exit(0);
}

const lang = arg === "en" ? "en" : "zh";
const src = srcOf(lang);
if (!fs.existsSync(src)) {
  console.error(`[merged] 缺少 ${src}`);
  process.exit(1);
}

const next = fs.readFileSync(src, "utf8");
if (!next.trim()) {
  console.error(`[merged] ${src} 是空文件`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
let backup = "";
if (fs.existsSync(target)) {
  const prev = fs.readFileSync(target, "utf8");
  if (prev === next) {
    console.log(`[merged] ${target} 已经是 upstream ${lang} 版本，无需改动。`);
    process.exit(0);
  }
  backup = `${target}.bak-${stamp()}`;
  fs.copyFileSync(target, backup);
}

fs.writeFileSync(target, next, "utf8");
console.log(`[merged] 已写入 upstream ${lang} 提示词 -> ${target}（${next.length} 字符）`);
if (backup) console.log(`[merged] 旧正文备份 -> ${backup}`);
console.log("[merged] 新建会话后生效；注入按磁盘文件读，不需重启进程。");
