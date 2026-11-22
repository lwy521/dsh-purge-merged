import fs from "node:fs";
import path from "node:path";
import { parseDocument, isMap, isSeq, isScalar } from "yaml";

const literal = (node) => isScalar(node) && !node.tag;

/** Inspect data only. Never evaluate Cordis expressions, resolve aliases or rewrite a preset. */
export function inspectPresetText(text) {
  try {
    const doc = parseDocument(text, { customTags: [] });
    if (doc.errors.length || !isSeq(doc.contents) || doc.contents.tag) return "unknown";
    const personas = [];
    for (const row of doc.contents.items) {
      if (!isMap(row) || row.tag) return "unknown";
      const id = row.get("id", true), name = row.get("name", true);
      if ((id && !literal(id)) || (name && !literal(name))) return "unknown";
      if (id?.value === "persona" || name?.value === "@deepseek-ai/dsh-persona") personas.push(row);
    }
    if (personas.length !== 1) return "unknown";
    const row = personas[0], name = row.get("name", true), disabled = row.get("disabled", true);
    if (row.has("<<") || name?.value !== "@deepseek-ai/dsh-persona" ||
        (disabled && (!literal(disabled) || disabled.value !== false))) return "unknown";
    const config = row.get("config", true);
    if (!isMap(config) || config.tag || config.has("<<")) return "unknown";
    const prefix = config.get("prefix", true);
    if (!literal(prefix) || typeof prefix.value !== "string") return "unknown";
    // A template/expression can produce text that a static check cannot see.
    if (/\{\{|\$\{/.test(prefix.value)) return "unknown";
    const remaining = /You\s+are\s+a\s+(?:coding\s+agent\s+powered\s+by|helpful\s+software\s+engineer\s+assistant)/i;
    return remaining.test(prefix.value) ? "skipped" : "not_needed";
  } catch {
    return "unknown";
  }
}
