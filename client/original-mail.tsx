import * as React from 'react';
import { useMemo, useState } from 'react';
import { t } from './i18n';
import { splitQuoted } from '../src/quoted';

const tags = new Set('div span p br hr table thead tbody tfoot tr td th colgroup col caption h1 h2 h3 h4 h5 h6 b strong i em u s small sub sup blockquote pre code ul ol li dl dt dd center font a'.split(' '));
const discard = new Set('script style iframe frame frameset object embed applet form input button textarea select option link meta base svg math video audio source template noscript'.split(' '));
const styles = new Set('color background-color font font-family font-size font-weight font-style line-height text-align text-decoration text-indent white-space word-break overflow-wrap border border-top border-right border-bottom border-left border-color border-width border-style border-radius border-collapse border-spacing padding padding-top padding-right padding-bottom padding-left margin margin-top margin-right margin-bottom margin-left width max-width vertical-align display list-style-type letter-spacing'.split(' '));

/** Rebuild inert HTML with presentation-only elements, then isolate with sandbox + CSP.
 * No original resource URLs, event handlers, navigation or active content survive.
 */
export function mailDocument(html: string): string {
  const input = document.createElement('template');
  input.innerHTML = html.slice(0, 256 * 1024);
  const output = document.createElement('div');
  let remaining = 10000;
  const copy = (node: Node, parent: Node, depth: number): void => {
    if (--remaining < 0 || depth > 80) return;
    if (node.nodeType === Node.TEXT_NODE) { parent.appendChild(document.createTextNode(node.textContent || '')); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const source = node as HTMLElement, tag = source.localName.toLowerCase();
    if (discard.has(tag)) return;
    if (tag === 'img') {
      if (source.getAttribute('alt')?.trim()) {
        const alt = document.createElement('span'); alt.className = 'image-label';
        alt.textContent = source.getAttribute('alt'); parent.appendChild(alt);
      }
      return;
    }
    if (!tags.has(tag)) { for (const child of Array.from(source.childNodes)) copy(child, parent, depth + 1); return; }
    const target = document.createElement(tag === 'a' || tag === 'font' ? 'span' : tag);
    for (const attr of ['colspan', 'rowspan', 'align', 'valign', 'cellpadding', 'cellspacing', 'dir', 'lang']) {
      const value = source.getAttribute(attr);
      if (value && /^[\w .%-]{1,40}$/.test(value)) target.setAttribute(attr, value);
    }
    const width = source.getAttribute('width');
    if (width && /^\d{1,4}%?$/.test(width)) target.style.width = /%$/.test(width) ? width : `${width}px`;
    const bg = source.getAttribute('bgcolor');
    if (bg && /^(#[a-f0-9]{3,8}|[a-z]{1,20})$/i.test(bg)) target.style.backgroundColor = bg;
    for (const property of Array.from(source.style)) {
      const value = source.style.getPropertyValue(property);
      const allowed = styles.has(property) || /^border-(top|right|bottom|left)-(color|width|style)$/.test(property);
      if (allowed && value.length < 300 && !/url|var\(|expression|@|\\|\/\*|position|fixed|sticky/i.test(value)) target.style.setProperty(property, value);
    }
    parent.appendChild(target);
    for (const child of Array.from(source.childNodes)) copy(child, target, depth + 1);
  };
  for (const node of Array.from(input.content.childNodes)) copy(node, output, 0);
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; base-uri 'none'; form-action 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html{background:#fff;color:#242b36}body{margin:0;padding:20px;font:14px/1.65 -apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;overflow-wrap:anywhere}body>div{max-width:100%}table{max-width:100%;box-sizing:border-box}td,th{overflow-wrap:anywhere}p{margin:0 0 12px}pre{white-space:pre-wrap}h1,h2,h3,h4{line-height:1.4}.image-label{display:inline-block;color:#7a8492;font-size:12px;padding:2px 6px}*{box-sizing:border-box}</style></head><body>${output.innerHTML}</body></html>`;
}

export function OriginalMailBody({ html, text }: { html?: string; text: string }) {
  const [plain, setPlain] = useState(false);
  const srcDoc = useMemo(() => html?.trim() ? mailDocument(html) : undefined, [html]);
  return <div className="bkw-mail-body">
    {srcDoc && <div className="bkw-mail-view-switch" role="group" aria-label={t('正文显示方式')}>
      <button type="button" aria-pressed={!plain} onClick={() => setPlain(false)}>{t('原始排版')}</button>
      <button type="button" aria-pressed={plain} onClick={() => setPlain(true)}>{t('纯文本')}</button>
    </div>}
    {srcDoc && !plain ? <iframe className="bkw-original-frame" title={t('原邮件正文')} sandbox="" referrerPolicy="no-referrer" srcDoc={srcDoc} /> :
      <PlainMail text={text} />}
  </div>;
}

const clean = (value: string) => value.replace(/\r\n?/g, '\n').replace(/^[\t ]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
/** Plain text with the quoted history folded below the new message, the same split AI uses. */
function PlainMail({ text }: { text: string }) {
  const split = useMemo(() => splitQuoted(text), [text]);
  if (!split.history.length) return <pre className="bkw-original">{clean(text)}</pre>;
  return <>
    <pre className="bkw-original">{clean(split.latest)}</pre>
    <details className="bkw-quoted">
      <summary>{t('引用的历史往来（{0} 段）', split.history.length)}</summary>
      {split.history.map((part, index) => <div key={index} className="bkw-quoted-part">{part.header && <div className="bkw-quoted-head">{part.header}</div>}<pre>{clean(part.text)}</pre></div>)}
    </details>
  </>;
}
