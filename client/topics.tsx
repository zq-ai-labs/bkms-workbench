import * as React from "react";
import { useEffect, useState } from "react";
import { t } from "./i18n";
import { useWorkbench } from "./context";
import { api, dateTime, downloadText, nextStep, senderName, sourceOf, taskTitle, when, type Report, type Topic } from "./lib";
import { AutoTextarea, Empty, Field, Icon, Modal, SourceTag, StatusTag, Tag } from "./ui";

const KIND: Record<Topic["kind"], string> = { customer: "客户", project: "项目", other: "其他" };
const LEVEL: Record<string, string> = { good: "进展正常", attention: "需关注", risk: "有风险" };
const split = (value: string) => value.split(/[,，;；\n]/).map(item => item.trim()).filter(Boolean);

export function TopicsView({ topicId, reportId }: { topicId?: string; reportId?: string }) {
  const { data, busy, perform, refresh, notify, go } = useWorkbench();
  const [editing, setEditing] = useState<Partial<Topic> | null>(null);
  const weekly = data.reports.filter(report => report.kind === "weekly"), topicReports = data.reports.filter(report => report.kind === "topic");
  const topic = data.topics.find(item => item.id === topicId) ?? (!reportId ? data.topics[0] : undefined);
  const report = data.reports.find(item => item.id === reportId);
  const generateWeekly = () => void perform("weekly", async () => { const created = await api<Report>("generateReport", { kind: "weekly" }); await refresh(); go({ view: "topics", report: created.id }); notify(t("周报草稿已生成")); });
  return <div className="bkw-topics">
    <nav className="bkw-topic-nav" aria-label={t("主题与报告")}>
      <div className="bkw-nav-group"><h4>{t("主题追踪")}</h4>
        {data.topics.map(item => <button type="button" key={item.id} className={`bkw-nav-item ${!report && topic?.id === item.id ? "on" : ""}`} onClick={() => go({ view: "topics", topic: item.id })}>
          <i className={`bkw-dot ${item.summary?.level || (item.open ? "attention" : "good")}`} /><span>{item.name}</span><small className="bkw-mono">{item.count || 0}</small>
        </button>)}
        <button type="button" className="bkw-nav-add" onClick={() => setEditing({ kind: "customer", keywords: [], senders: [], schedule: "none" })}><Icon name="plus" size={14} />{t("新建主题")}</button>
      </div>
      <div className="bkw-nav-group"><h4>{t("报告")}</h4>
        <button type="button" className="bkw-nav-item" onClick={() => go({ view: "today" })}><Icon name="sun" size={14} /><span>{t("今日简报")}</span><small>{data.brief?.date === data.today ? t("已生成") : data.defaults.briefTime}</small></button>
        {weekly.map(item => <button type="button" key={item.id} className={`bkw-nav-item ${report?.id === item.id ? "on" : ""}`} onClick={() => go({ view: "topics", report: item.id })}><Icon name="file" size={14} /><span>{item.title}</span></button>)}
        {topicReports.slice(0, 8).map(item => <button type="button" key={item.id} className={`bkw-nav-item ${report?.id === item.id ? "on" : ""}`} onClick={() => go({ view: "topics", report: item.id })}><Icon name="topic" size={14} /><span>{item.title}</span></button>)}
        <button type="button" className="bkw-nav-add" disabled={!!busy} onClick={generateWeekly}><Icon name="sparkle" size={14} />{busy === "weekly" ? t("正在生成…") : t("生成本周周报")}</button>
      </div>
    </nav>
    <div className="bkw-topic-main">
      {report ? <ReportEditor key={report.id} report={report} /> : topic ? <TopicDetail key={topic.id} topic={topic} onEdit={() => setEditing(topic)} /> :
        <Empty icon="topic" title={t("跟踪一个客户或项目")} text={t("按关键词和联系人汇总相关往来，AI 概括现状、风险和待办，并可定期生成主题报告。")}>
          <button type="button" className="bkw-btn primary" onClick={() => setEditing({ kind: "customer", keywords: [], senders: [], schedule: "none" })}><Icon name="plus" size={15} />{t("新建主题")}</button>
        </Empty>}
    </div>
    {editing && <TopicEditor topic={editing} onClose={() => setEditing(null)} />}
  </div>;
}

