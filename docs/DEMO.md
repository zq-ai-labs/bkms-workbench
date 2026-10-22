# 演示：邮件分类与分类回复 / Demo: email classification and category replies

[中文](#中文版) · [English](#english-version)

---

## 中文版

演示内容：客户来信进入工作台 → AI 按含义分成 **投诉 / 查询 / 咨询** 三类（每类对应一个“处理方案”）→ 每类按各自的要求起草回复 → 人在“待我决策”核对后发送。

### 准备（约 2 分钟）

演示数据全部是合成的（地址都是 `.test` 域名），后台处理保持关闭，不连接真实邮箱。数据要放在独立的新目录，不要放进日常使用的 HOME。

```powershell
pnpm run build
node scripts/seed-demo.mjs --home D:/runtime/poc/bkms-workbench-demo-zh --lang zh
powershell -File scripts/start-workbench.ps1 -DshHome D:/runtime/poc/bkms-workbench-demo-zh -Profile bkms-demo -Port 9188
```

- 目录名必须包含 `runtime/poc/bkms-workbench-demo`，且是新建或空目录；脚本会拒绝其他位置。
- 为了让页面能显示回复草稿，脚本添加了一个占位邮箱 `service@demo.example.test`。`.test` 域名不存在，它连不上任何服务器，也发不出邮件。**演示时不要点“开启”自动处理**，点了也只会出现连接失败的提示。
- 界面语言跟随 DSH 的语言设置；中文版请把 DSH 设为中文。

### 三个分类（处理方案）

| 分类 | AI 判断依据（适用说明） | 回复要求 |
| --- | --- | --- |
| 客户投诉处理 | 客户对产品、服务、交付或账单表达不满，要求赔偿或道歉 | 先致歉、复述问题，给处理编号、负责人和时限；不承诺赔偿金额 |
| 订单与账户查询 | 查询订单状态、物流、发票、账户或合同等已有信息 | 直接给出订单号、状态和预计时间；缺订单号时请对方补充 |
| 售前咨询 | 咨询功能、选型、价格、试用或合作方式 | 按场景推荐方案，逐条回答，提出演示/试用/报价等下一步 |

三个方案都是“AI 确认后才处理”、“仅起草”（不自动发送）。

### 演示数据

| 来信 | 分类结果 | 状态 | 看点 |
| --- | --- | --- | --- |
| 第三次催货了，订单 SO-20261008 还没到！ | 投诉 · 紧急 · 把握高 | 待审核 | 致歉 + 编号 + 时限；到货日期和补偿列为“发送前请核实” |
| 收到的打印机有 6 台无法开机 | 投诉 · 把握高 | 待审核 | 直接换新方案；换新时效待核实 |
| 想查一下订单 SO-20261015 的发货进度 | 查询 · 把握高 | 待审核 | 简洁给出状态和到货时间 |
| 询问上月的发票 | 查询 | 待补充 | 缺订单号，AI 不硬写，列出需要补充的信息 |
| 咨询：系统能否对接企业微信？支持私有化部署吗？ | 咨询 · 把握高 | 待审核 | 逐条回答 + 约演示时间；价格区间待核实 |
| 你们有免费试用吗？ | 咨询 · 把握中 | 待审核 | 简短友好的试用说明 |
| 续费价格怎么涨了这么多？ | 投诉还是咨询？把握中 | 未匹配 | AI 不确定时不擅自处理，建议方案等你确认 |
| 您的云服务器将于 11 月 1 日自动续费 | 系统通知 | 已归档 | 通知类自动归档，可恢复 |

### 演示流程与讲解词

1. **今日**：“早上打开工作台，简报已经告诉我今天有 7 封客户来信：投诉 2、查询 2、咨询 2，还有 1 封要我确认分类。系统通知已经自动归档。”
2. **处理方案**：依次点开三个方案。“分类不是关键词匹配，而是一句话的适用说明，AI 按含义判断。每个分类有自己的回复要求，比如投诉必须先致歉、不能随便承诺赔偿。”
3. **待我决策 → 催货投诉**：指给观众看
   - 顶部：“AI 判断”说明为什么紧急；“AI 选择方案（把握高）”说明为什么是投诉；
   - “发送前请核实 2 处”：到货日期、补偿方案，草稿里不写死；
   - 回复草稿：语气诚恳，有编号、负责人、时限。
4. **对比查询和咨询**：点开订单查询和企业微信咨询。“同样是回复，查询类短而准，咨询类逐条回答并推进下一步。语气和结构随分类变化。”
5. **待补充 → 发票查询**：“信息不够时 AI 不编造，而是列出需要补充什么。”
6. **未匹配 → 续费涨价**：“这封既有不满又在问套餐。AI 把握不足时只建议，不擅自处理；我选一个方案，它就会记住，下次类似的信判断得更准。”
7. **预览并发送**：在任一草稿点“预览并发送”，展示收件人核对和邮件样式。“任何邮件都要我确认后才发出。”（演示到预览为止，不要点最后的确认发送。）

### 用真实 AI 现场演示（可选）

在 DSH 已配置模型、且有一个**测试邮箱**的环境里：在工作台新建上表三个方案（适用说明和回复要求可直接复制），然后从另一个邮箱把上面几封来信发到测试邮箱，点“立即检测”。AI 会现场分类并起草回复，结果会与合成数据相近但不完全相同。

---

## English version

The demo: customer emails arrive in the workbench → AI sorts them by meaning into **Complaints / Inquiries / Consultation** (one workflow each) → each category gets a reply drafted to its own rules → a person checks it in “Needs me” and sends it.

### Setup (about 2 minutes)

All demo data is synthetic (every address is on the `.test` domain). Background processing stays off and no real mailbox is connected. Use a separate new folder, never the HOME you use day to day.

```powershell
pnpm run build
node scripts/seed-demo.mjs --home D:/runtime/poc/bkms-workbench-demo-en --lang en
powershell -File scripts/start-workbench.ps1 -DshHome D:/runtime/poc/bkms-workbench-demo-en -Profile bkms-demo-en -Port 9189
```

- The folder name must contain `runtime/poc/bkms-workbench-demo` and be new or empty; the script refuses anything else.
- So the page can show reply drafts, the script adds a placeholder mailbox, `service@demo.example.test`. The `.test` domain does not exist, so it cannot connect anywhere or send mail. **Don’t click “Enable” during the demo**; if you do, you’ll only see a connection error.
- The interface language follows DSH’s language setting; set DSH to English for this version.

### The three categories (workflows)

| Category | What AI judges by (“When it applies”) | Reply rules |
| --- | --- | --- |
| Customer complaints | Customer is unhappy with a product, service, delivery or bill, or asks for compensation or an apology | Apologize, restate the problem, give a case number, owner and deadline; never promise compensation amounts |
| Order & account inquiries | Questions about an existing order, shipment, invoice, account or contract | Give order number, status and expected date; ask for the order number if missing |
| Pre-sales consultation | Questions about features, fit, pricing, trials or working together | Recommend a fit, answer each question, propose a demo, trial or quote |

All three are “Handle after AI confirms” and “Draft only” (nothing is sent automatically).

### Demo data

| Email | Classification | Status | What to show |
| --- | --- | --- | --- |
| Third reminder: order SO-20261008 STILL not delivered! | Complaint · urgent · high confidence | Needs review | Apology + case number + deadline; delivery date and compensation flagged under “Check before sending” |
| 6 of the printers we received won't power on | Complaint · high confidence | Needs review | Direct replacement; lead time to verify |
| Checking on shipment status for order SO-20261015 | Inquiry · high confidence | Needs review | Short, precise status and arrival time |
| Question about last month's invoice | Inquiry | Needs info | No order number, so AI lists what’s missing instead of guessing |
| Question: Slack integration and on-premises deployment? | Consultation · high confidence | Needs review | Point-by-point answers + demo slots; price range to verify |
| Do you offer a free trial? | Consultation · medium confidence | Needs review | Short, friendly trial details |
| Why did the renewal price go up so much? | Complaint or consultation? medium | Unmatched | When unsure, AI suggests a workflow and waits for you |
| Your cloud server will auto-renew on November 1 | System notice | Archived | Notices are archived automatically and can be restored |

### Walkthrough and talking points

1. **Today**: “When I open the workbench, the brief already says there are 7 customer emails: 2 complaints, 2 inquiries, 2 consultations, and 1 that needs me to pick a category. The system notice was archived for me.”
2. **Workflow**: open each of the three workflows. “Classification isn’t keyword matching. Each category has a one-sentence description and AI judges by meaning. Each category also has its own reply rules: complaints must start with an apology and never promise compensation.”
3. **Needs me → the late-delivery complaint**: point out
   - at the top, the AI judgment explains why it’s urgent, and “Workflow chosen by AI (High confidence)” explains why it’s a complaint;
   - “Check 2 item(s) before sending”: the delivery date and compensation aren’t committed in the draft;
   - the reply draft: sincere tone, case number, owner, deadline.
4. **Compare inquiry and consultation**: open the shipment inquiry and the Slack consultation. “Both are replies, but an inquiry is short and exact while a consultation answers point by point and moves to a next step. Tone and structure follow the category.”
5. **Needs info → the invoice question**: “When information is missing, AI doesn’t make it up; it lists what’s needed.”
6. **Unmatched → the renewal price email**: “This one is both a complaint and a plan question. When AI isn’t sure, it only suggests. Once I pick a workflow, it learns from that, so similar emails are judged better next time.”
7. **Preview and send**: on any draft, click “Preview and send” to show the recipient check and the email layout. “Nothing is sent until I confirm.” (Stop at the preview; don’t click the final confirm.)

### Live demo with real AI (optional)

In a DSH with a model configured and a **test mailbox**: create the three workflows above in the workbench (copy the descriptions and reply rules), send the sample emails above to the test mailbox from another account, then click “Check now”. AI classifies and drafts replies live; results will be close to, but not exactly the same as, the synthetic data.

---

截图 / Screenshots: `docs/screenshots/demo/`（zh-complaint、zh-preview、en-complaint、en-workflows）
