import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { language, systemMessage, t } from "./i18n";
import { useWorkbench } from "./context";
import { AUTONOMY_LABEL, CATEGORY, SOURCE, api, errorMessage, sourceName, when, type Autonomy, type Capabilities, type Category, type MatchMode, type Rule } from "./lib";
import { Alert, AutoTextarea, Empty, Field, Icon, Switch, Tag } from "./ui";
import { ClassifierEditor, blankClassifier } from "./classifiers";
import { previewVariables, unknownVariables, useVariableMenu, type Profile } from "./variables";

const DEFAULT_EXCLUDE: Category[] = ["notification", "marketing"];
const CATEGORY_HINT: Record<Category, string> = { request: "对方需要你做事，例如询价、申请、安排", reply_needed: "需要回复，但不涉及业务请求", fyi: "值得知道，无需行动；进入每日简报", notification: "系统通知、提醒、账单、验证码；自动归档", marketing: "营销推广、订阅资讯；自动归档", other: "无法归类，交你判断" };
const AUTONOMY_HINT: Record<Autonomy, string> = {
  draft: "AI 只准备结果，所有对外发送由你确认。",
  low_risk: "仅确认收到、致谢这类简单回复会在撤回窗口后自动发送，其余交你审核。",
  auto: "满足安全条件的回复都会在撤回窗口后自动发送。只建议用于你完全信任的方案。",
};
const blank = (accounts: { id: string; inboxFolder?: string }[]): Rule => ({ id: "", name: "", enabled: true, priority: 100, account: accounts[0]?.id || "", folder: accounts[0]?.inboxFolder || "INBOX", match: { from: "", subject: "", hasAttachments: false, mode: "all" }, instructions: "", tools: [], output: "reply", maxRetries: 1 });

export function PlansView({ ruleId }: { ruleId?: string }) {
  const { data, go } = useWorkbench();
  const sorted = [...data.rules].sort((a, b) => b.priority - a.priority);
  const week = Date.now() - 7 * 864e5;
  const hits = (id: string) => data.tasks.filter(task => task.ruleId === id && Date.parse(task.receivedAt) >= week).length;
  const corrections = (id: string) => (data.ruleExamples?.[id] ?? []).filter(example => !example.match).length;
  const open = (route: string) => go({ view: "plans", rule: route });
  // Classification schemes live under "c:<id>" (or "c:new") in the same page.
  const classifierId = ruleId?.startsWith("c:") ? ruleId.slice(2) : undefined;
  const classifiers = data.classifiers ?? [];
  const classifier = classifierId && classifierId !== "new" ? classifiers.find(item => item.id === classifierId) : undefined;
  const selected = ruleId === "new" || classifierId ? undefined : ruleId === "triage" ? undefined : data.rules.find(rule => rule.id === ruleId) ?? (ruleId ? undefined : sorted[0]);
  const showTriage = ruleId === "triage" || (!ruleId && !sorted.length);
  return <div className="bkw-plans">
    <div className="bkw-pipeline" aria-label={t("每条信息的处理路径")}>
      {[t("收集"), t("AI 分拣：是什么、要不要处理"), t("匹配方案"), t("执行"), t("按自主级别：自动完成，或交你决策")].map((step, index) => <React.Fragment key={index}>{index > 0 && <Icon name="arrow" size={12} />}<span className={index === 1 ? "on" : ""}><b>{index + 1}</b>{step}</span></React.Fragment>)}
    </div>
    <div className="bkw-plans-body">
      <nav className="bkw-topic-nav" aria-label={t("方案列表")}>
        <button type="button" className="bkw-btn primary block" onClick={() => open("new")}><Icon name="plus" size={15} />{t("新建方案")}</button>
        <div className="bkw-nav-group"><h4>{t("分拣（所有信息先经过）")}</h4>
          <button type="button" className={`bkw-nav-item tall ${showTriage ? "on" : ""}`} onClick={() => open("triage")}><span><strong>{t("AI 分拣")}</strong><small>{t("通知归档 · 识别请求 · 选择方案")}</small></span><Tag tone={data.defaults.triage ? "good" : "muted"}>{data.defaults.triage ? t("已开启") : t("已关闭")}</Tag></button>
        </div>
        <div className="bkw-nav-group"><h4>{t("业务分类")}</h4>
          {classifiers.map(item => <button type="button" key={item.id} className={`bkw-nav-item tall ${classifierId === item.id ? "on" : ""} ${item.enabled ? "" : "paused"}`} onClick={() => open("c:" + item.id)}>
            <span><strong>{item.name}</strong><small>{t("{0} 个分类 · 待人工 {1}", item.categories.length, data.tasks.filter(task => task.classification?.classifierId === item.id && task.classification.state === "pending").length)}</small></span>
            {!item.enabled && <Tag>{t("已停用")}</Tag>}
          </button>)}
          <button type="button" className={`bkw-nav-item ${classifierId === "new" ? "on" : ""}`} onClick={() => open("c:new")}><Icon name="plus" size={14} /><span>{t("新建分类方案")}</span></button>
        </div>
        <div className="bkw-nav-group"><h4>{t("处理方案")}</h4>
          {sorted.map(rule => <button type="button" key={rule.id} className={`bkw-nav-item tall ${selected?.id === rule.id && !showTriage ? "on" : ""} ${rule.enabled ? "" : "paused"}`} onClick={() => open(rule.id)}>
            <span><strong>{rule.name}</strong><small>{rule.enabled ? corrections(rule.id) ? t("本周命中 {0} 次 · 纠正 {1} 次", hits(rule.id), corrections(rule.id)) : t("本周命中 {0} 次 · {1}", hits(rule.id), rule.output === "reply" ? t("回复草稿") : rule.output === "dispatch" ? t("分派到 {0}", rule.dispatchFolder || "") : t("分析报告")) : t("已停用")}</small></span>
            {rule.output === "dispatch" ? <Tag tone="accent">{t("分派")}</Tag> : <Tag tone={rule.autonomy === "auto" ? "warn" : rule.autonomy === "low_risk" ? "accent" : "muted"}>{t(AUTONOMY_LABEL[rule.autonomy || "draft"])}</Tag>}
          </button>)}
          {!sorted.length && <p className="bkw-card-empty">{t("还没有处理方案。")}</p>}
        </div>
      </nav>
      <div className="bkw-plan-main">
        {classifierId === "new" ? <ClassifierEditor key="c:new" classifier={blankClassifier(data.accounts)} /> : classifier ? <ClassifierEditor key={classifier.id} classifier={classifier} /> : classifierId ? <Empty icon="rules" title={t("分类方案不存在")} text={t("它可能已被删除。")} /> : showTriage ? <TriagePanel /> : ruleId === "new" ? <RuleEditor key="new" rule={blank(data.accounts)} /> : selected ? <RuleEditor key={selected.id} rule={selected} /> :
          <Empty icon="rules" title={t("让信息自动进入你的工作流程")} text={t("用一句话说清处理哪些信息、怎么处理。AI 生成方案，你核对后保存。")}><button type="button" className="bkw-btn primary" onClick={() => open("new")}>{t("创建第一个方案")}</button></Empty>}
      </div>
    </div>
  </div>;
}

