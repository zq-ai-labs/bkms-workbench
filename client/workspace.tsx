import * as React from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import { systemMessage, t } from "./i18n";
import { useWorkbench } from "./context";
import { OriginalMailBody } from "./original-mail";
import { AUTONOMY_LABEL, CATEGORY, api, counterpart, draftValue, downloadOriginal, downloadPreview, errorMessage, fullDate, minutesLeft, nextStep, senderName, sourceOf, statusLabel, taskTitle, time, uploadDraftAttachment, when, type Draft, type EditDraft, type Rule, type SendPlan, type Task } from "./lib";
import { Alert, AutoTextarea, Field, Icon, Modal, SourceTag, StatusTag, Tag } from "./ui";
import { ChatHistory, SegmentConversation } from "./wechat";

/** Unsaved edits survive switching views and remounts, keyed by task. */
let cachedDraft: { id: string; revision: number; draftRevision: number; form: EditDraft; original: string } | undefined;
/** Check items the user has confirmed in this session, per task and draft revision. */
const acknowledged = new Map<string, Set<number>>();

export function TaskWorkspace({ task, onDone }: { task: Task; onDone?: () => void }) {
  const { data, busy, perform, refresh, notify, leave, go } = useWorkbench();
  const cache = cachedDraft?.id === task.id ? cachedDraft : undefined;
  const [form, setForm] = useState<EditDraft | undefined>(cache?.form);
  const [original, setOriginal] = useState(cache?.original || "");
  const [formRevision, setFormRevision] = useState(cache?.draftRevision);
  const [taskRevision, setTaskRevision] = useState(cache?.revision);
  const [preview, setPreview] = useState<SendPlan | null>(null);
  const [assignment, setAssignment] = useState("");
  const [confirmIgnore, setConfirmIgnore] = useState(false);
  const [supplement, setSupplement] = useState("");
  const [rerun, setRerun] = useState<{ rule: Rule; configRevision: number; text: string }>();
  const [resolution, setResolution] = useState<{ draftRevision: number; outcome: "sent" | "not_sent" }>();
  const [resolutionChecked, setResolutionChecked] = useState(false);
  const [menu, setMenu] = useState(false);
  const [sourceTab, setSourceTab] = useState<"mail" | "related" | "history">("mail");
  const [mobilePane, setMobilePane] = useState<"result" | "source">("result");
  const [activeCheck, setActiveCheck] = useState<number>();
  const [, setTick] = useState(0);
  const ackKey = `${task.id}:${task.draft?.revision ?? 0}`;
  const acks = acknowledged.get(ackKey) ?? new Set<number>();
  const wechat = task.source?.kind === "wechat";
  const [reply, setReply] = useState(task.wechat?.reply ?? ""), [replyBase, setReplyBase] = useState(task.wechat?.reply ?? "");
  const replyDirty = wechat && reply !== replyBase;
  const dirty = (!!form && JSON.stringify(form) !== original) || replyDirty;
  const autoActive = !!task.autoSend && !task.autoSend.canceledAt && task.status === "review";
  const locked = !!busy || task.status !== "review" || (!!task.draft && task.draft.state !== "draft") || autoActive;
  const latestRule = data.rules.find(rule => rule.id === task.ruleId);
  const mailReady = data.health.email && data.accounts.length > 0;
  const modelReady = !!data.health.agent;
  const reviewForm = preview?.draft ? draftValue(preview.draft) : form;
  const previewChanged = !!preview && (preview.taskRevision !== task.revision || preview.draftRevision !== task.draft?.revision);
  const previewExpired = !!preview?.expiresAt && preview.expiresAt <= Date.now();
  const checks = task.checks?.length ? task.checks : task.informationGaps && task.status === "review" ? task.informationGaps.split(/\n+/).map(line => line.replace(/^\s*(\d+[.、)]|[-•·])\s*/, "").trim()).filter(Boolean).map(item => ({ item, quote: undefined as string | undefined })) : [];
  const pendingChecks = checks.filter((_, index) => !acks.has(index)).length;

  useEffect(() => { if (!replyDirty) { setReply(task.wechat?.reply ?? ""); setReplyBase(task.wechat?.reply ?? ""); } }, [task.id, task.wechat?.replyRevision]);
  useEffect(() => { if (!autoActive) return; const timer = setInterval(() => setTick(value => value + 1), 30000); return () => clearInterval(timer); }, [autoActive]);
  useEffect(() => {
    if (!task.draft) { if (!dirty) { setForm(undefined); setOriginal(""); setFormRevision(undefined); setTaskRevision(task.revision); } return; }
    if (!dirty) { const next = draftValue(task.draft); setForm(next); setOriginal(JSON.stringify(next)); setFormRevision(task.draft.revision); setTaskRevision(task.revision); }
  }, [task.id, task.revision, task.draft?.revision]);
  useEffect(() => {
    cachedDraft = dirty && form && taskRevision !== undefined && formRevision !== undefined ? { id: task.id, form, revision: taskRevision, draftRevision: formRevision, original } : cachedDraft?.id === task.id ? undefined : cachedDraft;
  }, [dirty, form, original, taskRevision, formRevision]);
  useEffect(() => {
    leave.current = () => {
      if (!dirty && !supplement.trim()) return true;
      if (!window.confirm(t("当前任务有尚未保存的修改，确认放弃？"))) return false;
      cachedDraft = undefined;
      return true;
    };
    return () => { leave.current = undefined; };
  }, [dirty, supplement]);
  useEffect(() => {
    if (!dirty && !supplement.trim()) return;
    const before = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", before);
    return () => window.removeEventListener("beforeunload", before);
  }, [dirty, supplement]);

  const run = (key: string, work: () => Promise<unknown>) => void perform(key, work);
  const saveReply = () => run("saveReply", async () => { await api("saveReply", { id: task.id, revision: task.revision, replyRevision: task.wechat?.replyRevision, text: reply }); setReplyBase(reply); await refresh(); notify(t("回复已保存")); });
  const copyReply = () => run("copyReply", async () => { await copyText(reply); notify(t("已复制，请到微信中粘贴发送")); });
  const markHandled = () => run("markHandled", async () => { await api("markHandled", { id: task.id, revision: task.revision }); await refresh(); notify(t("已标记为在微信中处理")); onDone?.(); });
  async function saveDraft() {
    if (!form) return;
    await api("saveDraft", { id: task.id, revision: taskRevision, draftRevision: formRevision, draft: form });
    cachedDraft = undefined; setOriginal(JSON.stringify(form)); await refresh(); notify(t("草稿已保存"));
  }
  const openPreview = () => run("previewSend", async () => {
    const plan = await api<SendPlan>("previewSend", { id: task.id, revision: task.revision, draftRevision: task.draft!.revision });
    setPreview({ ...plan, taskRevision: task.revision, draftRevision: task.draft!.revision });
  });
  const canSend = !!task.draft && task.status === "review" && !locked && !dirty && !!form?.to && !!form.subject;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter" || preview) return;
      if (wechat) { if (task.status !== "review" || busy) return; event.preventDefault(); if (replyDirty) saveReply(); else if (reply) copyReply(); return; }
      if (dirty && !locked) { event.preventDefault(); run("saveDraft", saveDraft); }
      else if (canSend) { event.preventDefault(); openPreview(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  });
  const toggleCheck = (index: number) => { const next = new Set(acks); if (next.has(index)) next.delete(index); else next.add(index); acknowledged.set(ackKey, next); setTick(value => value + 1); };
  const related = [...(task.relatedIds || []), ...(task.possibleIds || [])].map(id => data.tasks.find(item => item.id === id)).filter(Boolean) as Task[];

  const header = <div className="bkw-ws-head">
    <div className="bkw-tags">
      <StatusTag task={task} />
      {task.triage?.urgency === "high" && ["review", "needs_info", "unmatched", "failed"].includes(task.status) && <Tag tone="danger">{t("紧急")}</Tag>}
      {task.triage?.category && <Tag>{t(CATEGORY[task.triage.category])}</Tag>}
      <SourceTag kind={sourceOf(task)} />
      {task.wechat?.mentioned && <Tag tone="accent">{t("@我")}</Tag>}
    </div>
    <h2>{wechat ? task.title : task.subject || task.title || t("无主题邮件")}</h2>
    <div className="bkw-ws-meta">
      <span>{wechat ? (task.wechat?.group ? t("群聊 · {0}", task.wechat.chatName) : t("私聊 · {0}", task.wechat?.chatName || "")) : senderName(task.from)}</span><span>{fullDate(task.mailDate || task.receivedAt)}</span>
      <span>{task.ruleName ? t("方案：{0}", task.ruleName) : t("尚未匹配方案")}</span>
      {latestRule?.autonomy && <span>{t("自主级别：{0}", t(AUTONOMY_LABEL[latestRule.autonomy]))}</span>}
    </div>
    {task.triage?.reason && <p className="bkw-ws-reason"><Icon name="sparkle" size={14} />{t("AI 判断：{0}", task.triage.reason)}</p>}
  </div>;

  const result = <>
    {autoActive && <div className="bkw-autosend" role="status">
      <Icon name="send" size={16} />
      <div><strong>{t("AI 将于 {0} 自动发送", time(task.autoSend!.at))}</strong><span>{t("还剩 {0} 分钟。要修改内容，请先撤回自动发送。", minutesLeft(task.autoSend!.at))}</span></div>
      <button type="button" className="bkw-btn" disabled={!!busy} onClick={() => run("cancelAutoSend", async () => { await api("cancelAutoSend", { id: task.id, revision: task.revision }); await refresh(); notify(t("已撤回自动发送，转为人工审核")); })}><Icon name="undo" size={15} />{t("撤回并人工审核")}</button>
    </div>}
    {task.autoSend?.canceledAt && task.status === "review" && task.autoSend.reason && <Alert>{systemMessage(task.autoSend.reason)}</Alert>}
    {task.ruleUpdated && <Alert>{t("方案已更新，当前结果仍基于原方案。可按最新方案重新处理，以使用更新后的要求和工具。")}</Alert>}
    {task.error && task.status !== "needs_info" && <Alert tone="danger">{systemMessage(task.error)}</Alert>}
    {task.status === "uncertain" && <Alert tone="warn">{t("发送结果尚未确定。请核对邮箱中的已发送邮件，避免重复发送。")}</Alert>}
    {task.status === "uncertain" && !task.canResolveSend && <Alert>{t("发送结果恢复功能暂不可用，请确认配套邮件插件已更新并重启客户端；草稿无法读取时请先恢复邮件服务。")}</Alert>}

    {checks.length > 0 && task.status === "review" && <section className="bkw-checks" aria-label={t("发送前请核实")}>
      <h3>{pendingChecks ? t("发送前请核实 {0} 处", pendingChecks) : t("待核实事项已全部确认")}{checks.some(check => check.quote) && <small>{t("已在正文中标出")}</small>}</h3>
      {checks.map((check, index) => <div key={index} className={`bkw-check ${acks.has(index) ? "done" : ""}`} onMouseEnter={() => setActiveCheck(index)} onMouseLeave={() => setActiveCheck(undefined)}>
        <span className="bkw-check-no">{index + 1}</span>
        <span className="bkw-check-text">{check.item}</span>
        <button type="button" className="bkw-btn small" aria-pressed={acks.has(index)} onClick={() => toggleCheck(index)}>{acks.has(index) ? <><Icon name="check" size={13} />{t("已确认")}</> : t("没问题")}</button>
      </div>)}
    </section>}

    {task.status === "needs_info" && <section className="bkw-block bkw-supplement">
      <h3>{task.needsInfoKind === "attachments" ? t("附件读取受阻") : t("需要你补充信息")}</h3>
      {task.error && <p className="bkw-block-lead">{systemMessage(task.error)}</p>}
      {task.needsInfoKind === "attachments" && <p className="bkw-muted">{t("请检查文档读取工具和附件格式。修复后可重新处理，也可在下方补充附件文字。")}</p>}
      <Field label={t("补充信息")} hint={t("补充缺少的资料，工作台将结合原邮件继续处理。")}>
        <AutoTextarea maxLength={16000} value={supplement} onChange={event => setSupplement(event.target.value)} disabled={!!busy} placeholder={t("请输入需要补充的资料、说明或修正信息。")} />
      </Field>
      {task.ruleUpdated && <p className="bkw-muted">{t("直接提交将沿用原方案；若已调整处理要求或工具，请使用“按最新方案重新处理”。")}</p>}
      <div className="bkw-actions"><button type="button" className="bkw-btn primary" disabled={!!busy || !supplement.trim() || !modelReady} onClick={() => run("supplement", async () => { await api("supplement", { id: task.id, revision: task.revision, text: supplement }); setSupplement(""); await refresh(); notify(t("补充信息已保存，任务继续处理")); })}>{t("提交并继续处理")}</button></div>
    </section>}

    {task.status === "unmatched" && <section className="bkw-block">
      <h3>{t("为这条信息选择处理方案")}</h3>
      <p className="bkw-block-lead">{task.triage?.nextStep || t("没有自动命中方案，可以指定一个已配置的方案开始处理。")}</p>
      <div className="bkw-inline-form">
        <select aria-label={t("选择处理方案")} value={assignment} onChange={event => setAssignment(event.target.value)}>
          <option value="">{t("请选择方案")}</option>
          {data.rules.map(rule => <option key={rule.id} value={rule.id}>{rule.name}</option>)}
        </select>
        <button type="button" className="bkw-btn primary" disabled={!assignment || !!busy || !modelReady} onClick={() => run("runRule", async () => { await api("runRule", { id: task.id, ruleId: assignment, revision: task.revision }); await refresh(); notify(t("已加入处理队列")); })}>{t("开始处理")}</button>
      </div>
    </section>}

    {task.status === "ignored" && task.triage?.archived && <section className="bkw-block">
      <h3>{t("AI 已归档这条信息")}</h3>
      <p className="bkw-block-lead">{task.triage.reason || t("判断为无需处理的通知。")}</p>
      <div className="bkw-actions"><button type="button" className="bkw-btn" disabled={!!busy} onClick={() => run("restore", async () => { await api("restore", { id: task.id, revision: task.revision }); await refresh(); notify(t("已恢复，该发件人的信息以后不再自动归档")); })}><Icon name="undo" size={15} />{t("恢复到待处理")}</button></div>
    </section>}

    {["queued", "running"].includes(task.status) && <div className="bkw-progress"><span className="bkw-spinner" aria-hidden="true" /><div><strong>{task.triage?.state === "pending" ? t("AI 正在分拣") : task.status === "running" ? t("正在准备处理结果") : t("任务已加入队列")}</strong><span>{t("你可以继续处理其他任务，结果会自动更新。")}</span></div></div>}

    {task.summary && (task.outputKind === "report" || !task.draft) && <section className="bkw-block bkw-report">
      <h3>{task.outputKind === "report" ? t("分析报告") : t("处理摘要")}</h3>
      <div className="bkw-prose">{task.summary}</div>
      {task.informationGaps && task.status !== "review" && <div className="bkw-gaps"><strong>{t("待人工核实")}</strong><p>{task.informationGaps}</p><small>{t("以下事项不影响本次报告完成，可按需补充核实。")}</small></div>}
    </section>}

    {["sent", "uncertain"].includes(task.status) && <ReceiptPanel draft={task.draft} />}

    {wechat && task.wechat?.reply !== undefined && <section className="bkw-draft" aria-label={t("建议回复")}>
      <div className="bkw-draft-head">
        <h3>{t("建议回复")}</h3>
        <span className="bkw-muted">{replyDirty ? t("有未保存的修改") : task.status === "completed" ? t("已在微信中处理") : t("只读接入：复制后在微信中发送")}</span>
      </div>
      <HighlightedBody value={reply} disabled={!!busy || task.status !== "review"} checks={checks} active={activeCheck} onChange={setReply} />
    </section>}
    {wechat && task.wechat && <SegmentConversation task={task} />}

    {form && task.draft && <section className="bkw-draft" aria-label={t("回复草稿")}>
      <div className="bkw-draft-head">
        <h3>{t("回复草稿")}</h3>
        <span className="bkw-muted">{dirty ? t("有未保存的修改") : task.status === "sent" ? t("已发送") : autoActive ? t("等待自动发送") : t("人工审核后发送")}</span>
      </div>
      <div className="bkw-envelope">
        <div><span>{t("发件")}</span><strong>{data.accounts.find(account => account.id === task.draft!.account)?.label || task.draft.account}</strong></div>
        <label><span>{t("收件")}</span><input disabled={locked} value={form.to} onChange={event => { setForm({ ...form, to: event.target.value }); setPreview(null); }} placeholder="name@example.com" /></label>
        <label><span>{t("抄送")}</span><input disabled={locked} value={form.cc} onChange={event => { setForm({ ...form, cc: event.target.value }); setPreview(null); }} placeholder={t("可选，多个地址用逗号分隔")} /></label>
        <label><span>{t("主题")}</span><input disabled={locked} value={form.subject} onChange={event => { setForm({ ...form, subject: event.target.value }); setPreview(null); }} /></label>
      </div>
      <HighlightedBody value={form.text} disabled={locked} checks={checks} active={activeCheck} onChange={text => { setForm({ ...form, text }); setPreview(null); }} />
      {!!task.draft.attachments?.length && <div className="bkw-files">
        {task.draft.attachments.filter(file => form.attachments.includes(file.id)).map(file => <span key={file.id} className="bkw-file"><Icon name="file" size={15} />{file.filename}
          {!locked && <button type="button" className="bkw-icon-btn small" aria-label={t("从草稿移除附件 {0}", file.filename)} title={t("从草稿移除附件")} onClick={() => { setForm({ ...form, attachments: form.attachments.filter(id => id !== file.id) }); setPreview(null); }}><Icon name="close" size={12} /></button>}
        </span>)}
      </div>}
      {task.status === "review" && task.draft.state === "draft" && !autoActive && <div className="bkw-upload">
        <label className={`bkw-btn small ${locked || dirty ? "disabled" : ""}`}><Icon name="plus" size={13} />{busy === "uploadDraft" ? t("正在上传附件…") : t("添加附件")}
          <input type="file" multiple aria-label={t("添加草稿附件")} disabled={locked || dirty || task.draft.attachments.length >= 10} onChange={event => {
            const files = Array.from(event.currentTarget.files || []); event.currentTarget.value = "";
            if (!files.length) return;
            run("uploadDraft", async () => {
              if (task.draft!.attachments.length + files.length > 10) throw new Error(t("每份草稿最多 10 个附件，请减少选择的文件数量。"));
              if (files.reduce((size, file) => size + file.size, 0) > 20 * 1024 * 1024) throw new Error(t("本次选择的附件合计超过 20 MiB，请减少文件数量。"));
              setPreview(null);
              let current = task.draft!;
              for (const file of files) { current = await uploadDraftAttachment(current, file); await refresh(); }
              notify(t("已添加 {0} 个附件，请在发送预览中下载检查。", files.length));
            });
          }} />
        </label>
        <small>{dirty ? t("先保存草稿修改，再添加附件。") : t("最多 10 个附件，合计不超过 20 MiB。")}</small>
      </div>}
      {dirty && (task.revision !== taskRevision || task.draft.revision !== formRevision) && <Alert>{t("任务已更新。你的修改已保留，保存时将检查版本；请先核对新资料。")}<button type="button" className="bkw-link" onClick={() => {
        if (!window.confirm(t("放弃当前未保存的修改，并加载最新草稿？")) || !task.draft) return;
        const current = draftValue(task.draft); setForm(current); setOriginal(JSON.stringify(current)); setFormRevision(task.draft.revision); setTaskRevision(task.revision); cachedDraft = undefined;
      }}>{t("加载最新草稿")}</button></Alert>}
      {task.summary && <details className="bkw-basis"><summary>{t("处理摘要与依据")}</summary><div className="bkw-prose">{task.summary}</div></details>}
    </section>}

    {!task.draft && !task.summary && !["queued", "running", "unmatched", "needs_info", "ignored"].includes(task.status) && !task.error && <p className="bkw-muted">{t("处理完成后，摘要和草稿会显示在这里。")}</p>}
  </>;

  const canIgnore = !["sent", "sending", "uncertain", "ignored", "running", "completed"].includes(task.status);
  const canRetry = ["failed", "needs_info", "review"].includes(task.status);
  const canLatest = !!latestRule && ["failed", "needs_info", "review", "completed"].includes(task.status);
  const footer = <div className="bkw-ws-foot">
    <div className="bkw-actions">
      {task.status === "uncertain" && task.canResolveSend && task.draft && <>
        <button type="button" className="bkw-btn" disabled={!!busy} onClick={() => { setResolutionChecked(false); setResolution({ draftRevision: task.draft!.revision, outcome: "not_sent" }); }}>{t("确认未发送，恢复草稿")}</button>
        <button type="button" className="bkw-btn" disabled={!!busy} onClick={() => { setResolutionChecked(false); setResolution({ draftRevision: task.draft!.revision, outcome: "sent" }); }}>{t("确认已发送，标记完成")}</button>
      </>}
      {canIgnore && <button type="button" className="bkw-btn ghost" disabled={!!busy || dirty} onClick={() => setConfirmIgnore(true)}>{t("忽略")}</button>}
      {(canRetry || canLatest) && <div className="bkw-menu-wrap">
        <button type="button" className="bkw-btn ghost" aria-haspopup="menu" aria-expanded={menu} disabled={!!busy || dirty || !modelReady} onClick={() => setMenu(!menu)}><Icon name="refresh" size={15} />{t("重新处理")}</button>
        {menu && <div className="bkw-menu" role="menu" onMouseLeave={() => setMenu(false)}>
          {canRetry && <button type="button" role="menuitem" onClick={() => { setMenu(false); run("retry", async () => { await api("retry", { id: task.id, revision: task.revision }); await refresh(); notify(t("已重新加入处理队列")); }); }}><strong>{t("按原方案重试")}</strong><small>{t("使用处理时的方案快照")}</small></button>}
          {canLatest && <button type="button" role="menuitem" onClick={() => { setMenu(false); setRerun({ rule: latestRule!, configRevision: data.revision, text: supplement.trim() }); }}><strong>{t("按最新方案重新处理")}</strong><small>{t("使用方案当前保存的要求和工具")}</small></button>}
        </div>}
      </div>}
    </div>
    <div className="bkw-actions">
      {wechat && <>
        {replyDirty && <button type="button" className="bkw-btn" disabled={!!busy} onClick={saveReply}>{busy === "saveReply" ? t("保存中…") : t("保存修改")}</button>}
        {task.status === "review" && !!reply && <button type="button" className="bkw-btn" disabled={!!busy || replyDirty} onClick={copyReply}><Icon name="copy" size={15} />{t("复制回复")}{!replyDirty && <kbd>⌘↵</kbd>}</button>}
        {["review", "needs_info", "unmatched", "failed"].includes(task.status) && <button type="button" className="bkw-btn primary" disabled={!!busy || replyDirty} onClick={markHandled}><Icon name="check" size={15} />{t("已在微信处理")}</button>}
      </>}
      {task.draft && task.status === "review" && !autoActive && <>
        {dirty && <button type="button" className="bkw-btn" disabled={locked} onClick={() => run("saveDraft", saveDraft)}>{busy === "saveDraft" ? t("保存中…") : t("保存草稿")}</button>}
        <button type="button" className="bkw-btn primary" disabled={!canSend} title={dirty ? t("请先保存修改再审核发送") : undefined} onClick={openPreview}><Icon name="send" size={15} />{t("预览并发送")}<kbd>⌘↵</kbd></button>
      </>}
      {onDone && !["review", "needs_info", "unmatched"].includes(task.status) && <button type="button" className="bkw-btn" onClick={onDone}>{t("下一项")}<Icon name="arrow" size={14} /></button>}
    </div>
  </div>;

  return <div className={`bkw-ws show-${mobilePane}`}>
    <div className="bkw-ws-switch" role="tablist" aria-label={t("任务详情内容")}>
      <button type="button" role="tab" aria-selected={mobilePane === "result"} onClick={() => setMobilePane("result")}>{t("AI 处理结果")}</button>
      <button type="button" role="tab" aria-selected={mobilePane === "source"} onClick={() => setMobilePane("source")}>{t("原始信息")}</button>
    </div>
    <section className="bkw-ws-main" aria-label={t("AI 处理结果")}>
      <div className="bkw-ws-scroll">{header}<div className="bkw-ws-body">{result}</div></div>
      {footer}
    </section>
    <aside className="bkw-ws-source" aria-label={t("原始信息")}>
      <div className="bkw-subtabs" role="tablist">
        {([["mail", wechat ? t("聊天记录") : t("原邮件")], ["related", related.length ? t("相关往来 {0}", related.length) : t("相关往来")], ["history", t("记录")]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={sourceTab === id} onClick={() => setSourceTab(id)}>{label}</button>)}
      </div>
      <div className="bkw-ws-source-body">
        {sourceTab === "mail" && wechat && task.wechat && <ChatHistory chat={task.wechat.chat} group={task.wechat.group} current={task.id} />}
        {sourceTab === "mail" && !wechat && <>
          <div className="bkw-mail-head">
            <strong>{task.subject || t("无主题邮件")}</strong>
            <dl>
              <dt>{t("发件人")}</dt><dd>{task.from}</dd>
              {task.replyTo && !task.from.includes(task.replyTo) && <><dt>{t("回复地址")}</dt><dd>{task.replyTo}</dd></>}
              <dt>{t(task.to ? "收件人" : "收件账号")}</dt><dd>{task.to || data.accounts.find(account => account.id === task.account)?.label || task.account}</dd>
              {task.cc && <><dt>{t("抄送")}</dt><dd>{task.cc}</dd></>}
              <dt>{t("时间")}</dt><dd>{fullDate(task.mailDate || task.receivedAt)}</dd>
              {task.mailSize !== undefined && <><dt>{t("大小")}</dt><dd>{Math.max(1, Math.ceil(task.mailSize / 1024))} KB</dd></>}
            </dl>
            <button type="button" className="bkw-btn small" disabled={!!busy || dirty || !mailReady || ["running", "sending"].includes(task.status)} title={dirty ? t("请先保存草稿修改，再读取原邮件") : undefined} onClick={() => run("loadMail", async () => { await api("loadMail", { id: task.id, revision: task.revision }); await refresh(); notify(t("原邮件与附件信息已更新")); })}>
              <Icon name="refresh" size={13} />{busy === "loadMail" ? t("读取中…") : task.body ? t("重新读取") : t("读取原邮件")}
            </button>
          </div>
          {!!task.attachments?.length && <div className="bkw-attachments" aria-label={t("邮件附件")}>
            {task.attachments.map((item, index) => <div key={index} className="bkw-attachment">
              <span className={`bkw-file-badge ${/\.pdf$/i.test(item.filename) ? "pdf" : ""}`}>{item.filename.includes(".") ? item.filename.split(".").pop()!.slice(0, 4).toUpperCase() : "FILE"}</span>
              <span><strong title={item.filename}>{item.filename}</strong><small>{Math.ceil(item.size / 1024)} KB</small></span>
              <button type="button" className="bkw-link" disabled={!!busy || !mailReady} onClick={() => run(`download-${index}`, () => downloadOriginal(task, index, item.filename))}>{busy === `download-${index}` ? t("下载中…") : t("下载")}</button>
            </div>)}
          </div>}
          {task.hasAttachments && !task.mailLoaded && !task.attachments?.length && <p className="bkw-muted">{t("这封邮件包含附件，读取原邮件后可查看附件列表。")}</p>}
          <OriginalMailBody key={task.id} html={task.bodyHtml} text={task.body || (["unmatched", "queued"].includes(task.status) ? t("点击“读取原邮件”查看正文，无需启动自动处理。") : t("邮件正文为空"))} />
        </>}
        {sourceTab === "related" && <div className="bkw-related">
          {!related.length && <p className="bkw-muted">{t("没有找到同一会话或相同主题的往来。")}</p>}
          {related.map(item => <button type="button" key={item.id} className="bkw-related-item" onClick={() => go({ view: "items", task: item.id })}>
            <span className="bkw-related-meta"><SourceTag kind={sourceOf(item)} />{task.relatedIds?.includes(item.id) ? (wechat ? t("同一聊天") : t("同一会话")) : t("可能相关")}<time>{when(item.receivedAt)}</time></span>
            <strong>{taskTitle(item)}</strong>
            <span className="bkw-muted">{counterpart(item)} · {statusLabel(item)}</span>
          </button>)}
          {!!task.possibleIds?.length && <p className="bkw-footnote">{t("“可能相关”只按发件人和主题推断，不会自动合并。")}</p>}
        </div>}
        {sourceTab === "history" && <div className="bkw-timeline">
          {task.history?.length ? task.history.slice().reverse().map((event, index) => <div key={index}><i /><time>{fullDate(event.at)}</time><p>{systemMessage(event.message)}</p></div>) : <p className="bkw-muted">{t("尚无处理记录")}</p>}
        </div>}
      </div>
    </aside>

    {confirmIgnore && <Modal title={t("忽略这项任务？")} onClose={() => setConfirmIgnore(false)}>
      <p className="bkw-dialog-description">{t("任务和处理记录会保留在“全部事项”中，不会删除原邮件。")}</p>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" onClick={() => setConfirmIgnore(false)}>{t("取消")}</button>
        <button type="button" className="bkw-btn primary" disabled={!!busy} onClick={() => run("ignore", async () => { await api("ignore", { id: task.id, revision: task.revision }); await refresh(); setConfirmIgnore(false); notify(t("任务已忽略")); })}>{t("确认忽略")}</button></div>
    </Modal>}
    {rerun && <Modal title={t("按最新方案重新处理")} onClose={() => { if (!busy) setRerun(undefined); }}>
      <p>{t("将使用“{0}”当前保存的处理要求和工具配置重新分析。", rerun.rule.name)}</p>
      <p className="bkw-muted">{t("原处理结果保留在处理记录中，原草稿保留，不会自动发送邮件。")}</p>
      {rerun.text && <p>{t("本次填写的补充信息将一并提交。")}</p>}
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" disabled={!!busy} onClick={() => setRerun(undefined)}>{t("取消")}</button>
        <button type="button" className="bkw-btn primary" disabled={!!busy || !modelReady} onClick={() => run("runRule", async () => {
          await api("runRule", { id: task.id, revision: task.revision, ruleId: rerun.rule.id, ruleRevision: rerun.configRevision, ...(rerun.text ? { text: rerun.text } : {}) });
          setRerun(undefined); setSupplement(""); await refresh(); notify(t("已按最新方案加入处理队列"));
        })}>{busy === "runRule" ? t("正在提交…") : t("确认重新处理")}</button></div>
    </Modal>}
    {resolution && task.draft && <Modal title={resolution.outcome === "sent" ? t("确认发送结果") : t("恢复待审核草稿")} onClose={() => { if (!busy) setResolution(undefined); }}>
      <p>{resolution.outcome === "sent" ? t("请先核对邮箱发送记录或收件方确认，再将任务标记为已发送。这只是人工核对记录，不会发送邮件。") : t("请先核对邮箱发送记录与相关回执，确认上次邮件未发送后再恢复。恢复后保留原正文和附件，需要重新预览并手动发送。")}</p>
      <label className="bkw-checkbox"><input type="checkbox" checked={resolutionChecked} disabled={!!busy} onChange={event => setResolutionChecked(event.target.checked)} />{resolution.outcome === "sent" ? t("我已核对，确认邮件已发送") : t("我已核对，确认邮件未发送")}</label>
      <div className="bkw-dialog-actions"><button type="button" className="bkw-btn" disabled={!!busy} onClick={() => setResolution(undefined)}>{t("取消")}</button>
        <button type="button" className="bkw-btn primary" disabled={!!busy || !resolutionChecked} onClick={() => run("resolveSend", async () => {
          await api("resolveSend", { id: task.id, revision: task.revision, draftRevision: resolution.draftRevision, outcome: resolution.outcome, confirmed: true });
          const outcome = resolution.outcome; setResolution(undefined); await refresh();
          notify(outcome === "sent" ? t("已按人工核对结果标记为已发送") : t("已恢复待审核草稿，请修复连接后重新预览发送"));
        })}>{busy === "resolveSend" ? t("正在提交…") : t("确认核对结果")}</button></div>
    </Modal>}
    {preview && task.draft && reviewForm && <Modal wide title={t("确认发送邮件")} onClose={() => { if (!busy) setPreview(null); }}>
      <p className="bkw-dialog-description">{t("请核对以下内容。点击“确认发送”后，邮件将提交至发件服务器。")}</p>
      {pendingChecks > 0 && <Alert tone="warn">{t("还有 {0} 处待核实事项未确认。", pendingChecks)}</Alert>}
      <dl className="bkw-kv">
        <dt>{t("发件人")}</dt><dd>{preview.from?.address ? `${preview.from.name ? preview.from.name + " " : ""}<${preview.from.address}>` : data.accounts.find(account => account.id === task.draft!.account)?.label || task.draft.account}</dd>
        <dt>{t("收件人")}</dt><dd>{reviewForm.to}</dd>
        {reviewForm.cc && <><dt>{t("抄送")}</dt><dd>{reviewForm.cc}</dd></>}
        <dt>{t("主题")}</dt><dd>{reviewForm.subject}</dd>
      </dl>
      {preview.matching?.blocked && <Alert tone="danger">{t("有收件人命中禁止发送规则。请返回修改收件人，或在邮件插件中检查收件人策略。")}</Alert>}
      {!!preview.matching?.rows?.length && <div className="bkw-recipients">{preview.matching.rows.map((row, index) => <div key={index}><span>{row.field === "cc" ? t("抄送") : t("收件人")} · {row.address}</span><Tag tone={row.blocked ? "danger" : row.matched ? "good" : "muted"}>{row.blocked ? t("禁止发送{0}", row.value ? " · " + row.value : "") : row.matched ? t("可信收件人") : t("人工确认")}</Tag></div>)}</div>}
      {preview.bodyHtml ? <iframe className="bkw-mail-preview" title={t("邮件正文预览")} sandbox="" referrerPolicy="no-referrer" srcDoc={preview.bodyHtml} /> : <pre className="bkw-send-body">{reviewForm.text}</pre>}
      {preview.attachments?.length ? <div className="bkw-files">{preview.attachments.map(file => <span key={file.id} className="bkw-file"><Icon name="file" size={14} />{file.filename} · {Math.ceil(file.size / 1024)} KB
        <button type="button" className="bkw-link" disabled={!!busy} onClick={() => run("download", async () => { const id = preview.id || preview.planId; if (!id) throw new Error(t("预览已失效，请重新审核。")); await downloadPreview(id, file); })}>{t("下载检查")}</button></span>)}</div> : <p className="bkw-muted">{t("本次发送不包含附件。")}</p>}
      {(previewChanged || previewExpired) && <Alert>{previewChanged ? t("任务或草稿已更新，请返回并重新审核最新内容。") : t("发送预览已过期，请返回并重新审核。")}</Alert>}
      <p className="bkw-footnote">{t("附件已固定为本次预览快照。预览有效期为 10 分钟，修改草稿后需重新审核。")}</p>
      <div className="bkw-dialog-actions">
        <button type="button" className="bkw-btn" disabled={!!busy} onClick={() => setPreview(null)}>{t("返回修改")}</button>
        <button type="button" className="bkw-btn primary" disabled={!!busy || previewChanged || previewExpired || preview.matching?.blocked === true} onClick={() => run("send", async () => {
          const planId = preview.planId || preview.id;
          if (!planId) throw new Error(t("发送预览缺少确认标识，请重新审核。"));
          try {
            const outcome = await api<{ draft?: Draft }>("send", { id: task.id, revision: preview.taskRevision, draftRevision: preview.draftRevision, planId, confirmed: true });
            if (outcome.draft?.state === "draft") throw new Error(t("邮件未提交，草稿已保留。请检查网络与发件服务器配置，修复后重新预览发送。"));
            if (outcome.draft?.state !== "sent") throw new Error(t("发送结果待核实，请先核对邮箱中的已发送邮件。工作台不会自动重发，请不要重复发送。"));
            if (outcome.draft.receipt?.rejected?.length) throw new Error(t("SMTP 返回部分收件人被拒绝，请查看任务中的发送回执并核对邮箱。工作台不会自动重发。"));
            notify(t("邮件已提交，SMTP 已返回接受回执"));
            onDone?.();
          } finally { setPreview(null); await refresh(); }
        })}><Icon name="send" size={15} />{busy === "send" ? t("正在发送…") : t("确认发送")}</button>
      </div>
    </Modal>}
  </div>;
}

