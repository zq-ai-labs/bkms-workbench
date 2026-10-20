import * as React from "react";
import { useEffect, useState } from "react";
import { systemMessage, t } from "./i18n";
import { api, errorMessage } from "./lib";
import { Alert, Field, Icon, Modal, Tag } from "./ui";

type Endpoint = { host: string; port: number; secure: boolean };
export type MailAccountView = { id: string; provider: string; user: string; senderName?: string; authUser?: string; imap?: Endpoint; smtp?: Endpoint; inboxFolder?: string; trusted?: string[]; blocked?: string[]; hasPassword: boolean; isDefault: boolean };
type Accounts = { revision: number; accounts: MailAccountView[]; providers: string[]; presets: Record<string, { imap: Endpoint; smtp: Endpoint }>; externalPlugin: boolean };
type TestResult = { imap: { ok: boolean; host: string; error?: string }; smtp: { ok: boolean; host: string; error?: string } };
type Draft = { id?: string; provider: string; user: string; password: string; senderName: string; authUser: string; inboxFolder: string; imap: { host: string; port: string; secure: boolean }; smtp: { host: string; port: string; secure: boolean }; trusted: string; blocked: string; hasPassword: boolean };

const PROVIDER_LABEL: Record<string, string> = { qq: "QQ 邮箱", exmail: "腾讯企业邮箱", "163": "网易 163 邮箱", "126": "网易 126 邮箱", aliyun: "阿里邮箱", gmail: "Gmail", icloud: "iCloud 邮箱", sina: "新浪邮箱", custom: "其他邮箱（手动填写服务器）" };
const AUTH_HINT: Record<string, string> = {
  qq: "在 QQ 邮箱网页版“设置 → 账号”中开启 IMAP/SMTP 服务，按提示生成授权码。",
  exmail: "在腾讯企业邮箱“设置 → 客户端设置”中开启 IMAP/SMTP，并在“账户安全”中生成客户端专用密码。",
  "163": "在网易邮箱“设置 → POP3/SMTP/IMAP”中开启 IMAP/SMTP 服务，按提示生成授权码。",
  "126": "在网易邮箱“设置 → POP3/SMTP/IMAP”中开启 IMAP/SMTP 服务，按提示生成授权码。",
  gmail: "在 Google 账号中开启两步验证后，创建“应用专用密码”。",
  icloud: "在 Apple 账户的“登录与安全”中生成 App 专用密码。",
};
const toDraft = (account?: MailAccountView, provider = "qq"): Draft => ({
  id: account?.id, provider: account?.provider ?? provider, user: account?.user ?? "", password: "", senderName: account?.senderName ?? "", authUser: account?.authUser ?? "", inboxFolder: account?.inboxFolder ?? "",
  imap: { host: account?.imap?.host ?? "", port: String(account?.imap?.port ?? 993), secure: account?.imap?.secure ?? true },
  smtp: { host: account?.smtp?.host ?? "", port: String(account?.smtp?.port ?? 465), secure: account?.smtp?.secure ?? true },
  trusted: (account?.trusted ?? []).join("\n"), blocked: (account?.blocked ?? []).join("\n"), hasPassword: account?.hasPassword ?? false,
});
const payload = (draft: Draft) => ({
  ...(draft.id ? { id: draft.id } : {}), provider: draft.provider, user: draft.user.trim(), password: draft.password, senderName: draft.senderName, authUser: draft.authUser, inboxFolder: draft.inboxFolder,
  imap: draft.imap.host.trim() ? { host: draft.imap.host.trim(), port: Number(draft.imap.port), secure: draft.imap.secure } : null,
  smtp: draft.smtp.host.trim() ? { host: draft.smtp.host.trim(), port: Number(draft.smtp.port), secure: draft.smtp.secure } : null,
  trusted: draft.trusted, blocked: draft.blocked,
});

