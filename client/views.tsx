import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { systemMessage, t } from "./i18n";
import { useWorkbench } from "./context";
import { AUTONOMY_LABEL, CATEGORY, LABELS, api, counterpart, dayLabel, longDate, fullDate, minutesLeft, nextStep, senderName, sourceOf, statusLabel, taskTitle, time, urgencyRank, when, type Activity, type Status, type Task } from "./lib";
import { Empty, Icon, PageHeader, Section, SourceTag, StatusTag, Tag } from "./ui";
import { ChatsView } from "./wechat";
import { TaskWorkspace } from "./workspace";

const DAY = 864e5;
const greeting = () => { const hour = new Date().getHours(); return hour < 11 ? t("早上好") : hour < 14 ? t("中午好") : hour < 18 ? t("下午好") : t("晚上好"); };
const ACTIVITY: Record<string, { label: string; tone: "good" | "accent" | "muted" | "danger" | "warn" }> = {
  archive: { label: "归档", tone: "muted" }, auto_send_scheduled: { label: "待发送", tone: "accent" }, auto_sent: { label: "已回复", tone: "good" },
  auto_send_canceled: { label: "已撤回", tone: "muted" }, auto_send_blocked: { label: "未发送", tone: "danger" }, report: { label: "报告", tone: "good" },
  brief: { label: "简报", tone: "accent" }, weekly: { label: "周报", tone: "accent" }, topic: { label: "主题", tone: "accent" },
};
const activityText = (item: Activity): string => {
  switch (item.kind) {
    case "archive": return t("归档：{0}", item.title);
    case "auto_send_scheduled": return t("已起草回复，等待自动发送：{0}", item.title);
    case "auto_sent": return t("自动回复：{0}", item.title);
    case "auto_send_canceled": return t("已撤回自动回复：{0}", item.title);
    case "auto_send_blocked": return t("自动回复未发送，已转人工：{0}", item.title);
    case "report": return t("生成分析报告：{0}", item.title);
    case "brief": return t("生成今日简报");
    case "weekly": return t("生成周报草稿：{0}", item.title);
    case "topic": return t("更新主题报告：{0}", item.title);
    default: return item.title;
  }
};
const undoable = (item: Activity) => !item.undoneAt && !!item.taskId && (item.kind === "archive" || (item.kind === "auto_send_scheduled" && !!item.undoUntil && Date.parse(item.undoUntil) > Date.now()));

function ActivityRow({ item, compact }: { item: Activity; compact?: boolean }) {
  const { busy, perform, refresh, notify, go } = useWorkbench();
  const kind = ACTIVITY[item.kind] || { label: item.kind, tone: "muted" as const };
  return <div className={`bkw-activity ${item.undoneAt ? "undone" : ""}`}>
    {!compact && <time className="bkw-mono">{time(item.at)}</time>}
    <Tag tone={item.undoneAt ? "muted" : kind.tone}>{item.undoneAt ? t("已撤销") : t(kind.label)}</Tag>
    <div className="bkw-activity-main">
      <button type="button" className="bkw-activity-title" disabled={!item.taskId} onClick={() => item.taskId && go({ view: "items", task: item.taskId })}>{activityText(item)}</button>
      {!compact && <small>{[item.ruleName && t("方案「{0}」", item.ruleName), item.autonomy && t(AUTONOMY_LABEL[item.autonomy]), item.kind === "archive" && item.detail ? systemMessage(item.detail) : undefined].filter(Boolean).join(" · ")}</small>}
    </div>
    {item.kind === "auto_send_scheduled" && undoable(item) && <Tag tone="warn">{t("剩 {0} 分钟", minutesLeft(item.undoUntil))}</Tag>}
    {undoable(item) && <button type="button" className="bkw-btn small" disabled={!!busy} onClick={() => void perform(`undo-${item.id}`, async () => { await api("undoActivity", { activityId: item.id }); await refresh(); notify(item.kind === "archive" ? t("已恢复，该发件人的信息以后不再自动归档") : t("已撤回自动发送，转为人工审核")); })}>{item.kind === "archive" ? t("恢复") : t("撤回")}</button>}
  </div>;
}

