import * as React from "react";
import { useEffect, useMemo, useState } from "react";
import { systemMessage, t } from "./i18n";
import { useWorkbench } from "./context";
import { api, errorMessage, fullDate, statusLabel, time, when, type Task, type WechatChat, type WechatList, type WechatMessage, type WechatSettings } from "./lib";
import { Alert, Empty, Icon, Modal, StatusTag, Switch, Tag } from "./ui";

export const DEFAULT_WECHAT: WechatSettings = { enabled: false, people: { mode: "allow", list: [] }, groups: { mode: "allow", list: [], scope: "mention" } };
const SYSTEM_TYPE = "系统消息";
const AVATAR = ["#5B8FF9", "#E8684A", "#9270CA", "#F6BD16", "#5D7092", "#6DC8EC", "#269A99", "#FF9D4D"];
const avatarColor = (id: string) => AVATAR[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % AVATAR.length];
const isGroup = (id: string) => id.endsWith("@chatroom");
const isOther = (id: string) => !id || id.startsWith("gh_") || id.startsWith("@") || ["filehelper", "weixin", "fmessage", "medianote", "notifymessage", "newsapp"].includes(id);
/** Mirrors the backend rule: allow lists read only the listed chats, block lists read everything else. */
export function chatAllowed(settings: WechatSettings | undefined, id: string): boolean {
  if (!settings?.enabled || isOther(id)) return false;
  const list = isGroup(id) ? settings.groups : settings.people;
  return list.mode === "allow" ? list.list.includes(id) : !list.list.includes(id);
}
const initial = (name: string) => [...(name || "?").replace(/[\s·@]/g, "")][0] || "?";

/** A WeChat-style transcript: others on the left, you on the right in green. */
export function Bubbles({ messages, group, highlight, after }: { messages: WechatMessage[]; group: boolean; highlight?: (message: WechatMessage) => boolean; after?: (message: WechatMessage) => React.ReactNode }) {
  let last = 0;
  return <div className="bkw-chat">
    {messages.map(message => {
      const at = Date.parse(message.at), gap = !last || at - last > 5 * 60000;
      if (Number.isFinite(at)) last = at;
      const day = when(message.at), clock = time(message.at);
      const stamp = gap && Number.isFinite(at) ? <div className="bkw-chat-time">{day === clock ? clock : `${day} ${clock}`}</div> : null;
      if (message.type === SYSTEM_TYPE) return <React.Fragment key={message.seq}>{stamp}<div className="bkw-chat-system">{message.text}</div>{after?.(message)}</React.Fragment>;
      const name = message.self ? t("我") : message.senderName || message.sender;
      return <React.Fragment key={message.seq}>{stamp}
        <div className={`bkw-msg ${message.self ? "me" : ""} ${highlight?.(message) ? "hl" : ""}`}>
          <span className="bkw-avatar" style={{ background: message.self ? "var(--acc)" : avatarColor(message.sender || name) }} aria-hidden="true">{initial(name)}</span>
          <div className="bkw-msg-body">
            {group && !message.self && <span className="bkw-msg-who">{name}{message.mentionsMe && <Tag tone="accent">{t("@我")}</Tag>}</span>}
            <div className="bkw-bubble">{message.text}{message.quote && <span className="bkw-quote">{message.quote.sender ? `${message.quote.sender}：` : ""}{message.quote.text}</span>}</div>
          </div>
        </div>
        {after?.(message)}
      </React.Fragment>;
    })}
  </div>;
}

/** The messages that make up one WeChat task. */
export function SegmentConversation({ task }: { task: Task }) {
  const segment = task.wechat!;
  return <section className="bkw-block bkw-chat-block" aria-label={t("对话")}>
    <h3>{segment.group ? t("群聊 · {0}", segment.chatName) : t("与 {0} 的对话", segment.chatName)}<small>{t("{0} 条消息", segment.messages.length)}</small></h3>
    <Bubbles messages={segment.messages} group={segment.group} highlight={message => !!message.mentionsMe} />
  </section>;
}