function TriagePanel() {
  const { data, busy, perform, refresh, notify } = useWorkbench();
  return <div className="bkw-plan-form">
    <header className="bkw-plan-head"><div><h2>{t("AI 分拣")}</h2><p className="bkw-muted">{t("每条新信息先判断“是什么、要不要处理、交给哪个方案”，再进入方案。系统通知和营销邮件默认直接归档，不会被当作业务来信处理。")}</p></div>
      <Switch label={t("AI 分拣")} checked={data.defaults.triage} disabled={!!busy} onChange={value => void perform("triage", async () => { await api("saveSettings", { revision: data.revision, settings: { triage: value } }); await refresh(); notify(value ? t("已开启 AI 分拣") : t("已关闭 AI 分拣，按字面条件匹配方案")); })} />
    </header>
    {!data.health.triage && data.defaults.triage && <Alert tone="warn">{t("DSH 默认模型未就绪，当前用规则判断代替 AI 分拣：只能识别明显的通知和营销邮件；设为“AI 确认后处理”的方案不会自动接收信息，会交给你选择。")}</Alert>}
    <div className="bkw-sec"><div><b>{t("分类")}</b><span>{t("AI 为每条信息选择一个类别")}</span></div>
      <div className="bkw-kv-rows">{(Object.keys(CATEGORY) as Category[]).map(id => <div key={id}><span>{t(CATEGORY[id])}</span><small className="bkw-muted">{t(CATEGORY_HINT[id])}</small></div>)}</div>
    </div>
    <div className="bkw-sec"><div><b>{t("匹配方案")}</b><span>{t("分类决定要不要处理，匹配决定交给哪个方案")}</span></div>
      <div className="bkw-kv-rows">{MATCH_STEPS.map(([title, hint]) => <div key={title}><span>{t(title)}</span><small className="bkw-muted">{t(hint)}</small></div>)}</div>
    </div>
    <div className="bkw-sec"><div><b>{t("可撤销")}</b><span>{t("归档不会改动邮箱")}</span></div>
      <p className="bkw-muted">{t("归档只在工作台内进行，原邮件保留在邮箱中。在“AI 已代办”中恢复后，该发件人的信息以后不再自动归档。")}</p>
    </div>
  </div>;
}

