import { useSyncExternalStore } from "react";
import english from "./en.json";
import systemEnglish from "./system-en.json";

export type LocaleService = {
  getSnapshot(): { active: string; revision: number };
  subscribe(listener: () => void): () => void;
  register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void;
  bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
};
const en: Record<string, string> = { ...english, ...systemEnglish };
const zh = { ...Object.fromEntries(Object.keys(en).map(key => [key, key])), "unit.task.one": "项任务", "unit.message.one": "封邮件" } as Record<string, string>;
let service: LocaleService | undefined;
let translate: ReturnType<LocaleService["bind"]> | undefined;
let registered: (() => void) | undefined;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach(listener => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => { const value = service?.getSnapshot(); return value ? `${value.active}:${value.revision}` : "zh:0"; };
export function language(): string { return service?.getSnapshot().active || "zh"; }
export function useWorkbenchLocale(): void { useSyncExternalStore(subscribe, snapshot, snapshot); }

/** Reuse the host's locale preference, fallback chain and lifecycle. No local preference. */
export function connectLocale(next?: LocaleService): () => void {
  service = next;
  registered = next?.register("bkms-workbench", { zh, en });
  translate = next?.bind("bkms-workbench");
  const unsubscribe = next?.subscribe(notify);
  notify();
  return () => {
    unsubscribe?.();
    registered?.(); registered = undefined;
    if (service === next) { service = undefined; translate = undefined; notify(); }
  };
}
export function t(key: string, ...values: unknown[]): string {
  const params = Object.fromEntries(values.map((value, index) => [String(index), value]));
  if (translate) return translate(key, params);
  const template = zh[key] || key;
  return template.replace(/\{(\d+)\}/g, (token, index) => String(params[index] ?? token));
}

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const buildPatterns = () => Object.entries(en).filter(([key]) => key !== "{0}。{1}").flatMap(([key, value]) => [key, value].map(template => {
  const indices: number[] = [];
  const parts = template.split(/(\{\d+\})/g).map(part => {
    if (/^\{\d+\}$/.test(part)) { indices.push(Number(part.slice(1, -1))); return "([\\s\\S]*?)"; }
    return escapeRegex(part);
  });
  return { key, indices, regex: new RegExp(`^${parts.join("")}$`) };
})).sort((a, b) => b.key.replace(/\{\d+\}/g, "").length - a.key.replace(/\{\d+\}/g, "").length);
let patterns = buildPatterns();
const added = new Set<string>();
/**
 * English for the messages of installed channels (`channelInfo[].systemEnglish`), which are not in this plugin's own
 * dictionaries. Existing entries are kept; the same dictionary is added only once.
 */
export function addSystemEnglish(dictionaries: (Record<string, string> | undefined)[]): void {
  let changed = false;
  for (const dictionary of dictionaries) {
    if (!dictionary) continue;
    const key = JSON.stringify(dictionary);
    if (added.has(key)) continue;
    added.add(key);
    for (const [zhText, enText] of Object.entries(dictionary)) {
      if (typeof enText !== "string" || !enText.trim() || /[\u4e00-\u9fff]/.test(enText) || /^\s*(\{\d+\}\s*)+$/.test(enText) || Object.hasOwn(en, zhText)) continue;
      en[zhText] = enText; zh[zhText] = zhText; changed = true;
    }
  }
  if (!changed) return;
  patterns = buildPatterns();
  // The host keeps its own copy of the dictionaries; register them again so `t()` knows the new entries.
  if (service) { registered?.(); registered = service.register("bkms-workbench", { zh, en }); }
  notify();
}

/** Translate only recognized system messages, never arbitrary mail or user-authored content. */
export function systemMessage(message: string): string {
  if (Object.hasOwn(en, message)) return t(message);
  for (const pattern of patterns) {
    const match = pattern.regex.exec(message);
    if (!match) continue;
    const values: string[] = [];
    pattern.indices.forEach((index, position) => { values[index] = match[position + 1]; });
    // Nested system errors are recognized separately; mailbox paths and workflow names stay verbatim.
    if (pattern.key === "{0} / {1} 检查失败：{2}") values[2] = systemMessage(values[2]);
    if (pattern.key === "DSH 处理未完成：{0}") values[0] = systemMessage(values[0]);
    return t(pattern.key, ...values);
  }
  return message;
}