export function TodayView() {
  const { data, busy, perform, refresh, notify, go } = useWorkbench();
  const decisions = data.tasks.filter(task => task.attention).sort((a, b) => urgencyRank(a) - urgencyRank(b) || b.receivedAt.localeCompare(a.receivedAt));
  const since = Date.now() - DAY;
  const recent = data.activity.filter(item => Date.parse(item.at) >= since && !item.undoneAt).sort((a, b) => b.at.localeCompare(a.at));
  const notable = data.tasks.filter(task => task.triage?.category === "fyi" && Date.parse(task.receivedAt) >= Date.now() - 2 * DAY).slice(0, 4);
  const brief = data.brief?.date === data.today ? data.brief : undefined;
  const generate = () => void perform("brief", async () => { await api("generateBrief"); await refresh(); notify(t("今日简报已更新")); });
  return <div className="bkw-today">
    <section className="bkw-card bkw-hero">
      <div className="bkw-hero-text">
        <span className="bkw-eyebrow">{longDate()} · {brief ? t("每日简报 · {0} 生成", time(brief.generatedAt)) : t("每日简报")}</span>
        <h2>{greeting()}</h2>
        {brief ? <p className="bkw-brief">{brief.text}</p> : <p className="bkw-brief muted">{data.defaults.briefEnabled ? t("今日简报将在 {0} 生成，也可以现在生成。", data.defaults.briefTime) : t("每日简报已关闭，可以随时手动生成。")}</p>}
        <div className="bkw-actions"><button type="button" className="bkw-btn small" disabled={!!busy} onClick={generate}><Icon name="sparkle" size={14} />{busy === "brief" ? t("正在生成…") : brief ? t("重新生成") : t("生成今日简报")}</button>{brief?.by === "template" && <small className="bkw-muted">{t("未配置模型，简报由统计生成。")}</small>}</div>
      </div>
      <div className="bkw-stats">
        <button type="button" className="bkw-stat warn" onClick={() => go({ view: "decide" })}><strong>{decisions.length}</strong><span>{t("待我决策")}</span></button>
        <button type="button" className="bkw-stat" onClick={() => go({ view: "done" })}><strong>{recent.length}</strong><span>{t("AI 已代办")}</span></button>
        <button type="button" className="bkw-stat" onClick={() => go({ view: "meetings" })}><strong>{data.sources.find(source => source.kind === "meeting")?.connected ? data.meetings.length : "—"}</strong><span>{t("今日会议")}</span></button>
      </div>
    </section>
    <div className="bkw-columns">
      <div className="bkw-col-main">
        <Section title={t("需要你决策")} aside={decisions.length > 5 && <button type="button" className="bkw-link" onClick={() => go({ view: "decide" })}>{t("全部 {0} 件", decisions.length)}<Icon name="arrow" size={12} /></button>}>
          {decisions.length ? decisions.slice(0, 5).map(task => <button type="button" key={task.id} className="bkw-row" onClick={() => go({ view: "decide", task: task.id })}>
            <SourceTag kind={sourceOf(task)} />
            <span className="bkw-row-main">
              <span className="bkw-row-title"><strong>{taskTitle(task)}</strong>{task.triage?.urgency === "high" && <Tag tone="danger">{t("紧急")}</Tag>}</span>
              <span className="bkw-row-sub">{counterpart(task)} · {nextStep(task)}</span>
            </span>
            <StatusTag task={task} />
          </button>) : <Empty icon="done" title={t("没有需要你决策的事")} text={t("新的待办出现时会显示在这里。")} />}
        </Section>
        <Section title={t("今日日程")} aside={<button type="button" className="bkw-link" onClick={() => go({ view: "meetings" })}>{t("会议")}<Icon name="arrow" size={12} /></button>}>
          <div className="bkw-placeholder"><Icon name="calendar" size={20} /><div><strong>{t("尚未连接日历")}</strong><span>{t("连接飞书、企业微信或 Outlook 日历后，这里显示今天的会议和会前简报。")}</span></div><button type="button" className="bkw-btn small" onClick={() => go({ view: "meetings" })}>{t("了解接入")}</button></div>
        </Section>
      </div>
      <div className="bkw-col-side">
        <Section title={t("最近 24 小时 AI 替你做了")} aside={<button type="button" className="bkw-link" onClick={() => go({ view: "done" })}>{t("全部")}</button>}>
          {recent.length ? recent.slice(0, 5).map(item => <ActivityRow key={item.id} item={item} compact />) : <p className="bkw-card-empty">{t("暂无自动处理记录。")}</p>}
        </Section>
        <Section title={t("值得关注")} aside={<small className="bkw-muted">{t("无需处理")}</small>}>
          {notable.length ? notable.map(task => <button type="button" key={task.id} className="bkw-note" onClick={() => go({ view: "items", task: task.id })}><span>{task.triage?.reason || task.subject}</span><small><SourceTag kind={sourceOf(task)} />{counterpart(task)} · {when(task.receivedAt)}</small></button>) : <p className="bkw-card-empty">{t("AI 判断为“值得关注”的信息会显示在这里。")}</p>}
        </Section>
        <Section title={t("主题追踪")} aside={<button type="button" className="bkw-link" onClick={() => go({ view: "topics" })}>{t("全部")}</button>}>
          {data.topics.length ? data.topics.slice(0, 4).map(topic => <button type="button" key={topic.id} className="bkw-topic-row" onClick={() => go({ view: "topics", topic: topic.id })}>
            <i className={`bkw-dot ${topic.summary?.level || (topic.open ? "attention" : "good")}`} />
            <span><strong>{topic.name}</strong><small>{topic.summary?.text ? topic.summary.text.slice(0, 40) : t("{0} 条相关信息", topic.count || 0)}</small></span>
            <time>{when(topic.lastAt)}</time>
          </button>) : <p className="bkw-card-empty">{t("跟踪某个客户或项目，AI 会汇总所有相关往来。")} <button type="button" className="bkw-link" onClick={() => go({ view: "topics" })}>{t("新建主题")}</button></p>}
        </Section>
      </div>
    </div>
  </div>;
}