/** Clipboard with a fallback for hosts that block the async clipboard API. */
async function copyText(text: string): Promise<void> {
  try { await navigator.clipboard.writeText(text); return; } catch { /* fall back */ }
  const area = document.createElement("textarea");
  area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
  document.body.appendChild(area); area.select();
  const ok = document.execCommand("copy"); area.remove();
  if (!ok) throw new Error(t("无法写入剪贴板，请手动选中回复内容复制。"));
}

/** Editable draft body with the AI's check quotes highlighted behind the text. */
function HighlightedBody({ value, disabled, checks, active, onChange }: { value: string; disabled: boolean; checks: { item: string; quote?: string }[]; active?: number; onChange: (value: string) => void }) {
  const segments = useMemo(() => {
    const marks = checks.map((check, index) => ({ index, quote: check.quote })).filter(mark => mark.quote && value.includes(mark.quote!))
      .map(mark => ({ ...mark, start: value.indexOf(mark.quote!), end: value.indexOf(mark.quote!) + mark.quote!.length })).sort((a, b) => a.start - b.start);
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    for (const mark of marks) {
      if (mark.start < cursor) continue;
      parts.push(value.slice(cursor, mark.start));
      parts.push(<mark key={mark.index} className={active === mark.index ? "active" : ""}>{value.slice(mark.start, mark.end)}</mark>);
      cursor = mark.end;
    }
    parts.push(value.slice(cursor) + "\n");
    return parts;
  }, [value, checks, active]);
  return <div className="bkw-hl">
    <div className="bkw-hl-backdrop" aria-hidden="true">{segments}</div>
    <AutoTextarea aria-label={t("回复正文")} className="bkw-hl-input" disabled={disabled} value={value} onChange={event => onChange(event.target.value)} />
  </div>;
}

