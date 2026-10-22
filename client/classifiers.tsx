import * as React from "react";
import { useEffect, useRef, useState } from "react";
import { systemMessage, t } from "./i18n";
import { useWorkbench } from "./context";
import { api, errorMessage, when, type Classifier, type ClassifierCategory, type Confidence } from "./lib";
import { Alert, AutoTextarea, Field, Icon, Switch, Tag } from "./ui";
import { FolderPicker, localInput } from "./plans";

const newId = () => "c" + Math.random().toString(36).slice(2, 12) + Date.now().toString(36);
const FALLBACK_TEXT = "不属于以上任何一类。";
export const blankClassifier = (accounts: { id: string; inboxFolder?: string }[]): Classifier => ({
  id: "", name: "", enabled: true, account: accounts[0]?.id ?? "", folder: accounts[0]?.inboxFolder || "INBOX", guidance: "",
  categories: [{ id: newId(), name: "", include: "", action: "label" }, { id: newId(), name: t("其他"), include: t(FALLBACK_TEXT), action: "label", fallback: true }],
});
/** Short reading of what a category does, for the list and the trial run. */
export const categoryAction = (category: ClassifierCategory) => category.action === "move" ? t("移到 {0}", category.folder || "…") : t("只打标签");

type TrialItem = { id: string; subject: string; from: string; receivedAt: string; categoryId: string; likely: string; confidence: Confidence; reason: string };
const CONFIDENCE_LABEL: Record<Confidence, string> = { high: "把握高", medium: "把握一般", low: "把握低" };