type Filter = "all" | "review" | "reply" | "info" | "issue";
const FILTERS: [Filter, string][] = [["all", "全部"], ["review", "审核"], ["reply", "答复"], ["info", "补充"], ["issue", "异常"]];
const inFilter = (task: Task, filter: Filter) => filter === "all" || (filter === "review" && task.status === "review") || (filter === "reply" && task.status === "unmatched") || (filter === "info" && task.status === "needs_info") || (filter === "issue" && ["failed", "uncertain"].includes(task.status));
const groupOf = (task: Task) => ["failed", "uncertain"].includes(task.status) ? "issue" : task.triage?.urgency === "high" || Date.parse(task.receivedAt) > Date.now() - DAY ? "today" : "later";

export function DecideView({ selected }: { selected?: string }) {
  const { data, go } = useWorkbench();
  const [filter, setFilter] = useState<Filter>("all");
  const listRef = useRef<HTMLDivElement>(null);
  const tasks = useMemo(() => data.tasks.filter(task => task.attention).sort((a, b) => urgencyRank(a) - urgencyRank(b) || b.receivedAt.localeCompare(a.receivedAt)), [data.tasks]);
  const shown = tasks.filter(task => inFilter(task, filter));
  const groups: [string, string, Task[]][] = [["today", t("今天要处理"), shown.filter(task => groupOf(task) === "today")], ["issue", t("异常"), shown.filter(task => groupOf(task) === "issue")], ["later", t("更早"), shown.filter(task => groupOf(task) === "later")]];
  const ordered = groups.flatMap(([, , items]) => items);
  const current = data.tasks.find(task => task.id === selected) ?? ordered[0];
  const move = (step: number) => { const index = ordered.findIndex(task => task.id === current?.id); const next = ordered[Math.min(ordered.length - 1, Math.max(0, index + step))]; if (next && next.id !== current?.id) go({ view: "decide", task: next.id }); };
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      if (event.metaKey || event.ctrlKey || event.altKey || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName) || target.isContentEditable || document.querySelector(".bkw-modal-overlay")) return;
      if (event.key === "j") { event.preventDefault(); move(1); }
      if (event.key === "k") { event.preventDefault(); move(-1); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  useEffect(() => { listRef.current?.querySelector(".bkw-li.on")?.scrollIntoView({ block: "nearest" }); }, [current?.id]);
  if (!tasks.length) return <div className="bkw-pad"><Empty icon="done" title={t("暂时没有需要处理的事")} text={data.rules.length ? t("后台会按方案处理新信息，需要你决策时会出现在这里。") : t("创建一个处理方案，自动整理邮件并准备回复草稿。")}>
    {!data.rules.length && <button type="button" className="bkw-btn primary" onClick={() => go({ view: "plans", rule: "new" })}>{t("创建第一个方案")}</button>}
  </Empty></div>;
  return <div className="bkw-decide">
    <section className="bkw-decide-list" aria-label={t("待决策列表")} ref={listRef}>
      <div className="bkw-chips" role="group" aria-label={t("按类型筛选")}>
        {FILTERS.map(([id, label]) => { const count = tasks.filter(task => inFilter(task, id)).length; if (!count && id !== "all" && filter !== id) return null; return <button type="button" key={id} className={`bkw-chip ${filter === id ? "on" : ""}`} aria-pressed={filter === id} disabled={!count && id !== "all"} onClick={() => setFilter(id)}>{t(label)} <span>{count}</span></button>; })}
      </div>
      {groups.map(([id, label, items]) => items.length ? <div key={id} className="bkw-group">
        <h4>{label}</h4>
        {items.map(task => <button type="button" key={task.id} className={`bkw-li ${task.id === current?.id ? "on" : ""}`} aria-current={task.id === current?.id} onClick={() => go({ view: "decide", task: task.id })}>
          <span className="bkw-li-top"><SourceTag kind={sourceOf(task)} />{task.triage?.urgency === "high" && <Tag tone="danger">{t("紧急")}</Tag>}<time>{when(task.receivedAt)}</time></span>
          <strong>{taskTitle(task)}</strong>
          <span className="bkw-li-sub">{counterpart(task)} · {nextStep(task)}</span>
        </button>)}
      </div> : null)}
      {!shown.length && <p className="bkw-card-empty">{t("没有符合条件的事项。")}</p>}
      <p className="bkw-keys"><kbd>J</kbd><kbd>K</kbd> {t("切换")} · <kbd>⌘↵</kbd> {t("保存或发送")}</p>
    </section>
    {current ? <TaskWorkspace key={current.id} task={current} onDone={() => move(1)} /> : null}
  </div>;
}

