import { useMemo, useState } from "react";
import type { GenerationDetails } from "../lib/types";
import { openWebUrl, webUrl } from "../lib/links";

/** Provider suggestions live in a scriptless sandbox; they never enter the app DOM. */
export function searchDocument(html: string) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc
    .querySelectorAll("script,iframe,object,embed,form,meta,base,link")
    .forEach((el) => el.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes])
      if (attr.name.startsWith("on")) el.removeAttribute(attr.name);
  });
  doc.querySelectorAll("a").forEach((el) => {
    const href = webUrl(el.getAttribute("href") ?? "");
    if (href) el.setAttribute("href", href);
    else el.removeAttribute("href");
    el.removeAttribute("target");
    el.removeAttribute("download");
    el.removeAttribute("ping");
  });
  return `<!doctype html><html><head><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"><style>body{margin:8px;font:14px system-ui;color:#222;background:#fff}</style>${doc.head.innerHTML}</head><body>${doc.body.innerHTML}</body></html>`;
}
export default function GenerationInfo({
  details,
}: {
  details?: GenerationDetails | null;
}) {
  const [error, setError] = useState("");
  const html = useMemo(
    () => (details?.searchHtml ? searchDocument(details.searchHtml) : null),
    [details?.searchHtml],
  );
  if (!details) return null;
  const open = (url: string) => {
    void openWebUrl(url).catch((e) => setError(String(e)));
  };
  return (
    <section className="generation-info" aria-label="生成说明与来源">
      {details.text && (
        <details>
          <summary>生成说明</summary>
          <p className="response-text">{details.text}</p>
        </details>
      )}
      {!!details.sources.length && (
        <div className="generation-sources">
          <h3>参考来源</h3>
          <ul>
            {details.sources
              .filter((s) => webUrl(s.url))
              .map((s) => (
                <li key={s.url}>
                  <span>{s.kind === "image" ? "图片" : "网页"}</span>
                  <a
                    href={s.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => {
                      e.preventDefault();
                      open(s.url);
                    }}
                  >
                    {s.title}
                  </a>
                </li>
              ))}
          </ul>
        </div>
      )}
      {html && (
        <iframe
          className="search-suggestions"
          title="Google 搜索建议"
          sandbox="allow-same-origin"
          srcDoc={html}
          onLoad={(e) => {
            const frame = e.currentTarget;
            const doc = frame.contentDocument;
            if (!doc) return;
            frame.style.height = `${Math.min(400, Math.max(90, doc.body.scrollHeight + 16))}px`;
            doc.addEventListener("click", (e) => {
              const target = e.target as Element | null;
              const anchor = target?.closest?.("a");
              if (!anchor) return;
              e.preventDefault();
              const url = webUrl(anchor.getAttribute("href") ?? "");
              if (url) open(url);
            });
          }}
        />
      )}
      {!!details.searchQueries.length && (
        <details>
          <summary>使用的搜索词</summary>
          <p className="response-text">{details.searchQueries.join("\n")}</p>
        </details>
      )}
      {details.thoughts && (
        <details>
          <summary>思考摘要</summary>
          <p className="response-text">{details.thoughts}</p>
        </details>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