const MATCH_STEPS: [string, string][] = [
  ["把握高", "直接按方案处理，事项上显示匹配理由"],
  ["把握一般或低", "不处理，在“待我决策”里建议方案，由你确认或点“不是这个”"],
  ["没有合适方案", "列为未匹配，可手动选择方案或忽略"],
  ["没有可用的 AI", "只有设为“字面命中就处理”的方案会自动接收"],
  ["你的确认与纠正", "记为方案的例子，之后判断相似信息时参考"],
];
const MATCH_MODES: [MatchMode, string, string][] = [
  ["ai", "AI 确认后处理（推荐）", "AI 判断符合适用说明才处理；拿不准时交给你确认；没有 AI 时不自动处理。"],
  ["literal", "字面命中就处理", "符合来源、文件夹和字面条件的信息都交给这个方案，不经 AI 判断。适合专用文件夹，例如“招聘简历”。"],
];

/** A Date as the value of a datetime-local input, in local time. */
export const localInput = (date: Date) => new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
function RuleEditor({ rule }: { rule: Rule }) {
  const { data, busy, perform, refresh, notify, go, leave } = useWorkbench();
  const [value, setValue] = useState<Rule>({ ...rule, match: { ...rule.match }, tools: [...rule.tools] });
  const dispatch = value.output === "dispatch";
  // Existing folders as suggestions for the dispatch target; a new name is created on the first dispatch.
  const [dispatchFolders, setDispatchFolders] = useState<string[]>([]);
  useEffect(() => {
    if (!dispatch || !data.accounts.length) return;
    let active = true;
    api<{ folders: { path: string }[] }>("folders", { account: value.account }).then(result => { if (active) setDispatchFolders(result.folders.map(folder => folder.path).filter(path => path !== value.folder)); }).catch(() => {});
    return () => { active = false; };
  }, [dispatch, value.account, value.folder]);
  const [saved, setSaved] = useState(JSON.stringify(rule));
  const [description, setDescription] = useState(""), [generating, setGenerating] = useState(false), [warnings, setWarnings] = useState<string[]>([]), [aiError, setAiError] = useState("");
  const [optimizing, setOptimizing] = useState(false), [optimization, setOptimization] = useState<string>(), [optimizeError, setOptimizeError] = useState("");
  const [trial, setTrial] = useState<{ by: string; items: { id: string; subject: string; from: string; matched: boolean; reason: string }[] }>(), [trialing, setTrialing] = useState(false), [trialError, setTrialError] = useState("");
  const [validation, setValidation] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
  /** Configuration revision this editor started from; a concurrent change is reported instead of overwritten. */
  const [base, setBase] = useState(data.revision);
  const formRef = useRef<HTMLFormElement>(null);
  const [showPreview, setShowPreview] = useState(false);
  const profile = (data.settings as { profile?: Profile }).profile;
  const unknown = unknownVariables(value.instructions);
  // Typing "/" in the instructions lists the variables; choosing one replaces the "/" with {{name}}.
  const variables = useVariableMenu(value.instructions, instructions => patch({ instructions }));
  const dirty = JSON.stringify(value) !== saved || !!description.trim();
  const working = !!busy || generating || optimizing || trialing;
  const aiReady = !!data.health.agent;
  const exclude = value.exclude ?? DEFAULT_EXCLUDE;
  const examples = rule.id ? data.ruleExamples?.[rule.id] ?? [] : [];
  const autonomy = value.autonomy ?? "draft";
  useEffect(() => { leave.current = () => !dirty || window.confirm(t("方案有尚未保存的修改，确认放弃？")); return () => { leave.current = undefined; }; }, [dirty]);
  const patch = (partial: Partial<Rule>) => { setValue(current => ({ ...current, ...partial })); setValidation(""); setTrial(undefined); if (partial.instructions !== undefined) setOptimization(undefined); };
  const match = (partial: Partial<Rule["match"]>) => patch({ match: { ...value.match, ...partial } });
  const generate = async () => {
    if (working || !description.trim()) return;
    setGenerating(true); setAiError("");
    try {
      const result = await api<{ rule: Rule; warnings: string[] }>("generateRule", { description, account: value.account, folder: value.folder });
      setValue({ ...result.rule, id: value.id, revision: value.revision, enabled: value.enabled, priority: value.priority, maxRetries: value.maxRetries, autonomy: value.autonomy, exclude: value.exclude });
      setWarnings(result.warnings); setDescription("");
    } catch (error) { setAiError(errorMessage(error)); } finally { setGenerating(false); }
  };
  const optimize = async () => {
    if (working || value.instructions.trim().length < 5) return;
    setOptimizing(true); setOptimizeError(""); setOptimization(undefined);
    try { setOptimization((await api<{ instructions: string }>("optimizeInstructions", { instructions: value.instructions })).instructions); }
    catch (error) { setOptimizeError(errorMessage(error)); } finally { setOptimizing(false); }
  };
  // Trial over recent items, or over mail received in a time range read straight from the mailbox (history included).
  const [trialRange, setTrialRange] = useState(false), [trialSince, setTrialSince] = useState(""), [trialUntil, setTrialUntil] = useState("");
  const runTrial = async () => {
    setTrialing(true); setTrialError(""); setTrial(undefined);
    const range = trialRange && trialSince ? { since: new Date(trialSince).toISOString(), ...(trialUntil ? { until: new Date(trialUntil).toISOString() } : {}), ...(data.accounts[0] ? { account: data.accounts[0].id } : {}) } : undefined;
    try { setTrial(await api("trialRule", { rule: value, ...(range ? { range } : {}) })); } catch (error) { setTrialError(errorMessage(error)); } finally { setTrialing(false); }
  };
  const save = () => {
    const form = formRef.current!;
    const invalid = form.querySelector<HTMLInputElement | HTMLTextAreaElement>("input:invalid, textarea:invalid, select:invalid");
    if (invalid) { setValidation(t("请检查标出的必填项、文本长度或数值范围。")); for (let parent = invalid.parentElement; parent; parent = parent.parentElement) if (parent instanceof HTMLDetailsElement) parent.open = true; requestAnimationFrame(() => { invalid.focus(); invalid.reportValidity(); }); return; }
    void perform("saveRule", async () => {
      const result = await api<Rule>("saveRule", { rule: value, revision: base });
      const next = { ...value, id: result.id };
      setValue(next); setSaved(JSON.stringify(next)); setBase(result.revision ?? base + 1); setDescription(""); leave.current = undefined;
      await refresh(); go({ view: "plans", rule: result.id }); notify(t("方案已保存"));
    });
  };
  const literal = [value.match.from && t("发件人包含 {0}", value.match.from), value.match.subject && t("主题包含 {0}", value.match.subject), value.match.hasAttachments && t("带附件")].filter(Boolean).join(value.match.mode === "all" ? t("，且 ") : t("，或 "));
  return <form ref={formRef} className="bkw-plan-form" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
    <header className="bkw-plan-head">
      <div><h2>{rule.id ? value.name || t("未命名方案") : t("新建方案")}</h2><p className="bkw-muted">{rule.id ? t("修改只影响之后的处理，历史事项保留当时的方案快照。") : t("用一句话描述，AI 帮你填好下面的设置。")}</p></div>
      <label className="bkw-switch-label"><Switch label={t("启用方案")} checked={value.enabled} onChange={enabled => patch({ enabled })} />{value.enabled ? t("已启用") : t("已停用")}</label>
    </header>
    {validation && <Alert tone="danger">{validation}</Alert>}
    <fieldset disabled={working} className="bkw-plan-fields">
      <div className="bkw-sec"><div><b>{t("一句话描述")}</b><span>{t("AI 会生成下面的设置")}</span></div>
        <div>
          <div className="bkw-inline-form"><textarea aria-label={t("用一句话描述处理需求")} rows={2} maxLength={8000} value={description} onChange={event => setDescription(event.target.value)} placeholder={t("例如：客户来询价时，按我们的价格表起草正式报价；资料不全就起草补充询问。")} />
            <button type="button" className="bkw-btn primary" disabled={!description.trim() || !aiReady || !data.accounts.length} onClick={() => void generate()}><Icon name="sparkle" size={14} />{generating ? t("正在生成…") : t("AI 生成")}</button></div>
          {!aiReady && <small className="bkw-muted">{t("配置 DSH 默认模型后可使用 AI，也可直接手动填写。")}</small>}
          {aiError && <Alert tone="danger">{systemMessage(aiError)}</Alert>}
          {!!warnings.length && <div className="bkw-warnings"><strong>{t("需要核对 {0} 项", warnings.length)}</strong><ul>{warnings.map((warning, index) => <li key={index}>{systemMessage(warning)}</li>)}</ul></div>}
        </div>
      </div>
      <div className="bkw-sec"><div><b>{t("什么信息适用")}</b><span>{t("先看来源和字面条件，再由 AI 按含义判断")}</span></div>
        <div className="bkw-stack">
          <div className="bkw-chips">{[...new Set([...Object.keys(SOURCE).filter(kind => kind !== "meeting"), ...(data.channelInfo ?? []).map(item => item.kind)])].map(kind => {
            // Email and installed channels can feed a workflow; a workflow keeps at least one source. Dispatch is for mail only.
            const selected = value.sources ?? ["email"], on = selected.includes(kind), installed = data.channelInfo?.find(item => item.kind === kind);
            const available = kind === "email" || (!dispatch && (on || (!!installed && (installed.enabled || !!data.sources.find(source => source.kind === kind)?.connected))));
            const toggle = () => { const next = on ? selected.filter(item => item !== kind) : [...selected, kind]; if (next.length) patch({ sources: next }); };
            return <button type="button" key={kind} className={`bkw-chip ${on ? "on" : ""}`} disabled={!available} aria-pressed={on} title={available ? undefined : t("尚未接入")} onClick={toggle}>{sourceName(kind, data.channelInfo)}{!available && <small>{t("未接入")}</small>}</button>;
          })}</div>
          <div className="bkw-grid2">
            <Field label={t("邮箱")}><select value={value.account} onChange={event => patch({ account: event.target.value, folder: data.accounts.find(account => account.id === event.target.value)?.inboxFolder || "INBOX" })}>{data.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}<option value="">{t("全部邮箱")}</option></select></Field>
            <Field label={t("文件夹")}><FolderPicker account={value.account} value={value.folder} ready={!!data.accounts.length} defaultFolder={data.accounts.find(account => account.id === value.account)?.inboxFolder || "INBOX"} onChange={folder => patch({ folder })} /></Field>
          </div>
          <div className="bkw-field"><span>{t("匹配方式")}</span><div className="bkw-levels two" role="radiogroup" aria-label={t("匹配方式")}>
            {MATCH_MODES.map(([mode, title, hint]) => <button type="button" role="radio" key={mode} aria-checked={(value.matchMode ?? "ai") === mode} className={`bkw-level ${(value.matchMode ?? "ai") === mode ? "on" : ""}`} onClick={() => patch({ matchMode: mode })}><strong>{t(title)}</strong><small>{t(hint)}</small></button>)}
          </div></div>
          {(value.matchMode ?? "ai") === "ai" && <Field label={t("适用说明")} hint={t("写清楚适用和不适用的情况，AI 按这段判断。没写时只能参考方案名称和处理要求，容易误判。")}><textarea rows={2} maxLength={1000} value={value.semantic || ""} onChange={event => patch({ semantic: event.target.value })} placeholder={t("例如：客户正式下单、改单或催单；不包括询价、售后、发票和内部通知")} /></Field>}
          {(value.matchMode ?? "ai") === "ai" && !value.semantic?.trim() && <Alert tone="warn">{t("建议填写适用说明，尤其是名称宽泛的方案（如“订单处理”）。")}</Alert>}
          <div className="bkw-field"><span>{t("不处理这些类别")}</span><div className="bkw-chips">{(["notification", "marketing", "fyi", "other"] as Category[]).map(category => <label key={category} className={`bkw-chip ${exclude.includes(category) ? "on" : ""}`}><input type="checkbox" checked={exclude.includes(category)} onChange={() => patch({ exclude: exclude.includes(category) ? exclude.filter(item => item !== category) : [...exclude, category] })} />{t(CATEGORY[category])}</label>)}</div></div>
          <details className="bkw-details"><summary>{t("字面条件")}<small>{literal || t("不限")}</small></summary>
            <div className="bkw-grid2">
              <Field label={t("发件人或域名包含")}><input maxLength={1000} value={value.match.from} onChange={event => match({ from: event.target.value })} placeholder={t("例如：@example.com")} /></Field>
              <Field label={t("主题包含")}><input maxLength={1000} value={value.match.subject} onChange={event => match({ subject: event.target.value })} placeholder={t("例如：询价")} /></Field>
              <Field label={t("条件关系")}><select value={value.match.mode} onChange={event => match({ mode: event.target.value as "all" | "any" })}><option value="all">{t("全部条件满足")}</option><option value="any">{t("任一条件满足")}</option></select></Field>
              <label className="bkw-checkbox"><input type="checkbox" checked={value.match.hasAttachments} onChange={event => match({ hasAttachments: event.target.checked })} />{t("要求包含附件")}</label>
            </div>
          </details>
        </div>
      </div>
      {!!rule.id && (value.matchMode ?? "ai") === "ai" && <div className="bkw-sec"><div><b>{t("AI 学到的例子")}</b><span>{t("来自你的确认和纠正，最近 8 条提供给 AI")}</span></div>
        <div className="bkw-stack">
          {examples.length ? <div className="bkw-examples">{examples.slice().reverse().map(example => <div key={example.id} className="bkw-example-row">
            <Tag tone={example.match ? "good" : "warn"}>{example.match ? t("属于") : t("不属于")}</Tag>
            <span title={example.text}>{example.text}</span>
            <small className="bkw-muted">{when(example.at)}</small>
            <button type="button" className="bkw-icon-btn small" aria-label={t("删除这个例子")} title={t("删除这个例子")} disabled={!!busy} onClick={() => void perform("deleteExample", async () => { await api("deleteExample", { ruleId: rule.id, exampleId: example.id }); await refresh(); notify(t("例子已删除")); })}><Icon name="trash" size={13} /></button>
          </div>)}</div> : <p className="bkw-muted">{t("还没有例子。在事项上确认 AI 的建议、手动选择这个方案，或点“不是这个方案”时会自动记录。")}</p>}
        </div>
      </div>}
      {!dispatch && <div className="bkw-sec"><div><b>{t("自主级别")}</b><span>{t("AI 做完以后，哪些动作可以不经你确认")}</span></div>
        <div className="bkw-stack">
          <div className="bkw-levels" role="radiogroup" aria-label={t("自主级别")}>
            {(["draft", "low_risk", "auto"] as Autonomy[]).map(level => <button type="button" role="radio" aria-checked={autonomy === level} key={level} className={`bkw-level ${autonomy === level ? "on" : ""}`} disabled={value.output !== "reply" && level !== "draft"} onClick={() => patch({ autonomy: level })}>
              <strong>{t(AUTONOMY_LABEL[level])}</strong><small>{t(AUTONOMY_HINT[level])}</small>
            </button>)}
          </div>
          {value.output !== "reply" ? <small className="bkw-muted">{t("分析报告不对外发送，始终为仅起草。")}</small> : autonomy !== "draft" && <Alert tone="warn">{t("自动发送前会等待 {0} 分钟，期间可在“AI 已代办”中撤回。存在待核实事项、包含链接或其他邮箱地址、收件人被策略禁止，或你曾撤回发给该联系人的回复时，一律转为人工审核。", data.defaults.undoMinutes)}</Alert>}
        </div>
      </div>}
      <div className="bkw-sec"><div><b>{t("处理要求")}</b><span>{t("业务资料、步骤与约束")}</span></div>
        <div className="bkw-stack">
          <div className="bkw-grid2">
            <Field label={t("方案名称")}><input required maxLength={100} value={value.name} onChange={event => patch({ name: event.target.value })} placeholder={t("例如：客户询价回复")} /></Field>
            <Field label={t("生成内容")}><select value={value.output} onChange={event => { const output = event.target.value as Rule["output"]; patch({ output, ...(output !== "reply" ? { autonomy: "draft" as Autonomy } : {}), ...(output === "dispatch" ? { sources: ["email"], tools: [], skills: [], dispatchFolder: value.dispatchFolder || (value.name.trim() ? `分派/${value.name.trim()}` : "") } : {}) }); }}><option value="reply">{t("处理摘要 + 回复草稿")}</option><option value="report">{t("分析报告")}</option>{rule.output === "dispatch" && <option value="dispatch">{t("分派到文件夹（交给其他人处理）")}</option>}</select></Field>
          </div>
          {dispatch ? <>
            <Field label={t("目标文件夹")} hint={t("匹配的邮件会移到这个文件夹，不存在时自动创建。负责的人或小组在自己的工作台上，用这个文件夹建处理方案；也可以直接在邮箱里查看。")}>
              <input required maxLength={200} list="bkw-dispatch-folders" value={value.dispatchFolder || ""} onChange={event => patch({ dispatchFolder: event.target.value })} placeholder={t("例如：分派/华东销售")} />
              <datalist id="bkw-dispatch-folders">{dispatchFolders.map(path => <option key={path} value={path} />)}</datalist>
            </Field>
            <Alert tone="warn">{t("新建的方案不再提供“分派”：要把邮件按业务分给不同的人，请用“业务分类”，为分类选择“移到文件夹”。这个方案仍会照常运行。")}</Alert>
            <Alert>{t("分派只移动邮件，不生成或发送回复。同一个公共邮箱的收件箱只应由一台工作台负责分派，其他人的工作台只读取自己的文件夹，否则同一封信会被处理两次。")}</Alert>
          </> : <div className="bkw-field">
            <span className="bkw-field-row"><span>{t("处理要求")}</span><button type="button" className="bkw-btn small" disabled={!aiReady || value.instructions.trim().length < 5} onClick={() => void optimize()}><Icon name="sparkle" size={13} />{optimizing ? t("正在优化…") : t("AI 优化")}</button></span>
            <div className="bkw-var-wrap">
            <AutoTextarea aria-label={t("处理要求")} required minLength={5} maxLength={16000} className="bkw-instructions" value={value.instructions} onKeyDown={variables.onKeyDown} onBlur={variables.close} onChange={event => { variables.onChange(event); patch({ instructions: event.target.value }); }} placeholder={t("说明收到信息后需要做什么，以及缺少信息时如何处理。可写明语言、语气与署名。")} />{variables.menu}</div>
            <small className="bkw-muted">{t("输入 / 插入变量，例如姓名、部门、今天的日期。")}</small>
            {!!unknown.length && <Alert tone="danger">{t("不认识的变量：{0}。输入 / 可查看可用的变量。", unknown.map(name => `{{${name}}}`).join("、"))}</Alert>}
            {/\{\{/.test(value.instructions) && <details className="bkw-details" open={showPreview} onToggle={event => setShowPreview((event.target as HTMLDetailsElement).open)}><summary>{t("发给 AI 前的样子")}<small>{t("按你的资料和现在的时间填入")}</small></summary>
              <div className="bkw-prose bkw-var-preview">{previewVariables(value.instructions, profile, data.accounts.find(account => account.id === value.account)?.label ?? value.account, language() === "en")}</div>
            </details>}
            {optimizeError && <Alert tone="danger">{systemMessage(optimizeError)}</Alert>}
            {optimization && <div className="bkw-suggestion"><strong>{t("优化后的处理要求")}</strong><div className="bkw-prose">{optimization}</div><div className="bkw-actions"><small className="bkw-muted">{t("核对原有条件与限制，采用后仍需保存方案。")}</small><button type="button" className="bkw-btn small" onClick={() => setOptimization(undefined)}>{t("保留原文")}</button><button type="button" className="bkw-btn small primary" onClick={() => patch({ instructions: optimization })}>{t("采用优化")}</button></div></div>}</div>}
          <details className="bkw-details"><summary>{t("执行选项")}<small>{t("优先级 {0} · 失败重试 {1} 次", value.priority, value.maxRetries)}</small></summary>
            <div className="bkw-grid2">
              <Field label={t("优先级")} hint={t("数值越高越先匹配")}><input required type="number" min={-10000} max={10000} value={value.priority} onChange={event => patch({ priority: Number(event.target.value) })} /></Field>
              <Field label={t("失败重试次数")}><input type="number" min={0} max={3} value={value.maxRetries} onChange={event => patch({ maxRetries: Number(event.target.value) })} /></Field>
            </div>
          </details>
        </div>
      </div>
      {!dispatch && <div className="bkw-sec"><div><b>{t("技能与工具")}</b><span>{t("AI 处理时可以使用的技能和读取工具")}</span></div>
        <div className="bkw-stack">
          <details className="bkw-details bkw-capability-section"><summary><Icon name="rules" size={14} />{t("选择技能与工具")}<small>{(value.skills?.length || value.tools.length) ? t("已选 {0} 个技能、{1} 个工具：{2}", value.skills?.length ?? 0, value.tools.length, [...(value.skills || []), ...value.tools].join("、")) : t("未选择：只根据收到的信息和处理要求处理")}</small></summary>
            <CapabilityPicker capabilities={data.capabilities} value={value} onChange={patch} />
          </details>
        </div>
      </div>}
      <div className="bkw-sec"><div><b>{t("先试运行")}</b><span>{t("用最近收到的或某段时间的邮件检验，保存前看效果")}</span></div>
        <div className="bkw-stack">
          <div className="bkw-trial-scope">
            <div className="bkw-seg" role="radiogroup" aria-label={t("试运行范围")}>
              <button type="button" role="radio" aria-checked={!trialRange} className={!trialRange ? "on" : ""} onClick={() => { setTrialRange(false); setTrial(undefined); }}>{t("最近收到的 30 条")}</button>
              <button type="button" role="radio" aria-checked={trialRange} className={trialRange ? "on" : ""} disabled={(value.sources ?? ["email"]).every(kind => kind !== "email")} onClick={() => { setTrialRange(true); setTrial(undefined); }}>{t("指定时间段")}</button>
            </div>
            {trialRange && <span className="bkw-trial-range">
              <label>{t("从")}<input type="datetime-local" value={trialSince} max={localInput(new Date())} onChange={event => { setTrialSince(event.target.value); setTrial(undefined); }} /></label>
              <label>{t("到")}<input type="datetime-local" value={trialUntil} onChange={event => { setTrialUntil(event.target.value); setTrial(undefined); }} /></label>
            </span>}
          </div>
          {trialRange && <small className="bkw-muted">{t("直接读取邮箱「{0}」中这段时间的邮件（最多 30 封，包括工作台开始处理之前的历史邮件），只判断，不建事项、不移动、不发送。", value.folder)}</small>}
          <div className="bkw-actions"><button type="button" className="bkw-btn" disabled={!value.name.trim() || (!dispatch && value.instructions.trim().length < 5) || (trialRange && !trialSince)} onClick={() => void runTrial()}><Icon name="play" size={13} />{trialing ? t("正在试运行…") : t("试运行")}</button><small className="bkw-muted">{t("只预览匹配结果，不处理、不发送。")}</small></div>
          {trialError && <Alert tone="danger">{systemMessage(trialError)}</Alert>}
          {trial && <div className="bkw-trial">
            <strong>{t("命中 {0} 条 · 跳过 {1} 条", trial.items.filter(item => item.matched).length, trial.items.filter(item => !item.matched).length)}<small className="bkw-muted">{trial.by === "ai" ? t("含 AI 语义判断") : t("仅按条件判断")}</small></strong>
            {trial.items.length ? trial.items.slice(0, 12).map(item => <div key={item.id} className="bkw-trial-row"><Tag tone={item.matched ? "good" : "muted"}>{item.matched ? t("命中") : t("跳过")}</Tag><span>{item.subject}</span><small className="bkw-muted">{systemMessage(item.reason)}</small></div>) : <p className="bkw-muted">{t("还没有可用于试运行的信息。")}</p>}
          </div>}
        </div>
      </div>
    </fieldset>
    <div className="bkw-plan-foot">
      {rule.id && <button type="button" className="bkw-btn ghost danger-text" disabled={working} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void perform("deleteRule", async () => { leave.current = undefined; await api("deleteRule", { id: rule.id, revision: base }); await refresh(); go({ view: "plans" }); notify(t("方案已删除")); }); }}>{confirmDelete ? t("再次点击确认删除") : t("删除方案")}</button>}
      <span className="bkw-grow" />
      {dirty && <small className="bkw-muted">{t("有未保存的修改")}</small>}
      <button type="submit" className="bkw-btn primary" disabled={working}>{busy === "saveRule" ? t("保存中…") : t("保存方案")}</button>
    </div>
  </form>;
}