/** Built-in mailbox accounts on the workbench settings page. Passwords are written, never read back. */
export function MailAccountsCard({ status, tone, label, disabled, onChanged }: { status: React.ReactNode; tone: "good" | "warn" | "muted" | "danger"; label: string; disabled: boolean; onChanged: () => void }) {
  const [data, setData] = useState<Accounts>(), [error, setError] = useState(""), [editing, setEditing] = useState<Draft>(), [removing, setRemoving] = useState<MailAccountView>(), [busy, setBusy] = useState(false);
  const load = (signal?: AbortSignal) => api<Accounts>("mailAccounts", {}, signal).then(setData).catch(failure => { if (!signal?.aborted) setError(errorMessage(failure)); });
  useEffect(() => { const controller = new AbortController(); void load(controller.signal); return () => controller.abort(); }, []);
  async function run(action: string, body: object, done?: () => void) {
    if (!data) return;
    setBusy(true); setError("");
    try { setData(await api<Accounts>(action, { ...body, revision: data.revision })); done?.(); onChanged(); }
    catch (failure) { setError(errorMessage(failure)); void load(); }
    finally { setBusy(false); }
  }
  const accounts = data?.accounts ?? [];
  return <>
    <div className="bkw-set-row"><span className="bkw-source-icon">{t("邮")}</span><span><strong>{t("邮箱")}</strong><small>{status}</small></span>
      <span className="bkw-set-control"><Tag tone={tone}>{label}</Tag><button type="button" className="bkw-btn small" disabled={disabled || !data} onClick={() => setEditing(toDraft())}><Icon name="plus" size={13} />{t("添加邮箱")}</button></span>
    </div>
    <div className="bkw-wx-panel">
      {data?.externalPlugin && <Alert tone="warn">{t("检测到仍安装了 dsh-email 插件。工作台已内置邮箱连接，同时保留两者会建立两套邮箱连接，并在对话中显示邮件工具。确认工作台收发正常后，请在 DSH 中卸载 dsh-email 并重启。")}</Alert>}
      {error && <Alert tone="danger" onClose={() => setError("")}>{systemMessage(error)}</Alert>}
      {!!accounts.length && <div className="bkw-mail-accounts">{accounts.map(account => <div key={account.id} className="bkw-mail-account">
        <span><strong>{account.user}{account.isDefault && accounts.length > 1 && <Tag tone="accent">{t("默认")}</Tag>}</strong>
          <small>{[t(PROVIDER_LABEL[account.provider] ?? account.provider), account.senderName ? t("发件人：{0}", account.senderName) : "", account.blocked?.length ? t("禁止发送 {0} 项", account.blocked.length) : "", account.trusted?.length ? t("可信收件人 {0} 项", account.trusted.length) : ""].filter(Boolean).join(" · ")}</small></span>
        {!account.isDefault && <button type="button" className="bkw-btn small" disabled={disabled || busy} onClick={() => void run("defaultMailAccount", { id: account.id })}>{t("设为默认")}</button>}
        <button type="button" className="bkw-btn small" disabled={disabled || busy} onClick={() => setEditing(toDraft(account))}>{t("编辑")}</button>
        <button type="button" className="bkw-icon-btn" aria-label={t("删除 {0}", account.user)} disabled={disabled || busy} onClick={() => setRemoving(account)}><Icon name="trash" size={15} /></button>
      </div>)}</div>}
      {data && !accounts.length && <p className="bkw-footnote">{t("添加邮箱后，工作台每隔一段时间检查新邮件。首次连接只建立基线，不处理已有邮件。")}</p>}
    </div>
    {editing && data && <AccountEditor draft={editing} data={data} busy={busy} onClose={() => { if (!busy) setEditing(undefined); }} onSave={draft => run("saveMailAccount", { account: payload(draft) }, () => setEditing(undefined))} />}
    {removing && <Modal title={t("删除邮箱账号？")} onClose={() => { if (!busy) setRemoving(undefined); }}>
      <p className="bkw-dialog-description">{t("删除后工作台不再检查 {0} 的新邮件，也不能再用它发送；已有事项和记录保留。之后重新添加时，只处理添加之后到达的新邮件。", removing.user)}</p>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" disabled={busy} onClick={() => setRemoving(undefined)}>{t("取消")}</button>
        <button type="button" className="bkw-btn danger-text" disabled={busy} onClick={() => void run("removeMailAccount", { id: removing.id, confirmed: true }, () => setRemoving(undefined))}>{t("确认删除")}</button></div>
    </Modal>}
  </>;
}