function TopicDetail({ topic, onEdit }: { topic: Topic; onEdit: () => void }) {
  const { data, busy, perform, refresh, notify, go } = useWorkbench();
  const [all, setAll] = useState(false);
  const items = data.tasks.filter(task => task.topicIds?.includes(topic.id)).sort((a, b) => b.receivedAt.localeCompare(a.receivedAt));
  const open = items.filter(task => task.attention);
  const refreshSummary = () => void perform("topic", async () => { await api("refreshTopic", { id: topic.id }); await refresh(); notify(t("主题现状已更新")); });
  const scope = [...topic.keywords.map(word => t("关键词“{0}”", word)), ...topic.senders.map(sender => t("联系人 {0}", sender))].join(t("、"));
  return <div className="bkw-topic">
    <header className="bkw-topic-head">
      <div>
        <span className="bkw-eyebrow">{t("主题 · {0}", t(KIND[topic.kind]))}</span>
        <h2>{topic.name}</h2>
        <div className="bkw-tags">
          {topic.summary && <Tag tone={topic.summary.level === "risk" ? "danger" : topic.summary.level === "attention" ? "warn" : "good"}>{t(LEVEL[topic.summary.level])}</Tag>}
          <span className="bkw-muted">{t("追踪范围：{0} · 共 {1} 条", scope, items.length)}</span>
          {topic.schedule === "weekly" && <Tag tone="accent">{t("每周报告")}</Tag>}
        </div>
      </div>
      <div className="bkw-actions">
        <button type="button" className="bkw-btn" onClick={onEdit}><Icon name="edit" size={14} />{t("编辑范围")}</button>
        <button type="button" className="bkw-btn primary" disabled={!!busy} onClick={() => void perform("topicReport", async () => { await api("generateReport", { kind: "topic", topicId: topic.id }); const latest = (await refresh()).reports.find(item => item.topicId === topic.id); if (latest) go({ view: "topics", report: latest.id }); notify(t("主题报告已生成")); })}><Icon name="sparkle" size={14} />{busy === "topicReport" ? t("正在生成…") : t("生成主题报告")}</button>
      </div>
    </header>
    <section className="bkw-card">
      <div className="bkw-card-head"><h3>{t("现状")}</h3><span className="bkw-actions">{topic.summary && <small className="bkw-muted">{topic.summary.by === "ai" ? t("AI 更新于 {0}", dateTime(topic.summary.at)) : t("统计生成于 {0}", dateTime(topic.summary.at))}</small>}<button type="button" className="bkw-btn small" disabled={!!busy} onClick={refreshSummary}><Icon name="refresh" size={13} />{busy === "topic" ? t("更新中…") : t("更新现状")}</button></span></div>
      <p className="bkw-card-lead strong">{topic.summary?.text || t("还没有概括。点击“更新现状”，AI 会根据 {0} 条相关信息总结进展。", items.length)}</p>
    </section>
    <div className="bkw-two">
      <section className="bkw-card"><div className="bkw-card-head"><h3>{t("风险")}</h3></div>{topic.summary?.risks.length ? <ul className="bkw-list">{topic.summary.risks.map((risk, index) => <li key={index}><i className="bkw-dot attention" />{risk}</li>)}</ul> : <p className="bkw-card-empty">{t("暂无有依据的风险。")}</p>}</section>
      <section className="bkw-card"><div className="bkw-card-head"><h3>{t("待办")}</h3><small className="bkw-muted">{t("{0} 件等你处理", open.length)}</small></div>
        {open.length ? open.slice(0, 6).map(task => <button type="button" key={task.id} className="bkw-row tight" onClick={() => go({ view: "decide", task: task.id })}><span className="bkw-row-main"><strong>{taskTitle(task)}</strong><span className="bkw-row-sub">{nextStep(task)}</span></span><StatusTag task={task} /></button>)
          : topic.summary?.todos.length ? <ul className="bkw-list">{topic.summary.todos.map((todo, index) => <li key={index}>{todo}</li>)}</ul> : <p className="bkw-card-empty">{t("没有等你处理的事。")}</p>}
      </section>
    </div>
    <section className="bkw-card">
      <div className="bkw-card-head"><h3>{t("相关往来")}</h3>{items.length > 8 && <button type="button" className="bkw-link" onClick={() => setAll(!all)}>{all ? t("收起") : t("全部 {0} 条", items.length)}</button>}</div>
      {items.length ? (all ? items : items.slice(0, 8)).map(task => <button type="button" key={task.id} className="bkw-timeline-row" onClick={() => go({ view: "items", task: task.id })}>
        <time className="bkw-mono">{when(task.receivedAt)}</time><SourceTag kind={sourceOf(task)} /><span className="bkw-tl-main"><strong>{taskTitle(task)}</strong><small>{senderName(task.from)}{task.summary ? ` · ${task.summary.split("\n")[0].slice(0, 60)}` : ""}</small></span><StatusTag task={task} />
      </button>) : <p className="bkw-card-empty">{t("还没有匹配的信息。检查关键词和联系人是否准确。")}</p>}
    </section>
  </div>;
}