type MailFolder = { path: string; name: string };
export function FolderPicker({ account, value, defaultFolder = "INBOX", onChange, ready = true }: { account: string; value: string; defaultFolder?: string; onChange: (folder: string) => void; ready?: boolean }) {
  const [folders, setFolders] = useState<MailFolder[]>([]), [loading, setLoading] = useState(false), [failure, setFailure] = useState(""), [common, setCommon] = useState(false), [reload, setReload] = useState(0);
  useEffect(() => {
    let active = true;
    setFolders([]); setFailure(""); setCommon(false);
    if (!ready) { setLoading(false); return; }
    setLoading(true);
    api<{ folders: MailFolder[]; common: boolean }>("folders", { account }).then(result => { if (active) { setFolders(result.folders); setCommon(result.common); } }).catch(error => { if (active) setFailure(errorMessage(error)); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [account, ready, reload]);
  const options = [...folders];
  if (!options.some(folder => folder.path === value) && value) options.unshift({ path: value, name: value === defaultFolder ? t("默认收件箱") : t("当前已保存的文件夹") });
  if (!folders.length && !options.some(folder => folder.path === defaultFolder)) options.push({ path: defaultFolder, name: t("默认收件箱") });
  return <div className="bkw-folder">
    <div className="bkw-inline-form">
      <select aria-label={t("邮件文件夹")} required value={value} disabled={!ready || loading} onChange={event => onChange(event.target.value)}>
        {options.map(folder => <option key={folder.path} value={folder.path}>{folder.path.toUpperCase() === "INBOX" ? t("收件箱") : folder.name}{folder.name !== folder.path && folder.path.toUpperCase() !== "INBOX" ? ` · ${folder.path}` : ""}</option>)}
      </select>
      <button type="button" className="bkw-icon-btn" aria-label={t("重新读取邮件文件夹")} disabled={!ready || loading} onClick={() => setReload(reload + 1)}><Icon name="refresh" size={15} /></button>
    </div>
    <small aria-live="polite">{loading ? t("正在读取邮箱文件夹…") : (failure && systemMessage(failure)) || (common ? t("显示所有邮箱共有的文件夹。") : "")}</small>
  </div>;
}

function CapabilityPicker({ capabilities, value, onChange }: { capabilities?: Capabilities; value: Rule; onChange: (partial: Partial<Rule>) => void }) {
  const toggle = (items: string[], key: string) => items.includes(key) ? items.filter(item => item !== key) : [...items, key];
  return <div className="bkw-capabilities">
    <div><h4>{t("可用技能")}</h4><p className="bkw-muted">{t("选择本次任务使用的技能，技能只能调用下方已允许的工具。")}</p>
      {capabilities?.skills.length ? <div className="bkw-capability-list">{capabilities.skills.map(skill => <label key={skill.id} className="bkw-capability"><input type="checkbox" checked={(value.skills || []).includes(skill.id)} onChange={() => onChange({ skills: toggle(value.skills || [], skill.id) })} /><span><strong>{skill.name}</strong><small>{skill.description}</small></span></label>)}</div> : <p className="bkw-card-empty">{t("当前没有可供后台调用的技能，可直接使用处理要求。")}</p>}
    </div>
    <div><h4>{t("允许调用的工具")}</h4><p className="bkw-muted">{t("只开放当前任务需要的读取与查询能力；留空时仅分析已有资料。")}</p>
      {capabilities?.tools.length ? <div className="bkw-capability-list">{capabilities.tools.map(tool => <label key={tool.name} className="bkw-capability"><input type="checkbox" checked={value.tools.includes(tool.name)} onChange={() => onChange({ tools: toggle(value.tools, tool.name) })} /><span><strong>{tool.name}</strong><small>{tool.description}</small></span></label>)}</div> : <p className="bkw-card-empty">{t("当前没有可用的读取工具。请检查 DSH 工具配置。")}</p>}
    </div>
  </div>;
}