/** Full chat history of an allowed conversation, read page by page, with the tasks found in it marked inline. */
export function ChatHistory({ chat, group, current }: { chat: string; group: boolean; current?: string }) {
  const { data, go } = useWorkbench();
  const [pages, setPages] = useState(1), [state, setState] = useState<{ messages: WechatMessage[]; more: boolean }>(), [error, setError] = useState(""), [loading, setLoading] = useState(false);
  const tasks = useMemo(() => data.tasks.filter(task => task.wechat?.chat === chat), [data.tasks, chat]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError("");
    api<{ messages: WechatMessage[]; more: boolean }>("wechatHistory", { chat, offset: 0, limit: 50 * pages }, controller.signal)
      .then(setState).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [chat, pages, data.tasks.length]);
  if (error) return <Alert tone="danger">{systemMessage(error)}</Alert>;
  if (!state) return <p className="bkw-muted">{t("正在读取聊天记录…")}</p>;
  return <div className="bkw-history">
    {state.more && <button type="button" className="bkw-btn small ghost bkw-history-more" disabled={loading} onClick={() => setPages(pages + 1)}>{loading ? t("读取中…") : t("加载更早的消息")}</button>}
    {!state.messages.length && <p className="bkw-muted">{t("这个会话还没有消息。")}</p>}
    <Bubbles messages={state.messages} group={group}
      highlight={message => tasks.some(task => task.id === current && message.seq >= task.wechat!.fromSeq && message.seq <= task.wechat!.toSeq)}
      after={message => tasks.filter(task => task.wechat!.toSeq === message.seq).map(task => <button key={task.id} type="button" className={`bkw-chat-marker ${task.id === current ? "on" : ""}`} onClick={() => go({ view: "items", task: task.id })}>
        <span className="bkw-chat-marker-icon"><Icon name="sparkle" size={14} /></span>
        <span><strong>{t("事项 · {0}", task.title)}</strong><small>{task.triage?.nextStep || task.summary?.split("\n")[0] || statusLabel(task)}</small></span>
        <StatusTag task={task} />
      </button>)} />
  </div>;
}

