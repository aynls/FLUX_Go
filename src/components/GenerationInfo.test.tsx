import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import GenerationInfo, { searchDocument } from "./GenerationInfo";
import { webUrl } from "../lib/links";

test("provider HTML stays sanitized inside a scriptless iframe", async () => {
  const dom = new Window();
  const previous = Object.getOwnPropertyDescriptor(globalThis, "DOMParser");
  Object.defineProperty(globalThis, "DOMParser", {
    configurable: true,
    value: dom.DOMParser,
  });
  try {
    const html = searchDocument(
      `<style>.chip{color:blue}</style><script>parent.secret()</script><base href="file:///C:/"><meta http-equiv="refresh" content="0;url=https://bad.example"><form></form><a href="javascript:bad()" onclick="bad()">bad</a><a href="https://www.google.com/search?q=flowers" target="_top" ping="https://tracker.example" onmouseover="bad()">flowers</a>`,
    );
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain("_top");
    expect(html).not.toContain("<base");
    expect(html).not.toContain("refresh");
    expect(html).not.toContain("tracker.example");
    expect(html).toContain("<style>.chip{color:blue}</style>");
    expect(html).toContain("https://www.google.com/search?q=flowers");
    expect(webUrl("file:///C:/secret.txt")).toBeNull();
    expect(webUrl("https://user:password@example.org")).toBeNull();
    const markup = renderToStaticMarkup(
      <GenerationInfo details={{ text: "", thoughts: "", sources: [], searchQueries: [], searchHtml: html }} />,
    );
    const document = new dom.DOMParser().parseFromString(markup, "text/html");
    expect(document.querySelector("iframe")?.getAttribute("sandbox")).toBe("allow-same-origin");
  } finally {
    if (previous) Object.defineProperty(globalThis, "DOMParser", previous);
    else Reflect.deleteProperty(globalThis, "DOMParser");
    await dom.happyDOM.close();
  }
});