const KINDS: [string, string, (item: Activity) => boolean][] = [["all", "全部", () => true], ["reply", "回复", item => item.kind.startsWith("auto_send") || item.kind === "auto_sent"], ["archive", "归档", item => item.kind === "archive"], ["report", "报告与简报", item => ["report", "brief", "weekly", "topic"].includes(item.kind)]];
export function DoneView() {
  const { data, go } = useWorkbench();
  const [kind, setKind] = useState("all");
  const filter = KINDS.find(([id]) => id === kind)![2];
  const items = data.activity.filter(filter).sort((a, b) => b.at.localeCompare(a.at));
  const days = items.reduce<[string, Activity[]][]>((acc, item) => { const key = new Date(item.at).toDateString(); const last = acc.at(-1); if (last && last[0] === key) last[1].push(item); else acc.push([key, [item]]); return acc; }, []);
  const week = data.activity.filter(item => Date.parse(item.at) >= Date.now() - 7 * DAY);
  const countBy = (autonomy: string) => data.rules.filter(rule => (rule.autonomy || "draft") === autonomy).length;
  return <div className="bkw-split">
    <div className="bkw-split-main">
      <div className="bkw-toolbar">
        <div className="bkw-chips">{KINDS.map(([id, label]) => <button type="button" key={id} className={`bkw-chip ${kind === id ? "on" : ""}`} aria-pressed={kind === id} onClick={() => setKind(id)}>{t(label)}</button>)}</div>
        <small className="bkw-muted">{t("自动回复在撤回窗口内可撤回；归档的信息随时可恢复。")}</small>
      </div>
      {days.length ? days.map(([key, list]) => <section className="bkw-card" key={key}><div className="bkw-day">{dayLabel(list[0].at)}</div>{list.map(item => <ActivityRow key={item.id} item={item} />)}</section>)
        : <Empty icon="done" title={t("AI 还没有替你做事")} text={t("开启自动处理后，归档、自动回复、报告等都会记录在这里，可随时撤回。")} />}
    </div>
    <aside className="bkw-split-side">
      <Section title={t("本周")}>
        <div className="bkw-mini-stats">
          <div><strong>{week.filter(item => !item.undoneAt).length}</strong><span>{t("代办完成")}</span></div>
          <div><strong>{week.filter(item => item.kind === "archive" && !item.undoneAt).length}</strong><span>{t("通知归档")}</span></div>
          <div><strong>{week.filter(item => item.undoneAt || item.kind === "auto_send_canceled").length}</strong><span>{t("被你撤回")}</span></div>
        </div>
      </Section>
      <Section title={t("授权概览")} aside={<button type="button" className="bkw-link" onClick={() => go({ view: "plans" })}>{t("调整")}</button>}>
        <p className="bkw-card-lead">{t("AI 能自己做什么，由每个方案的自主级别决定。")}</p>
        <div className="bkw-kv-rows">
          <div><span>{t("AI 分拣 · 通知归档")}</span><Tag tone={data.defaults.triage ? "good" : "muted"}>{data.defaults.triage ? t("已开启") : t("已关闭")}</Tag></div>
          {data.rules.map(rule => <div key={rule.id}><span>{rule.name}</span><Tag tone={rule.autonomy === "auto" ? "warn" : rule.autonomy === "low_risk" ? "accent" : "muted"}>{t(AUTONOMY_LABEL[rule.autonomy || "draft"])}</Tag></div>)}
        </div>
        <p className="bkw-footnote">{t("仅起草 {0} · 低风险自动 {1} · 全自动 {2}", countBy("draft"), countBy("low_risk"), countBy("auto"))}</p>
      </Section>
      <button type="button" className="bkw-link" onClick={() => go({ view: "logs" })}><Icon name="history" size={14} />{t("查看运行记录")}</button>
    </aside>
  </div>;
}

