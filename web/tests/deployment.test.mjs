import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = path.dirname(webRoot);

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : [target];
  });
}

test("the hosted artifact is browser-native and contains no archived executable", () => {
  const extensions = walk(webRoot).map((file) => path.extname(file).toLowerCase());
  for (const forbidden of [".py", ".ipa", ".zip", ".nib", ".caf"]) {
    assert.equal(extensions.includes(forbidden), false, `${forbidden} must not ship to Pages`);
  }
});

test("mobile manifest and project-page paths are self-contained", () => {
  const index = fs.readFileSync(path.join(webRoot, "index.html"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(webRoot, "manifest.webmanifest"), "utf8"));

  assert.match(index, /name="viewport"[^>]+viewport-fit=cover/);
  assert.match(index, /rel="manifest" href="\.\/manifest\.webmanifest"/);
  assert.equal(manifest.start_url, "./");
  assert.equal(manifest.scope, "./");
  for (const icon of manifest.icons) {
    assert.ok(icon.src.startsWith("./"));
    assert.ok(fs.existsSync(path.resolve(webRoot, icon.src)), icon.src);
  }
});

test("Pages root launches the browser build without installation", () => {
  const launcher = fs.readFileSync(path.join(repositoryRoot, "index.html"), "utf8");
  const workflow = fs.readFileSync(path.join(repositoryRoot, ".github", "workflows", "pages.yml"), "utf8");
  assert.match(launcher, /url=\.\/web\//);
  assert.match(launcher, /window\.location\.replace\(`\.\/web\//);
  assert.match(workflow, /run: npm test/);
  assert.doesNotMatch(workflow, /deploy-pages/);
});