/** Conversations view: read allowed chats like WeChat, with AI findings inline. */
export function ChatsView() {
  const { data, go, perform, refresh, notify } = useWorkbench();
  const settings = data.wechat?.settings;
  const [chats, setChats] = useState<WechatChat[]>(), [error, setError] = useState(""), [selected, setSelected] = useState<string>(), [search, setSearch] = useState("");
  useEffect(() => {
    if (!settings?.enabled) return;
    const controller = new AbortController();
    api<WechatChat[]>("wechatChats", {}, controller.signal).then(setChats).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); });
    return () => controller.abort();
  }, [settings?.enabled, data.revision]);
  if (!settings?.enabled) return <div className="bkw-pad"><Empty icon="chat" title={t("微信读取未开启")} text={t("在设置中开启微信读取，并选择要处理的联系人和群聊。工作台只读，不会代你发送。")}><button type="button" className="bkw-btn primary" onClick={() => go({ view: "settings" })}>{t("前往设置")}</button></Empty></div>;
  const visible = (chats || []).filter(chat => chatAllowed(settings, chat.id));
  // Listed chats that are not among recent sessions still appear.
  for (const id of [...(settings.people.mode === "allow" ? settings.people.list : []), ...(settings.groups.mode === "allow" ? settings.groups.list : [])]) if (!visible.some(chat => chat.id === id)) visible.push({ id, name: settings.names?.[id] || id, kind: isGroup(id) ? "group" : "person" });
  const list = visible.filter(chat => chat.name.toLowerCase().includes(search.trim().toLowerCase()));
  const current = list.find(chat => chat.id === selected) || list[0];
  const tasks = (id: string) => data.tasks.filter(task => task.wechat?.chat === id);
  const open = (id: string) => tasks(id).filter(task => task.attention).length;
  const stop = (chat: WechatChat) => perform("wechatStop", async () => {
    const key = chat.kind === "group" ? "groups" : "people", target = settings[key];
    const next = { ...settings, [key]: { ...target, list: target.mode === "allow" ? target.list.filter(id => id !== chat.id) : [...target.list, chat.id] }, names: { ...(settings.names || {}), [chat.id]: chat.name } };
    await api("saveSettings", { revision: data.revision, settings: { wechat: next } });
    await refresh(); notify(t("已停止处理“{0}”", chat.name));
  });
  return <div className="bkw-chats">
    <section className="bkw-chat-list" aria-label={t("会话列表")}>
      <label className="bkw-search"><Icon name="search" size={15} /><input placeholder={t("搜索会话")} aria-label={t("搜索会话")} value={search} onChange={event => setSearch(event.target.value)} /></label>
      {error && <Alert tone="danger">{systemMessage(error)}</Alert>}
      {!chats && !error && <p className="bkw-muted">{t("正在读取会话…")}</p>}
      {chats && !list.length && <p className="bkw-muted">{t("名单里还没有会话。")}</p>}
      {list.map(chat => <button type="button" key={chat.id} className={`bkw-chat-item ${chat.id === current?.id ? "on" : ""}`} aria-current={chat.id === current?.id} onClick={() => setSelected(chat.id)}>
        <span className="bkw-avatar" style={{ background: avatarColor(chat.id) }} aria-hidden="true">{chat.kind === "group" ? t("群") : initial(chat.name)}</span>
        <span className="bkw-chat-item-main"><span><strong>{chat.name}</strong><time>{chat.lastAt ? when(chat.lastAt) : ""}</time></span>
          <small>{open(chat.id) ? <Tag tone="warn">{t("{0} 件待处理", open(chat.id))}</Tag> : tasks(chat.id).length ? <Tag>{t("{0} 个事项", tasks(chat.id).length)}</Tag> : chat.kind === "group" && settings.groups.scope === "mention" ? t("只处理 @我") : t("所有消息")}</small></span>
      </button>)}
      <p className="bkw-footnote">{t("只显示名单允许的会话；公众号和服务通知不会出现。")}</p>
    </section>
    <section className="bkw-chat-main" aria-label={t("聊天记录")}>
      {current ? <>
        <header className="bkw-chat-head"><strong>{current.name}</strong><small>{current.kind === "group" ? t("微信群聊") : t("微信私聊")} · {t("只读")}</small></header>
        <div className="bkw-chat-scroll"><ChatHistory key={current.id} chat={current.id} group={current.kind === "group"} /></div>
      </> : <Empty icon="chat" title={t("选择一个会话")} text={t("左侧列出名单允许读取的联系人和群聊。")} />}
    </section>
    {current && <aside className="bkw-chat-side" aria-label={t("会话信息")}>
      <div className="bkw-chat-profile"><span className="bkw-avatar large" style={{ background: avatarColor(current.id) }} aria-hidden="true">{current.kind === "group" ? t("群") : initial(current.name)}</span><div><strong>{current.name}</strong><small>{current.kind === "group" ? (settings.groups.scope === "mention" ? t("群聊 · 只处理 @我 的消息") : t("群聊 · 处理所有消息")) : t("私聊 · 处理所有消息")}</small></div></div>
      <h4>{t("本会话事项")}</h4>
      {tasks(current.id).length ? tasks(current.id).map(task => <button type="button" key={task.id} className="bkw-chat-task" onClick={() => go({ view: "items", task: task.id })}><span>{task.title}</span><StatusTag task={task} /></button>) : <p className="bkw-muted">{t("还没有从这个会话识别出事项。")}</p>}
      <h4>{t("处理范围")}</h4>
      <p className="bkw-muted">{t("对方停顿 {0} 分钟后，连发的几条消息算作一件事处理。你已在微信里回复过的不会再提醒。", settings.quietMinutes)}</p>
      <div className="bkw-actions"><button type="button" className="bkw-btn small" onClick={() => stop(current)}>{t("不再处理这个会话")}</button><button type="button" className="bkw-btn small ghost" onClick={() => go({ view: "settings" })}>{t("名单设置")}</button></div>
    </aside>}
  </div>;
}