/** Classification scheme editor: scope, guidance, ordered categories with definitions and actions, trial run. */
export function ClassifierEditor({ classifier }: { classifier: Classifier }) {
  const { data, busy, perform, refresh, notify, go, leave } = useWorkbench();
  const [value, setValue] = useState<Classifier>(() => structuredClone(classifier));
  const [saved, setSaved] = useState(JSON.stringify(classifier));
  const [open, setOpen] = useState(classifier.categories[0]?.id ?? "");
  const [base, setBase] = useState(data.revision);
  const [validation, setValidation] = useState(""), [confirmDelete, setConfirmDelete] = useState(false);
  const [folders, setFolders] = useState<string[]>([]);
  const [trial, setTrial] = useState<{ total: number; items: TrialItem[]; note?: string }>(), [trialing, setTrialing] = useState(false), [trialError, setTrialError] = useState("");
  const [trialRange, setTrialRange] = useState(false), [trialSince, setTrialSince] = useState(""), [trialUntil, setTrialUntil] = useState("");
  const [dragging, setDragging] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);
  const dirty = JSON.stringify(value) !== saved;
  const working = !!busy || trialing;
  useEffect(() => { leave.current = () => !dirty || window.confirm(t("分类方案有尚未保存的修改，确认放弃？")); return () => { leave.current = undefined; }; }, [dirty]);
  // Existing folders as suggestions for move targets; a new name is created on the first move.
  useEffect(() => {
    if (!data.accounts.length) return;
    let active = true;
    api<{ folders: { path: string }[] }>("folders", { account: value.account }).then(result => { if (active) setFolders(result.folders.map(folder => folder.path).filter(path => path !== value.folder)); }).catch(() => {});
    return () => { active = false; };
  }, [value.account, value.folder]);
  const patch = (partial: Partial<Classifier>) => { setValue(current => ({ ...current, ...partial })); setValidation(""); setTrial(undefined); };
  const categories = value.categories, business = categories.filter(category => !category.fallback), fallback = categories.find(category => category.fallback);
  const setCategories = (next: ClassifierCategory[]) => patch({ categories: [...next.filter(category => !category.fallback), ...next.filter(category => category.fallback)] });
  const editCategory = (id: string, partial: Partial<ClassifierCategory>) => setCategories(categories.map(category => category.id === id ? { ...category, ...partial } : category));
  const addCategory = () => { const category: ClassifierCategory = { id: newId(), name: "", include: "", action: "label" }; setCategories([...business, category, ...(fallback ? [fallback] : [])]); setOpen(category.id); };
  const removeCategory = (id: string) => { setCategories(categories.filter(category => category.id !== id)); if (open === id) setOpen(business.find(category => category.id !== id)?.id ?? ""); };
  const moveCategory = (id: string, to: number) => {
    const list = business.slice(), from = list.findIndex(category => category.id === id);
    if (from < 0 || to < 0 || to >= list.length || from === to) return;
    const [item] = list.splice(from, 1); list.splice(to, 0, item);
    setCategories([...list, ...(fallback ? [fallback] : [])]);
  };
  const week = Date.now() - 7 * 864e5;
  const mine = classifier.id ? data.tasks.filter(task => task.classification?.classifierId === classifier.id) : [];
  const weekCount = mine.filter(task => Date.parse(task.receivedAt) >= week).length, pending = mine.filter(task => task.classification?.state === "pending").length;
  const current = categories.find(category => category.id === open);
  const examples = current && classifier.categories.some(category => category.id === current.id) ? data.categoryExamples?.[current.id] ?? [] : [];
  const runTrial = async () => {
    setTrialing(true); setTrialError(""); setTrial(undefined);
    const range = trialRange && trialSince ? { since: new Date(trialSince).toISOString(), ...(trialUntil ? { until: new Date(trialUntil).toISOString() } : {}) } : undefined;
    try { setTrial(await api("trialClassifier", { classifier: value, ...(range ? { range } : {}) })); } catch (error) { setTrialError(errorMessage(error)); } finally { setTrialing(false); }
  };
  const save = () => {
    const form = formRef.current!;
    const invalid = form.querySelector<HTMLInputElement | HTMLTextAreaElement>("input:invalid, textarea:invalid, select:invalid");
    const unnamed = business.find(category => !category.name.trim() || !category.include.trim());
    if (unnamed) { setOpen(unnamed.id); setValidation(t("每个分类都要填写名称和“属于本类”。")); return; }
    if (invalid) { setValidation(t("请检查标出的必填项、文本长度或数值范围。")); invalid.focus(); return; }
    void perform("saveClassifier", async () => {
      const result = await api<Classifier>("saveClassifier", { classifier: value, revision: base });
      setValue(result); setSaved(JSON.stringify(result)); setBase(base + 1); leave.current = undefined;
      await refresh(); go({ view: "plans", rule: "c:" + result.id }); notify(t("分类方案已保存"));
    });
  };
  const nameOf = (id: string) => categories.find(category => category.id === id)?.name || t("未命名分类");
  const distribution = trial ? [...categories.map(category => ({ key: category.id, label: category.name || t("未命名分类"), count: trial.items.filter(item => item.categoryId === category.id).length, pending: false })), { key: "pending", label: t("待人工"), count: trial.items.filter(item => !item.categoryId).length, pending: true }] : [];
  return <form ref={formRef} className="bkw-plan-form" noValidate onSubmit={event => { event.preventDefault(); save(); }}>
    <header className="bkw-plan-head">
      <div><h2>{classifier.id ? value.name || t("未命名分类方案") : t("新建分类方案")}</h2>
        <p className="bkw-muted">{classifier.id ? t("本周 {0} 封 · 待人工 {1} 封 · 修改只影响之后收到的邮件。", weekCount, pending) : t("为一个邮箱文件夹定义业务分类：每封新邮件归入其中一类，AI 拿不准时交给你。")}</p></div>
      <label className="bkw-switch-label"><Switch label={t("启用分类方案")} checked={value.enabled} onChange={enabled => patch({ enabled })} />{value.enabled ? t("已启用") : t("已停用")}</label>
    </header>
    {validation && <Alert tone="danger">{validation}</Alert>}
    {!data.defaults.triage && <Alert tone="warn">{t("业务分类在 AI 分拣时进行。AI 分拣已关闭，开启后分类才会生效。")}</Alert>}
    {data.defaults.triage && !data.health.triage && <Alert tone="warn">{t("DSH 默认模型未就绪：没有 AI 判断时，新邮件都会进入“待人工分类”。")}</Alert>}
    <fieldset disabled={working} className="bkw-plan-fields">
      <div className="bkw-sec"><div><b>{t("适用范围")}</b><span>{t("一个文件夹只用一套启用的分类方案")}</span></div>
        <div className="bkw-stack">
          <Field label={t("分类方案名称")}><input required maxLength={100} value={value.name} onChange={event => patch({ name: event.target.value })} placeholder={t("例如：客服邮件分类")} /></Field>
          <div className="bkw-grid2">
            <Field label={t("邮箱")}><select value={value.account} onChange={event => patch({ account: event.target.value, folder: data.accounts.find(account => account.id === event.target.value)?.inboxFolder || "INBOX" })}>{data.accounts.map(account => <option key={account.id} value={account.id}>{account.label}</option>)}<option value="">{t("所有邮箱")}</option></select></Field>
            <Field label={t("文件夹")}><FolderPicker account={value.account} value={value.folder} ready={!!data.accounts.length} defaultFolder={data.accounts.find(account => account.id === value.account)?.inboxFolder || "INBOX"} onChange={folder => patch({ folder })} /></Field>
          </div>
          <label className="bkw-checkbox"><input type="checkbox" checked={value.includeNotices === true} onChange={event => patch({ includeNotices: event.target.checked || undefined })} />{t("系统通知和营销邮件也分类（默认照常归档，不分类）")}</label>
        </div>
      </div>
      <div className="bkw-sec"><div><b>{t("总说明")}</b><span>{t("分类之间怎么取舍，AI 优先按这段判断")}</span></div>
        <AutoTextarea aria-label={t("总说明")} maxLength={4000} value={value.guidance || ""} onChange={event => patch({ guidance: event.target.value })} placeholder={t("例如：同时有投诉和其他诉求时归投诉；催促之前的查询仍算查询；内部同事转发的，按原邮件内容判断。")} />
      </div>
      <div className="bkw-sec"><div><b>{t("分类")}</b><span>{t("从上到下优先；点一行编辑，拖动或用箭头调整顺序")}</span></div>
        <div className="bkw-stack">
          <div className="bkw-cat-list" role="list">
            {categories.map((category, index) => {
              const movable = !category.fallback;
              return <div role="listitem" key={category.id} className={`bkw-cat-row ${open === category.id ? "on" : ""} ${dragging === category.id ? "dragging" : ""}`} draggable={movable}
                onDragStart={() => setDragging(category.id)} onDragEnd={() => setDragging(undefined)} onDragOver={event => { if (dragging && movable) event.preventDefault(); }}
                onDrop={event => { event.preventDefault(); if (dragging && movable) moveCategory(dragging, index); setDragging(undefined); }}>
                <button type="button" className="bkw-cat-main" aria-expanded={open === category.id} onClick={() => setOpen(open === category.id ? "" : category.id)}>
                  <span className="bkw-cat-index">{index + 1}</span>
                  <Tag tone={category.fallback ? "muted" : "accent"}>{category.name || t("未命名分类")}</Tag>
                  <span className="bkw-cat-text">{category.include || t("还没有填写“属于本类”")}</span>
                  <small className="bkw-muted">{categoryAction(category)}</small>
                </button>
                {movable && <span className="bkw-cat-order">
                  <button type="button" className="bkw-icon-btn small" aria-label={t("上移")} title={t("上移")} disabled={index === 0} onClick={() => moveCategory(category.id, index - 1)}><Icon name="up" size={13} /></button>
                  <button type="button" className="bkw-icon-btn small" aria-label={t("下移")} title={t("下移")} disabled={index >= business.length - 1} onClick={() => moveCategory(category.id, index + 1)}><Icon name="down" size={13} /></button>
                </span>}
              </div>;
            })}
          </div>
          {current && <div className="bkw-cat-edit">
            <div className="bkw-grid2">
              <Field label={t("分类名称")}><input required maxLength={40} value={current.name} onChange={event => editCategory(current.id, { name: event.target.value })} placeholder={current.fallback ? t("其他") : t("例如：投诉")} /></Field>
              <div className="bkw-field"><span>{t("动作")}</span><div className="bkw-seg" role="radiogroup" aria-label={t("动作")}>
                <button type="button" role="radio" aria-checked={current.action === "label"} className={current.action === "label" ? "on" : ""} onClick={() => editCategory(current.id, { action: "label", folder: undefined })}>{t("只打标签")}</button>
                <button type="button" role="radio" aria-checked={current.action === "move"} className={current.action === "move" ? "on" : ""} onClick={() => editCategory(current.id, { action: "move", folder: current.folder || "" })}>{t("移到文件夹")}</button>
              </div></div>
            </div>
            {current.action === "move" && <TargetFolder key={current.id} value={current.folder || ""} folders={folders} onChange={folder => editCategory(current.id, { folder })} />}
            {current.fallback ? <p className="bkw-muted">{t("AI 明确判断不属于其他任何一类时归到这里；拿不准的邮件不会放进来，而是交给你。")}</p> : <div className="bkw-grid2">
              <Field label={t("属于本类")} hint={t("定义和典型说法")}><textarea required rows={4} maxLength={2000} value={current.include} onChange={event => editCategory(current.id, { include: event.target.value })} placeholder={t("例如：表达不满、要求赔偿或道歉、威胁差评或投诉到平台。")} /></Field>
              <Field label={t("不属于本类")} hint={t("边界：容易混淆、但应该归到别处的情况")}><textarea rows={4} maxLength={2000} value={current.exclude || ""} onChange={event => editCategory(current.id, { exclude: event.target.value || undefined })} placeholder={t("例如：只是询问价格或进度、语气平和的，算查询或咨询。")} /></Field>
            </div>}
            {!!examples.length && <div className="bkw-examples">{examples.slice().reverse().map(example => <div key={example.id} className="bkw-example-row">
              <Tag tone={example.match ? "good" : "warn"}>{example.match ? t("属于") : t("不属于")}</Tag>
              <span title={example.text}>{example.text}</span>
              <small className="bkw-muted">{when(example.at)}</small>
              <button type="button" className="bkw-icon-btn small" aria-label={t("删除这个例子")} title={t("删除这个例子")} disabled={!!busy} onClick={() => void perform("deleteCategoryExample", async () => { await api("deleteCategoryExample", { categoryId: current.id, exampleId: example.id }); await refresh(); notify(t("例子已删除")); })}><Icon name="trash" size={13} /></button>
            </div>)}</div>}
            {!current.fallback && <div className="bkw-actions"><small className="bkw-muted">{examples.length ? t("AI 学到的例子 {0} 条，最近 6 条提供给 AI。", examples.length) : t("你在事项上选择或更改分类时，会自动记为例子。")}</small><span className="bkw-grow" />
              <button type="button" className="bkw-btn small ghost danger-text" disabled={business.length <= 1} onClick={() => removeCategory(current.id)}><Icon name="trash" size={13} />{t("删除分类")}</button></div>}
          </div>}
          <div className="bkw-actions"><button type="button" className="bkw-btn" disabled={business.length >= 29} onClick={addCategory}><Icon name="plus" size={14} />{t("添加分类")}</button></div>
        </div>
      </div>
      <div className="bkw-sec"><div><b>{t("先试运行")}</b><span>{t("看每封邮件会归到哪一类，保存前调准定义")}</span></div>
        <div className="bkw-stack">
          <div className="bkw-trial-scope">
            <div className="bkw-seg" role="radiogroup" aria-label={t("试运行范围")}>
              <button type="button" role="radio" aria-checked={!trialRange} className={!trialRange ? "on" : ""} onClick={() => { setTrialRange(false); setTrial(undefined); }}>{t("最近收到的 30 条")}</button>
              <button type="button" role="radio" aria-checked={trialRange} className={trialRange ? "on" : ""} onClick={() => { setTrialRange(true); setTrial(undefined); }}>{t("指定时间段")}</button>
            </div>
            {trialRange && <span className="bkw-trial-range">
              <label>{t("从")}<input type="datetime-local" aria-label={t("开始时间")} value={trialSince} max={localInput(new Date())} onChange={event => { setTrialSince(event.target.value); setTrial(undefined); }} /></label>
              <label>{t("到")}<input type="datetime-local" aria-label={t("结束时间")} value={trialUntil} onChange={event => { setTrialUntil(event.target.value); setTrial(undefined); }} /></label>
            </span>}
          </div>
          <small className="bkw-muted">{trialRange ? t("直接读取邮箱「{0}」中这段时间的邮件（最多 30 封），只判断，不建事项、不移动。", value.folder) : t("用这个文件夹最近进入工作台的 30 条信息判断，不改动任何事项。")}</small>
          <div className="bkw-actions"><button type="button" className="bkw-btn" disabled={!business.some(category => category.name.trim() && category.include.trim()) || (trialRange && !trialSince) || !data.health.writer} onClick={() => void runTrial()}><Icon name="play" size={13} />{trialing ? t("正在试运行…") : t("试运行")}</button>
            {!data.health.writer && <small className="bkw-muted">{t("试运行需要 DSH 默认模型。")}</small>}</div>
          {trialError && <Alert tone="danger">{systemMessage(trialError)}</Alert>}
          {trial && <div className="bkw-trial">
            {trial.total ? <>
              <div className="bkw-dist" aria-label={t("分类分布")}>{distribution.filter(row => row.count || !row.pending).map(row => <div key={row.key} className="bkw-dist-row">
                <span>{row.label}</span><div className="bkw-dist-track"><div className={`bkw-dist-bar ${row.pending ? "pending" : ""}`} style={{ width: `${Math.round(row.count / trial.total * 100)}%` }} /></div><small className="bkw-muted">{t("{0} 封", row.count)}</small>
              </div>)}</div>
              {trial.items.map(item => <div key={item.id} className="bkw-trial-row">
                {item.categoryId ? <Tag tone="accent">{nameOf(item.categoryId)}</Tag> : <Tag tone="warn">{t("待人工")}</Tag>}
                <span title={item.subject}>{item.subject}</span>
                <small className="bkw-muted" title={item.reason}>{item.categoryId ? systemMessage(item.reason) : item.likely ? t("{0}：可能是「{1}」", t(CONFIDENCE_LABEL[item.confidence]), nameOf(item.likely)) : systemMessage(item.reason)}</small>
              </div>)}
            </> : <p className="bkw-muted">{systemMessage(trial.note || "")}</p>}
            {!!trial.total && <small className="bkw-muted">{t("只有“把握高”的会自动归类，其余进入“待人工分类”。")}</small>}
          </div>}
        </div>
      </div>
    </fieldset>
    <div className="bkw-plan-foot">
      {classifier.id && <button type="button" className="bkw-btn ghost danger-text" disabled={working} onClick={() => { if (!confirmDelete) { setConfirmDelete(true); return; } void perform("deleteClassifier", async () => { leave.current = undefined; await api("deleteClassifier", { id: classifier.id, revision: base }); await refresh(); go({ view: "plans" }); notify(t("分类方案已删除")); }); }}><Icon name="trash" size={14} />{confirmDelete ? t("确认删除？已有事项的分类会保留") : t("删除分类方案")}</button>}
      <span className="bkw-grow" />
      {dirty && <small className="bkw-muted">{t("有未保存的修改")}</small>}
      <button type="submit" className="bkw-btn primary" disabled={working}>{busy === "saveClassifier" ? t("保存中…") : t("保存分类方案")}</button>
    </div>
  </form>;
}