function TopicEditor({ topic, onClose }: { topic: Partial<Topic>; onClose: () => void }) {
  const { busy, perform, refresh, notify, go } = useWorkbench();
  const [name, setName] = useState(topic.name || ""), [kind, setKind] = useState<Topic["kind"]>(topic.kind || "customer");
  const [keywords, setKeywords] = useState((topic.keywords || []).join(", ")), [senders, setSenders] = useState((topic.senders || []).join(", "));
  const [schedule, setSchedule] = useState<Topic["schedule"]>(topic.schedule || "none"), [confirmDelete, setConfirmDelete] = useState(false);
  return <Modal title={topic.id ? t("编辑主题") : t("新建主题")} onClose={() => { if (!busy) onClose(); }}>
    <form className="bkw-form" onSubmit={event => { event.preventDefault(); void perform("saveTopic", async () => { const saved = await api<Topic>("saveTopic", { topic: { id: topic.id, name, kind, keywords: split(keywords), senders: split(senders), schedule } }); await refresh(); onClose(); go({ view: "topics", topic: saved.id }); notify(t("主题已保存")); }); }}>
      <Field label={t("名称")}><input required maxLength={60} value={name} onChange={event => setName(event.target.value)} placeholder={t("例如：客户 · 启明演示")} /></Field>
      <Field label={t("类型")}><select value={kind} onChange={event => setKind(event.target.value as Topic["kind"])}>{Object.entries(KIND).map(([id, label]) => <option key={id} value={id}>{t(label)}</option>)}</select></Field>
      <Field label={t("关键词")} hint={t("出现在主题、正文或摘要中即归入。多个用逗号分隔。")}><input value={keywords} onChange={event => setKeywords(event.target.value)} placeholder={t("例如：启明, TH-100")} /></Field>
      <Field label={t("联系人")} hint={t("邮箱地址，或用 @ 开头的域名。多个用逗号分隔。")}><input value={senders} onChange={event => setSenders(event.target.value)} placeholder="@qiming.example" /></Field>
      <Field label={t("定期报告")}><select value={schedule} onChange={event => setSchedule(event.target.value as Topic["schedule"])}><option value="none">{t("不自动生成")}</option><option value="weekly">{t("每周随周报生成")}</option></select></Field>
      <div className="bkw-dialog-actions">
        {topic.id && <button type="button" className="bkw-btn danger-text" disabled={!!busy} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void perform("deleteTopic", async () => { await api("deleteTopic", { id: topic.id }); await refresh(); onClose(); go({ view: "topics" }); notify(t("主题已删除，相关信息保留")); }); }}>{confirmDelete ? t("再次点击确认删除") : t("删除主题")}</button>}
        <span className="bkw-grow" />
        <button type="button" className="bkw-btn" disabled={!!busy} onClick={onClose}>{t("取消")}</button>
        <button type="submit" className="bkw-btn primary" disabled={!!busy || !name.trim() || (!split(keywords).length && !split(senders).length)}>{t("保存主题")}</button>
      </div>
    </form>
  </Modal>;
}

function ReportEditor({ report }: { report: Report }) {
  const { busy, perform, refresh, notify, go, leave } = useWorkbench();
  const [title, setTitle] = useState(report.title), [text, setText] = useState(report.text), [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = title !== report.title || text !== report.text;
  useEffect(() => { leave.current = () => !dirty || window.confirm(t("报告有尚未保存的修改，确认放弃？")); return () => { leave.current = undefined; }; }, [dirty]);
  return <div className="bkw-report-editor">
    <header className="bkw-topic-head">
      <div>
        <span className="bkw-eyebrow">{report.kind === "weekly" ? t("周报草稿") : t("主题报告")} · {report.periodStart} – {report.periodEnd} · {report.by === "ai" ? t("AI 起草") : t("统计生成")}</span>
        <input className="bkw-title-input" aria-label={t("报告标题")} value={title} maxLength={160} onChange={event => setTitle(event.target.value)} />
      </div>
      <div className="bkw-actions">
        <button type="button" className="bkw-btn" onClick={() => void perform("copy", async () => { await navigator.clipboard.writeText(`# ${title}\n\n${text}`); notify(t("已复制到剪贴板")); })}><Icon name="copy" size={14} />{t("复制")}</button>
        <button type="button" className="bkw-btn" onClick={() => downloadText(`# ${title}\n\n${text}`, `${title.replace(/[\\/:*?"<>|]/g, "_")}.md`)}><Icon name="download" size={14} />{t("下载 Markdown")}</button>
        <button type="button" className="bkw-btn primary" disabled={!dirty || !!busy || !title.trim()} onClick={() => void perform("saveReport", async () => { await api("saveReport", { id: report.id, title, text }); await refresh(); notify(t("报告已保存")); })}>{busy === "saveReport" ? t("保存中…") : t("保存")}</button>
      </div>
    </header>
    <section className="bkw-card bkw-report-body"><AutoTextarea aria-label={t("报告正文")} value={text} onChange={event => setText(event.target.value)} maxLength={32000} /></section>
    <div className="bkw-actions"><button type="button" className="bkw-btn ghost danger-text" disabled={!!busy} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void perform("deleteReport", async () => { leave.current = undefined; await api("deleteReport", { id: report.id }); await refresh(); go({ view: "topics" }); notify(t("报告已删除")); }); }}><Icon name="trash" size={14} />{confirmDelete ? t("再次点击确认删除") : t("删除报告")}</button>
      <small className="bkw-muted">{t("报告只保存在工作台，不会自动发送给任何人。")}</small></div>
  </div>;
}