export function ReceiptPanel({ draft }: { draft?: Draft }) {
  const receipt = draft?.receipt;
  if (!receipt && draft?.state === "sent" && draft.sendChecks?.at(-1)?.outcome === "sent") return <Alert tone="success">{t("已由用户核对确认发送。这是人工核对记录，系统没有生成 SMTP 回执。")}</Alert>;
  if (!receipt) return <Alert>{t("未读取到 SMTP 回执详情。请核对邮箱记录，工作台不会自动重发。")}</Alert>;
  return <details className="bkw-block bkw-receipt" open={!!receipt.rejected?.length}>
    <summary><strong>{t("发送回执")}</strong><span className="bkw-muted">{receipt.rejected?.length ? t("存在被拒绝的收件人") : t("SMTP 已接受")}</span></summary>
    {!!receipt.rejected?.length && <Alert tone="danger">{t("存在被服务器拒绝的收件人。已接受的地址可能已收到邮件，请核对下方名单及邮箱后单独处理，工作台不会自动重发。")}</Alert>}
    <dl className="bkw-kv">
      <dt>{t("服务器已接受")}</dt><dd>{receipt.accepted?.length ? receipt.accepted.join(t("，")) : t("回执中没有已接受的地址")}</dd>
      <dt>{t("服务器已拒绝")}</dt><dd className={receipt.rejected?.length ? "bkw-danger-text" : ""}>{receipt.rejected?.length ? receipt.rejected.join(t("，")) : t("无")}</dd>
      {receipt.messageId && <><dt>Message-ID</dt><dd>{receipt.messageId}</dd></>}
    </dl>
    <pre className="bkw-code">{receipt.response || t("回执未提供响应文本")}</pre>
    <p className="bkw-footnote">{t("服务器接受表示已提交发送，最终送达情况以收件方和邮箱投递记录为准。")}</p>
  </details>;
}

export const nextStepOf = nextStep;
export const errorText = (error: unknown) => systemMessage(errorMessage(error));
