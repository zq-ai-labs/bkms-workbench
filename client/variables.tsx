import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { t } from "./i18n";
import { Field } from "./ui";

/** Your profile, filled into `{{user.*}}` and given to the AI as context. Mirrors src/context-vars.ts. */
export type Profile = { name?: string; department?: string; role?: string; title?: string; phone?: string; company?: string; signature?: string; timezone?: string };
/** Variables a workflow's instructions may use, with what each one is. */
export const VARIABLE_LABELS: [string, string][] = [
  ["user.name", "姓名"], ["user.department", "部门"], ["user.role", "角色"], ["user.title", "职务"], ["user.phone", "电话"], ["user.company", "公司"], ["user.signature", "签名"],
  ["today", "今天（日期和星期）"], ["now", "现在（日期和时间）"], ["weekday", "星期"], ["timezone", "时区"], ["mailbox", "当前邮箱"],
];
const NAMES = new Set(VARIABLE_LABELS.map(([name]) => name));
const REFERENCE = /\{\{\s*([^{}\s]+)\s*\}\}/g;
const systemZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
const validZone = (zone: string) => { try { new Intl.DateTimeFormat("en", { timeZone: zone }); return true; } catch { return false; } };

export const unknownVariables = (text: string): string[] => [...new Set([...text.matchAll(REFERENCE)].map(match => match[1]).filter(name => !NAMES.has(name)))];
/** What the AI will read: known variables filled in, unknown ones left as written. Same rules as the server. */
export function previewVariables(text: string, profile: Profile | undefined, mailbox: string, en: boolean, at = new Date()): string {
  const zone = profile?.timezone && validZone(profile.timezone) ? profile.timezone : systemZone();
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at).map(part => [part.type, part.value]));
  const weekday = new Intl.DateTimeFormat(en ? "en-US" : "zh-CN", { timeZone: zone, weekday: en ? "short" : "long" }).format(at);
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const missing = (key: string) => en ? `[not set: ${key}]` : `[未设置：${key}]`;
  const user = (key: keyof Profile) => profile?.[key] || missing(`user.${key}`);
  const values: Record<string, string> = {
    "user.name": user("name"), "user.department": user("department"), "user.role": user("role"), "user.title": user("title"), "user.phone": user("phone"), "user.company": user("company"), "user.signature": user("signature"),
    today: en ? `${date} (${weekday})` : `${date}（${weekday}）`, now: `${date} ${parts.hour}:${parts.minute}`, weekday, timezone: zone, mailbox: mailbox || missing("mailbox"),
  };
  return text.replace(REFERENCE, (whole, name: string) => values[name] ?? whole);
}

/**
 * Typing "/" in a text field lists the variables; arrows choose, Enter or Tab inserts, Esc closes. Typing after the
 * "/" filters by name or meaning. The "/" is replaced by `{{name}}`. A "/" in ordinary text (a folder path) that
 * matches nothing simply closes the list.
 */
export function useVariableMenu(text: string, onText: (next: string) => void) {
  const [menu, setMenu] = useState<{ start: number; query: string; index: number }>();
  const field = useRef<HTMLTextAreaElement | null>(null);
  const query = menu?.query.toLowerCase() ?? "";
  const options = menu ? VARIABLE_LABELS.filter(([name, label]) => !query || name.toLowerCase().includes(query) || t(label).toLowerCase().includes(query)) : [];
  const close = () => setMenu(undefined);
  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>) => {
    const element = event.target, caret = element.selectionStart, value = element.value;
    field.current = element;
    if (value.length === text.length + 1 && value[caret - 1] === "/") { setMenu({ start: caret - 1, query: "", index: 0 }); return; }
    if (!menu) return;
    const typed = value.slice(menu.start + 1, caret);
    if (caret <= menu.start || value[menu.start] !== "/" || /\s/.test(typed) || typed.length > 30) close();
    else setMenu({ ...menu, query: typed, index: 0 });
  };
  const pick = (name: string) => {
    if (!menu) return;
    const reference = `{{${name}}}`, end = menu.start + 1 + menu.query.length, at = menu.start + reference.length;
    onText(text.slice(0, menu.start) + reference + text.slice(end));
    close();
    requestAnimationFrame(() => { const element = field.current; if (element) { element.focus(); element.setSelectionRange(at, at); } });
  };
  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    field.current = event.currentTarget;
    if (!menu || !options.length) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const step = event.key === "ArrowDown" ? 1 : -1; setMenu({ ...menu, index: (menu.index + step + options.length) % options.length }); }
    else if (event.key === "Enter" || event.key === "Tab") { event.preventDefault(); pick(options[Math.min(menu.index, options.length - 1)][0]); }
    else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  };
  const element = menu && options.length ? <div className="bkw-var-menu" role="listbox" aria-label={t("插入变量")}>
    {options.map(([name, label], index) => <button type="button" role="option" key={name} aria-selected={index === menu.index} className={`bkw-var-option ${index === menu.index ? "on" : ""}`}
      onMouseDown={event => { event.preventDefault(); pick(name); }}><code>{`{{${name}}}`}</code><small>{t(label)}</small></button>)}
  </div> : null;
  return { onChange, onKeyDown, close, menu: element };
}

const FIELDS: [keyof Profile, string, string][] = [
  ["name", "姓名", "例如：赵晓强"], ["department", "部门", "例如：客户服务部"], ["role", "角色", "例如：客服主管"], ["title", "职务", "例如：高级经理"],
  ["phone", "电话", "例如：0755-1234 5678"], ["company", "公司", "例如：深圳某某科技有限公司"],
];
/** Settings › My profile. Not for passwords or keys: everything here is shown to the AI. */
export function ProfileCard({ value, disabled, save }: { value?: Profile; disabled: boolean; save: (profile: Profile) => void }) {
  const [draft, setDraft] = useState<Profile>(value ?? {});
  useEffect(() => setDraft(value ?? {}), [JSON.stringify(value ?? {})]);
  const dirty = JSON.stringify(draft) !== JSON.stringify(value ?? {});
  const set = (key: keyof Profile, text: string) => setDraft(current => { const next = { ...current }; if (text) next[key] = text; else delete next[key]; return next; });
  return <form className="bkw-profile" onSubmit={event => { event.preventDefault(); save(draft); }}>
    <p className="bkw-muted">{t("处理要求里可以用 {{user.name}} 等变量引用这些资料；AI 处理时也会知道你是谁、现在几点。不要填写密码或密钥。")}</p>
    <div className="bkw-grid2">
      {FIELDS.map(([key, label, hint]) => <Field key={key} label={t(label)}><input maxLength={200} value={draft[key] ?? ""} disabled={disabled} onChange={event => set(key, event.target.value)} placeholder={t(hint)} /></Field>)}
      <Field label={t("时区")} hint={t("不填时使用电脑的时区：{0}", systemZone())}><input maxLength={80} value={draft.timezone ?? ""} disabled={disabled} onChange={event => set("timezone", event.target.value)} placeholder={systemZone()} /></Field>
    </div>
    <Field label={t("签名")} hint={t("回复草稿需要落款时使用；不填时 AI 不会编造签名。")}><textarea rows={3} maxLength={1000} value={draft.signature ?? ""} disabled={disabled} onChange={event => set("signature", event.target.value)} /></Field>
    <div className="bkw-actions">{dirty && <small className="bkw-muted">{t("有未保存的修改")}</small>}<button type="submit" className="bkw-btn small primary" disabled={disabled || !dirty}>{t("保存我的资料")}</button></div>
  </form>;
}