const NEW_FOLDER = "\u0000new";
/**
 * Where a category moves mail: one of the mailbox's folders, or a new one typed in (created on the first move).
 * A plain list always shows every folder, so a choice can be changed at any time.
 */
function TargetFolder({ value, folders, onChange }: { value: string; folders: string[]; onChange: (folder: string) => void }) {
  const [typing, setTyping] = useState(() => !!value && !folders.includes(value));
  // Folders arrive after the first render: a saved folder that exists is shown in the list, not as typed text.
  useEffect(() => { if (typing && value && folders.includes(value)) setTyping(false); }, [folders.join("\n")]);
  return <div className="bkw-field">
    <span>{t("目标文件夹")}</span>
    {typing ? <span className="bkw-inline-form">
      <input required autoFocus aria-label={t("新文件夹名称")} maxLength={200} value={value} onChange={event => onChange(event.target.value)} />
      {!!folders.length && <button type="button" className="bkw-btn small" onClick={() => { setTyping(false); onChange(folders.includes(value) ? value : ""); }}>{t("选择已有文件夹")}</button>}
    </span> : <select required aria-label={t("目标文件夹")} value={folders.includes(value) ? value : ""} onChange={event => { if (event.target.value === NEW_FOLDER) { setTyping(true); onChange(""); } else onChange(event.target.value); }}>
      <option value="">{t("请选择文件夹")}</option>
      {folders.map(path => <option key={path} value={path}>{path}</option>)}
      <option value={NEW_FOLDER}>{t("新建文件夹…")}</option>
    </select>}
  </div>;
}