export function ItemsView({ selected, chats }: { selected?: string; chats?: boolean }) {
  const { data, go } = useWorkbench();
  const [search, setSearch] = useState(""), [status, setStatus] = useState("all"), [category, setCategory] = useState("all");
  const task = selected ? data.tasks.find(item => item.id === selected) : undefined;
  if (selected && task) return <div className="bkw-detail-page">
    <PageHeader title={t("事项详情")} backLabel={t("返回全部事项")} onBack={() => go({ view: "items" })}
      actions={!!task.topicIds?.length && <span className="bkw-tags">{task.topicIds.map(id => { const topic = data.topics.find(item => item.id === id); return topic ? <button type="button" key={id} className="bkw-link" onClick={() => go({ view: "topics", topic: id })}>#{topic.name}</button> : null; })}</span>} />
    <TaskWorkspace key={task.id} task={task} />
  </div>;
  const wechatOn = !!data.wechat?.settings.enabled;
  const modes = wechatOn && <div className="bkw-seg" role="tablist" aria-label={t("查看方式")}>
    <button type="button" role="tab" aria-selected={!chats} className={!chats ? "on" : ""} onClick={() => go({ view: "items" })}>{t("按事项")}</button>
    <button type="button" role="tab" aria-selected={!!chats} className={chats ? "on" : ""} onClick={() => go({ view: "items", chats: true })}>{t("按会话")}</button>
  </div>;
  if (chats && wechatOn) return <div className="bkw-chats-page"><div className="bkw-chats-bar">{modes}<span className="bkw-muted">{t("像微信一样按会话阅读，AI 识别的事项直接标在对话里。")}</span></div><ChatsView /></div>;
  const rows = data.tasks.filter(item => (status === "all" || item.status === status || (status === "archived" && item.status === "ignored" && item.triage?.archived)) && (category === "all" || item.triage?.category === category)
    && `${item.subject} ${item.title} ${item.from} ${item.ruleName || ""} ${item.summary || ""}`.toLowerCase().includes(search.trim().toLowerCase())).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  return <div className="bkw-pad">
    <div className="bkw-toolbar">
      {modes}
      <label className="bkw-search"><Icon name="search" size={15} /><input placeholder={t("搜索主题、发件人、方案或摘要")} aria-label={t("搜索事项")} value={search} onChange={event => setSearch(event.target.value)} /></label>
      <select aria-label={t("按状态筛选")} value={status} onChange={event => setStatus(event.target.value)}>
        <option value="all">{t("全部状态")}</option><option value="archived">{t("已归档")}</option>
        {(Object.keys(LABELS) as Status[]).map(id => <option key={id} value={id}>{t(LABELS[id])}</option>)}
      </select>
      <select aria-label={t("按类别筛选")} value={category} onChange={event => setCategory(event.target.value)}>
        <option value="all">{t("全部类别")}</option>
        {Object.entries(CATEGORY).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}
      </select>
      <span className="bkw-muted">{t("{0} 项", rows.length)}</span>
    </div>
    {rows.length ? <div className="bkw-table" role="table" aria-label={t("全部事项")}>
      <div className="bkw-tr head" role="row"><span role="columnheader">{t("事项 / 下一步")}</span><span role="columnheader">{t("来源")}</span><span role="columnheader">{t("处理方案")}</span><span role="columnheader">{t("状态")}</span><span role="columnheader">{t("时间")}</span></div>
      {rows.map(item => <button type="button" role="row" key={item.id} className="bkw-tr" onClick={() => go({ view: "items", task: item.id })}>
        <span className="bkw-td-title" role="cell"><strong>{taskTitle(item) || t("无主题邮件")}</strong><small>{nextStep(item)}</small></span>
        <span className="bkw-td-from" role="cell"><SourceTag kind={sourceOf(item)} /><span title={item.from}>{counterpart(item)}</span></span>
        <span className={`bkw-td-rule ${item.ruleName ? "" : "muted"}`} role="cell" title={item.ruleName}>{item.ruleName || (item.triage?.category ? t(CATEGORY[item.triage.category]) : t("尚未匹配方案"))}</span>
        <span role="cell"><StatusTag task={item} /></span>
        <time role="cell">{when(item.receivedAt)}</time>
      </button>)}
    </div> : <Empty title={search || status !== "all" || category !== "all" ? t("没有符合条件的事项") : t("从第一封邮件开始")} text={search || status !== "all" || category !== "all" ? t("试试其他关键词或筛选条件。") : t("开启自动处理后，新信息会在这里汇总，并按方案准备处理结果。")} />}
  </div>;
}

/** Meetings need a calendar/meeting adapter. Until one exists the page explains what connects and can show a labelled example. */
export function MeetingsView() {
  const [example, setExample] = useState(false);
  const platforms: [string, string][] = [[t("飞书日历与妙记"), t("日程、会议纪要转写")], [t("企业微信日程与会议"), t("日程、会议录制转写")], [t("腾讯会议"), t("云录制转写")], [t("Outlook / Exchange 日历"), t("日程与会议邀请")]];
  return <div className="bkw-pad bkw-meetings">
    <section className="bkw-card bkw-connect">
      <div className="bkw-connect-head"><span className="bkw-connect-icon"><Icon name="calendar" size={22} /></span><div><h2>{t("会议需要连接日历或会议平台")}</h2><p>{t("连接后，工作台会在会前汇总相关邮件、消息和上次遗留事项，会后整理纪要并分发待办。目前尚未安装对应的接入适配器。")}</p></div></div>
      <div className="bkw-platforms">{platforms.map(([name, detail]) => <div key={name} className="bkw-platform"><strong>{name}</strong><small>{detail}</small><Tag>{t("待接入")}</Tag></div>)}</div>
      <div className="bkw-platform local"><Icon name="mic" size={18} /><div><strong>{t("线下会议本地录制")}</strong><small>{t("录音只保存在本机，转写后可删除；开录前需告知参会人。需要麦克风权限，将在后续版本提供。")}</small></div><Tag>{t("规划中")}</Tag></div>
      <div className="bkw-actions"><button type="button" className="bkw-btn" aria-pressed={example} onClick={() => setExample(!example)}>{example ? t("隐藏示例") : t("查看会前简报示例")}</button></div>
    </section>
    {example && <section className="bkw-card bkw-example" aria-label={t("会前简报示例")}>
      <div className="bkw-example-badge">{t("示例数据 · 非真实会议")}</div>
      <div className="bkw-card-head"><h3>{t("示例：客户需求沟通 · 14:00–15:00")}</h3></div>
      <div className="bkw-example-body">
        <p>{t("AI 汇总了 4 封邮件、6 条消息和上次会议纪要：客户正在评估首批采购，报价草稿待你审核；对方最在意交期和售后响应，会上可能提出批量折扣。")}</p>
        <h4>{t("本次可能要谈")}</h4>
        <ol><li>{t("首批采购的价格与付款方式")}</li><li>{t("到货时间与物流安排")}</li><li>{t("二期产品的接入计划")}</li></ol>
        <h4>{t("上次遗留")}</h4>
        <ul><li><Tag tone="good">{t("已完成")}</Tag>{t("提供产品检测报告")}</li><li><Tag tone="warn">{t("未完成")}</Tag>{t("确认分批开票方案")}</li></ul>
        <h4>{t("建议会前准备")}</h4>
        <ul><li>{t("审核并发出报价邮件")}</li><li>{t("确认折扣授权底线")}</li></ul>
      </div>
    </section>}
  </div>;
}

export function LogsView() {
  const { data, go } = useWorkbench();
  return <div className="bkw-pad">
    <PageHeader title={t("运行记录")} backLabel={t("返回 AI 已代办")} onBack={() => go({ view: "done" })} meta={<span>{t("查看后台检测、任务执行与发送结果。")}</span>} />
    {data.logs.length ? <div className="bkw-card bkw-logs">{data.logs.map((log, index) => <div className="bkw-log" key={log.id || index}>
      <time className="bkw-mono">{fullDate(String(log.at || ""))}</time>
      <Tag tone={log.level === "error" ? "danger" : "muted"}>{log.level === "error" ? t("错误") : t("信息")}</Tag>
      <span>{systemMessage(String(log.message || ""))}</span>
      {log.taskId && <button type="button" className="bkw-link" onClick={() => go({ view: "items", task: log.taskId })}>{t("查看任务")}</button>}
    </div>)}</div> : <Empty icon="history" title={t("运行记录会保存在这里")} text={t("开启自动处理后，可在此查看收件检测、任务执行和发送结果。")} />}
  </div>;
}

export { statusLabel };