function AccountEditor({ draft: initial, data, busy, onClose, onSave }: { draft: Draft; data: Accounts; busy: boolean; onClose: () => void; onSave: (draft: Draft) => void }) {
  const [draft, setDraft] = useState(initial), [testing, setTesting] = useState(false), [result, setResult] = useState<TestResult>(), [error, setError] = useState("");
  const set = (patch: Partial<Draft>) => { setDraft(current => ({ ...current, ...patch })); setResult(undefined); };
  const custom = draft.provider === "custom", preset = data.presets[draft.provider];
  const server = (kind: "imap" | "smtp") => <div className="bkw-mail-server">
    <label>{kind === "imap" ? t("收信服务器（IMAP）") : t("发信服务器（SMTP）")}<input value={draft[kind].host} placeholder={preset?.[kind].host ?? (kind === "imap" ? "imap.example.com" : "smtp.example.com")} onChange={event => set({ [kind]: { ...draft[kind], host: event.target.value } } as Partial<Draft>)} /></label>
    <label>{t("端口")}<input type="number" min={1} max={65535} value={draft[kind].port} onChange={event => set({ [kind]: { ...draft[kind], port: event.target.value } } as Partial<Draft>)} /></label>
    <label className="bkw-checkbox"><input type="checkbox" checked={draft[kind].secure} onChange={event => set({ [kind]: { ...draft[kind], secure: event.target.checked } } as Partial<Draft>)} />SSL/TLS</label>
  </div>;
  async function test() {
    setTesting(true); setError(""); setResult(undefined);
    try { setResult(await api<TestResult>("testMailAccount", { account: payload(draft) })); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setTesting(false); }
  }
  const line = (name: string, value?: TestResult["imap"]) => value && <div className="bkw-mail-test"><Tag tone={value.ok ? "good" : "danger"}>{value.ok ? t("成功") : t("失败")}</Tag><span>{name} · {value.host}{value.error ? " · " + systemMessage(value.error) : ""}</span></div>;
  return <Modal title={draft.id ? t("编辑邮箱") : t("添加邮箱")} onClose={onClose} wide>
    <form className="bkw-mail-form" onSubmit={event => { event.preventDefault(); onSave(draft); }}>
      <Field label={t("邮箱服务商")} hint={t("Outlook / Microsoft 365 需要微软账号授权登录（OAuth2），将在后续版本支持。")}>
        <select value={draft.provider} onChange={event => set({ provider: event.target.value })}>{data.providers.map(name => <option key={name} value={name}>{t(PROVIDER_LABEL[name] ?? name)}</option>)}</select>
      </Field>
      <Field label={t("邮箱地址")}><input type="email" required autoComplete="off" value={draft.user} disabled={!!draft.id} placeholder="name@example.com" onChange={event => set({ user: event.target.value })} /></Field>
      <Field label={t("授权码")} hint={AUTH_HINT[draft.provider] ? t(AUTH_HINT[draft.provider]) : t("通常不是邮箱登录密码，而是在邮箱设置中开启 IMAP/SMTP 后生成的专用密码。")}>
        <input type="password" autoComplete="new-password" required={!draft.hasPassword} value={draft.password} placeholder={draft.hasPassword ? t("已保存，留空则不修改") : ""} onChange={event => set({ password: event.target.value })} />
      </Field>
      <Field label={t("发件人名称（可选）")} hint={t("收件人看到的名字，例如“知擎未来 商务部”。")}><input value={draft.senderName} onChange={event => set({ senderName: event.target.value })} /></Field>
      {custom && <>{server("imap")}{server("smtp")}</>}
      <details className="bkw-details"><summary>{t("发送限制")}<small>{t("可选：禁止发送的地址或域名，以及可信收件人")}</small></summary>
        <Field label={t("禁止发送到")} hint={t("每行一个邮箱地址或域名，例如 competitor.com。命中时工作台拒绝发送。")}><textarea rows={3} value={draft.blocked} onChange={event => set({ blocked: event.target.value })} /></Field>
        <Field label={t("可信收件人名单")} hint={t("每行一个邮箱地址或域名。发送预览中会标为可信，仍需你确认发送。")}><textarea rows={3} value={draft.trusted} onChange={event => set({ trusted: event.target.value })} /></Field>
      </details>
      {!custom && <details className="bkw-details"><summary>{t("高级")}<small>{t("服务器、登录名、收件箱文件夹；一般不需要修改")}</small></summary>
        {server("imap")}{server("smtp")}
        <Field label={t("登录名（可选）")} hint={t("登录名与邮箱地址不同时填写，例如别名邮箱。")}><input value={draft.authUser} onChange={event => set({ authUser: event.target.value })} /></Field>
        <Field label={t("收件箱文件夹（可选）")}><input value={draft.inboxFolder} placeholder="INBOX" onChange={event => set({ inboxFolder: event.target.value })} /></Field>
      </details>}
      {error && <Alert tone="danger" onClose={() => setError("")}>{systemMessage(error)}</Alert>}
      {result && <div className="bkw-mail-tests">{line(t("收信"), result.imap)}{line(t("发信"), result.smtp)}</div>}
      <div className="bkw-dialog-actions">
        <button type="button" className="bkw-btn" disabled={busy || testing || !draft.user.trim() || (!draft.password && !draft.hasPassword)} onClick={() => void test()}>{testing ? t("正在测试…") : t("测试连接")}</button>
        <span className="bkw-spacer" />
        <button type="button" className="bkw-btn" disabled={busy} onClick={onClose}>{t("取消")}</button>
        <button type="submit" className="bkw-btn primary" disabled={busy || testing}>{busy ? t("保存中…") : t("保存")}</button>
      </div>
    </form>
  </Modal>;
}
