import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("CSS variables without a fallback resolve to a declared dashboard token", () => {
  const source = resolve(import.meta.dir, "../src");
  const files = [...new Bun.Glob("**/*.css").scanSync(source)];
  const sheets = files.map(file => ({ file, css: readFileSync(resolve(source, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "") }));
  const declared = new Set(sheets.flatMap(({ css }) => [...css.matchAll(/(--[\w-]+)\s*:/g)].map(match => match[1])));
  const missing = sheets.flatMap(({ file, css }) => [...css.matchAll(/var\((--[\w-]+)\s*\)/g)]
    .filter(match => !declared.has(match[1]))
    .map(match => `${file}:${css.slice(0, match.index).split("\n").length}: ${match[1]}`));
  expect(missing).toEqual([]);
});
