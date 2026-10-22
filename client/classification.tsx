import * as React from "react";
import { useState } from "react";
import { systemMessage, t } from "./i18n";
import { useWorkbench } from "./context";
import { CONFIDENCE, api, classifierOf, type Classifier, type Task } from "./lib";
import { Icon, Tag } from "./ui";
import { categoryAction } from "./classifiers";

/** What choosing a category does, in words, for the notice after a click. */
const done = (classifier: Classifier, id: string) => {
  const category = classifier.categories.find(item => item.id === id)!;
  return category.action === "move" ? t("已归为「{0}」，已移到「{1}」；已记为例子", category.name, category.folder || "") : t("已归为「{0}」；已记为例子", category.name);
};

/**
 * Business category of an email item: waiting for you (the AI's first pick first), or applied with a way to change it.
 * Choosing applies the category's action at once and is remembered as an example.
 */
export function ClassificationBlock({ task }: { task: Task }) {
  const { data, busy, perform, refresh, notify } = useWorkbench();
  const [other, setOther] = useState("");
  const classifier = classifierOf(task, data.classifiers);
  if (!classifier) return null;
  const classification = task.classification;
  const locked = ["queued", "running", "sending", "uncertain"].includes(task.status);
  const choose = (categoryId: string) => perform("classify", async () => { await api("classify", { id: task.id, revision: task.revision, categoryId }); await refresh(); notify(done(classifier, categoryId)); setOther(""); });
  if (classification?.state === "pending") {
    const known = new Set(classifier.categories.map(item => item.id));
    const candidates = (classification.candidates ?? []).filter(id => known.has(id));
    // The AI's candidates as buttons (its first pick first); with none, the first categories. The rest in a list.
    const buttons = candidates.length ? candidates : classifier.categories.slice(0, 6).map(item => item.id);
    const rest = classifier.categories.filter(item => !buttons.includes(item.id));
    return <section className="bkw-block bkw-suggest" aria-label={t("待人工分类")}>
      <h3><Icon name="sparkle" size={15} />{t("请选择业务分类")}{classification.confidence && classification.by === "ai" && <Tag tone={classification.confidence === "low" ? "muted" : "warn"}>{t(CONFIDENCE[classification.confidence])}</Tag>}<small className="bkw-muted">{classifier.name}</small></h3>
      {classification.reason ? <p className="bkw-block-lead">{t("AI：{0}", systemMessage(classification.reason))}</p> : <p className="bkw-block-lead">{t("AI 拿不准这封邮件属于哪一类。")}</p>}
      <p className="bkw-muted">{t("选择后立即执行这个分类的动作，并记为例子，AI 之后判断相似邮件时参考。在你选择之前，不会自动交给处理方案。")}</p>
      <div className="bkw-actions bkw-cat-choices">
        {buttons.map((id, index) => { const category = classifier.categories.find(item => item.id === id)!; const first = index === 0 && candidates.length > 0; return <button type="button" key={id} className={`bkw-btn ${first ? "primary" : ""}`} disabled={!!busy || locked} title={categoryAction(category)} onClick={() => choose(id)}>{first ? t("{0}（AI 首选）", category.name) : category.name}</button>; })}
        {rest.length > 0 && <span className="bkw-inline-form">
          <select aria-label={t("其他分类")} value={other} onChange={event => setOther(event.target.value)}><option value="">{t("其他分类…")}</option>{rest.map(category => <option key={category.id} value={category.id}>{category.name}</option>)}</select>
          <button type="button" className="bkw-btn" disabled={!other || !!busy || locked} onClick={() => choose(other)}>{t("归类")}</button>
        </span>}
      </div>
    </section>;
  }
  // Applied, or none yet in a classified folder: show it compactly with a way to change.
  const current = classification?.state === "applied" ? classifier.categories.find(item => item.id === classification.categoryId) : undefined;
  return <section className="bkw-block bkw-class-line" aria-label={t("业务分类")}>
    <span className="bkw-muted">{t("业务分类")}</span>
    {classification?.state === "applied" ? <Tag tone="accent">{classification.categoryName || current?.name || ""}</Tag> : <Tag>{t("未分类")}</Tag>}
    {classification?.state === "applied" && <small className="bkw-muted">{classification.by === "manual" ? t("你选择的") : t("AI 判断")}{classification.reason ? " · " + systemMessage(classification.reason) : ""}</small>}
    <span className="bkw-grow" />
    <span className="bkw-inline-form">
      <select aria-label={t("更改业务分类")} value={other} disabled={!!busy || locked} onChange={event => setOther(event.target.value)}><option value="">{classification?.state === "applied" ? t("改为…") : t("归为…")}</option>{classifier.categories.filter(item => item.id !== current?.id).map(category => <option key={category.id} value={category.id}>{category.name} · {categoryAction(category)}</option>)}</select>
      <button type="button" className="bkw-btn small" disabled={!other || !!busy || locked} onClick={() => choose(other)}>{t("确定")}</button>
    </span>
  </section>;
}

/** Classify several waiting items at once, all into the same category of their (shared) scheme. */
export function BatchClassify({ tasks, onDone }: { tasks: Task[]; onDone: () => void }) {
  const { data, busy, perform, refresh, notify } = useWorkbench();
  const [category, setCategory] = useState("");
  const classifier = tasks[0] && classifierOf(tasks[0], data.classifiers);
  if (!classifier) return null;
  const same = tasks.filter(task => classifierOf(task, data.classifiers)?.id === classifier.id);
  const apply = () => perform("classifyMany", async () => {
    let count = 0;
    for (const task of same) { await api("classify", { id: task.id, revision: task.revision, categoryId: category }); count++; }
    await refresh(); notify(t("已把 {0} 封归为「{1}」", count, classifier.categories.find(item => item.id === category)?.name || "")); setCategory(""); onDone();
  });
  return <div className="bkw-batch" role="group" aria-label={t("批量归类")}>
    <span>{t("已选 {0} 封", same.length)}</span>
    <select aria-label={t("归为")} value={category} onChange={event => setCategory(event.target.value)}><option value="">{t("归为…")}</option>{classifier.categories.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>
    <button type="button" className="bkw-btn small primary" disabled={!category || !same.length || !!busy} onClick={apply}>{t("应用")}</button>
    {same.length < tasks.length && <small className="bkw-muted">{t("只处理同一分类方案的 {0} 封", same.length)}</small>}
  </div>;
}