type ListKey = "people" | "groups";
const EMPTY_HINT: Record<string, string> = { "people-allow": "名单为空：不处理任何联系人。", "people-block": "名单为空：处理全部联系人。", "groups-allow": "名单为空：不处理任何群聊。", "groups-block": "名单为空：处理全部群聊。" };
const MODE_HINT: Record<string, string> = { allow: "白名单：只处理名单里的会话", block: "黑名单：处理名单以外的全部会话" };

/** WeChat source settings: enable, allow/block lists for people and groups, timing and local cache. */
export function WechatSettingsCard({ value, disabled, save }: { value?: WechatSettings; disabled: boolean; save: (wechat: WechatSettings, message?: string) => Promise<void> }) {
  const settings: WechatSettings = value ? { ...DEFAULT_WECHAT, ...value } : DEFAULT_WECHAT;
  const [status, setStatus] = useState<{ ready: boolean; name?: string; library?: string; error?: string }>(), [checking, setChecking] = useState(false);
  const [picker, setPicker] = useState<ListKey>(), [clearing, setClearing] = useState(false), [python, setPython] = useState(settings.python || ""), [library, setLibrary] = useState(settings.library || "");
  const check = (signal?: AbortSignal) => { setChecking(true); return api<typeof status>("wechatStatus", {}, signal).then(setStatus).catch(failure => { if (!signal?.aborted) setStatus({ ready: false, error: errorMessage(failure) }); }).finally(() => setChecking(false)); };
  useEffect(() => { if (!settings.enabled) { setStatus(undefined); return; } const controller = new AbortController(); void check(controller.signal); return () => controller.abort(); }, [settings.enabled, settings.python, settings.library]);
  useEffect(() => { setPython(settings.python || ""); setLibrary(settings.library || ""); }, [settings.python, settings.library]);
  const update = (patch: Partial<WechatSettings>, message?: string) => save({ ...settings, ...patch }, message);
  const names = settings.names || {};
  const list = (key: ListKey) => {
    const current = settings[key];
    return <div className="bkw-wx-list">
      <div className="bkw-wx-list-head">
        <strong>{key === "people" ? t("联系人") : t("群聊")}</strong>
        <div className="bkw-seg" role="radiogroup" aria-label={key === "people" ? t("联系人名单方式") : t("群聊名单方式")}>
          {(["allow", "block"] as const).map(mode => <button key={mode} type="button" role="radio" aria-checked={current.mode === mode} className={current.mode === mode ? "on" : ""} disabled={disabled} onClick={() => current.mode !== mode && update({ [key]: { ...current, mode, list: [] } } as Partial<WechatSettings>, mode === "allow" ? t("已改为白名单，名单已清空") : t("已改为黑名单，名单已清空"))}>{mode === "allow" ? t("白名单") : t("黑名单")}</button>)}
        </div>
      </div>
      <small className="bkw-muted">{t(MODE_HINT[current.mode])}{current.mode === "block" && key === "people" ? t("；公众号与服务通知始终不处理。") : ""}</small>
      <div className="bkw-chips">
        {current.list.map(id => <span key={id} className="bkw-chip">{names[id] || id}<button type="button" className="bkw-icon-btn small" aria-label={t("移除 {0}", names[id] || id)} disabled={disabled} onClick={() => update({ [key]: { ...current, list: current.list.filter(item => item !== id) } } as Partial<WechatSettings>)}><Icon name="close" size={12} /></button></span>)}
        <button type="button" className="bkw-btn small" disabled={disabled || !settings.enabled} onClick={() => setPicker(key)}><Icon name="plus" size={13} />{t("添加")}</button>
        {!current.list.length && <span className="bkw-muted">{t(EMPTY_HINT[`${key}-${current.mode}`])}</span>}
      </div>
      {key === "groups" && <label className="bkw-wx-scope">{t("群里处理")}<select value={settings.groups.scope} disabled={disabled} onChange={event => update({ groups: { ...settings.groups, scope: event.target.value as "mention" | "all" } })}><option value="mention">{t("只处理 @我 和引用我的消息")}</option><option value="all">{t("所有消息")}</option></select></label>}
    </div>;
  };
  const tone = !settings.enabled ? "muted" : status?.ready ? "good" : checking || !status ? "muted" : "danger";
  return <>
    <div className="bkw-set-row"><span className="bkw-source-icon">{t("微")}</span><span><strong>{t("微信")}</strong><small>{!settings.enabled ? t("只读：读取本机已登录的 Windows 微信 4.x 聊天记录，按名单处理，不会代你发送。") : checking ? t("正在连接本机微信…") : status?.ready ? t("已连接：{0} · 读取组件 {1}", status.name || "", status.library || "") : status?.error ? systemMessage(status.error) : t("等待连接")}</small></span>
      <span className="bkw-set-control"><Tag tone={tone}>{!settings.enabled ? t("未开启") : status?.ready ? t("正常") : checking ? t("连接中") : t("未连接")}</Tag><Switch label={t("微信读取")} checked={settings.enabled} disabled={disabled} onChange={enabled => update({ enabled }, enabled ? t("已开启微信读取，请添加要处理的会话") : t("已关闭微信读取"))} /></span>
    </div>
    {settings.enabled && <div className="bkw-wx-panel">
      {status && !status.ready && !checking && <Alert tone="warn">{t("读取不到微信时请检查：微信 4.x 已登录，并已安装 64 位 Python 3.9 或更高版本。Python 命令不是 py -3 时，可在下方“读取组件”中填写。")}<button type="button" className="bkw-link" onClick={() => void check()}>{t("重新检测")}</button></Alert>}
      {list("people")}
      {list("groups")}
      <div className="bkw-wx-row"><span><strong>{t("合并连续消息")}</strong><small>{t("对方停顿多久后，把连发的几条消息作为一件事处理。")}</small></span>
        <select aria-label={t("合并连续消息")} value={settings.quietMinutes ?? 3} disabled={disabled} onChange={event => update({ quietMinutes: Number(event.target.value) })}>{[1, 3, 5, 10].map(value => <option key={value} value={value}>{t("{0} 分钟", value)}</option>)}</select></div>
      <details className="bkw-details"><summary>{t("读取组件")}<small>{settings.python || settings.library ? t("已自定义") : t("默认：py -3，使用内置读取组件")}</small></summary>
        <form className="bkw-wx-form" onSubmit={event => { event.preventDefault(); const next: WechatSettings = { ...settings }; if (python.trim()) next.python = python.trim(); else delete next.python; if (library.trim()) next.library = library.trim(); else delete next.library; void save(next); }}>
          <label>{t("Python 命令")}<input value={python} placeholder="py -3" disabled={disabled} onChange={event => setPython(event.target.value)} /></label>
          <label>{t("上游 wechatauto-replica 目录（可选：微信升级后临时改用上游的修复）")}<input value={library} placeholder={t("留空即可")} disabled={disabled} onChange={event => setLibrary(event.target.value)} /></label>
          <div className="bkw-actions"><button type="submit" className="bkw-btn small" disabled={disabled || (python === (settings.python || "") && library === (settings.library || ""))}>{t("保存")}</button></div>
        </form>
      </details>
      <div className="bkw-wx-row"><span><strong>{t("本地解密缓存")}</strong><small>{t("为了读取聊天记录，解密后的数据库副本保存在本机工作台数据目录。清除后下次读取时重新生成。")}</small></span><button type="button" className="bkw-btn small" disabled={disabled} onClick={() => setClearing(true)}>{t("清除")}</button></div>
      <p className="bkw-footnote">{t("只有名单允许的会话中相关的几条消息会交给 AI 处理；其他会话只读取名称和最后消息时间。")}</p>
    </div>}
    {picker && <ChatPicker kind={picker} existing={settings[picker].list} onClose={() => setPicker(undefined)} onAdd={chosen => { setPicker(undefined); const current = settings[picker]; void update({ [picker]: { ...current, list: [...current.list, ...chosen.map(chat => chat.id).filter(id => !current.list.includes(id))] }, names: { ...names, ...Object.fromEntries(chosen.map(chat => [chat.id, chat.name])) } } as Partial<WechatSettings>, t("已添加 {0} 个会话", chosen.length)); }} />}
    {clearing && <Modal title={t("清除本地解密缓存？")} onClose={() => setClearing(false)}>
      <p className="bkw-dialog-description">{t("会停止微信读取进程并删除解密后的数据库副本和缓存的密钥，不影响微信本身和工作台里的事项。下次读取时需要微信保持登录，重新生成约需几秒到一分钟。")}</p>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" onClick={() => setClearing(false)}>{t("取消")}</button><button type="button" className="bkw-btn primary" onClick={async () => { setClearing(false); try { await api("clearWechatCache", { confirmed: true }); setStatus(undefined); void check(); } catch (failure) { setStatus({ ready: false, error: errorMessage(failure) }); } }}>{t("确认清除")}</button></div>
    </Modal>}
  </>;
}

function ChatPicker({ kind, existing, onClose, onAdd }: { kind: ListKey; existing: string[]; onClose: () => void; onAdd: (chats: WechatChat[]) => void }) {
  const [chats, setChats] = useState<WechatChat[]>(), [error, setError] = useState(""), [query, setQuery] = useState(""), [found, setFound] = useState<WechatChat[]>([]), [chosen, setChosen] = useState<WechatChat[]>([]);
  useEffect(() => { const controller = new AbortController(); api<WechatChat[]>("wechatChats", {}, controller.signal).then(setChats).catch(failure => { if (!controller.signal.aborted) setError(errorMessage(failure)); }); return () => controller.abort(); }, []);
  const want = kind === "groups" ? "group" : "person";
  const q = query.trim().toLowerCase();
  const pool = [...(chats || []), ...found].filter((chat, index, all) => chat.kind === want && !existing.includes(chat.id) && all.findIndex(item => item.id === chat.id) === index && (!q || chat.name.toLowerCase().includes(q) || chat.id.toLowerCase().includes(q))).slice(0, 200);
  const toggle = (chat: WechatChat) => setChosen(chosen.some(item => item.id === chat.id) ? chosen.filter(item => item.id !== chat.id) : [...chosen, chat]);
  return <Modal title={kind === "groups" ? t("添加群聊") : t("添加联系人")} onClose={onClose}>
    <form className="bkw-inline-form" onSubmit={event => { event.preventDefault(); if (!q) return; void api<WechatChat[]>("wechatSearch", { q: query.trim() }).then(setFound).catch(failure => setError(errorMessage(failure))); }}>
      <input autoFocus aria-label={t("搜索名称或备注")} placeholder={t("搜索名称或备注，回车查找更多")} value={query} onChange={event => setQuery(event.target.value)} />
      <button type="submit" className="bkw-btn small" disabled={!q}>{t("查找")}</button>
    </form>
    {error && <Alert tone="danger">{systemMessage(error)}</Alert>}
    <div className="bkw-pick-list">
      {!chats && !error && <p className="bkw-muted">{t("正在读取会话…")}</p>}
      {chats && !pool.length && <p className="bkw-muted">{t("没有找到，可输入名称后回车查找。")}</p>}
      {pool.map(chat => <label key={chat.id} className="bkw-pick"><input type="checkbox" checked={chosen.some(item => item.id === chat.id)} onChange={() => toggle(chat)} /><span className="bkw-avatar small" style={{ background: avatarColor(chat.id) }} aria-hidden="true">{chat.kind === "group" ? t("群") : initial(chat.name)}</span><span><strong>{chat.name}</strong><small>{chat.lastAt ? t("最近消息 {0}", fullDate(chat.lastAt)) : chat.id}</small></span></label>)}
    </div>
    <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" onClick={onClose}>{t("取消")}</button><button type="button" className="bkw-btn primary" disabled={!chosen.length} onClick={() => onAdd(chosen)}>{t("添加 {0} 个", chosen.length)}</button></div>
  </Modal>;
}
