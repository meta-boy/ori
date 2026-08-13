import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildApp, makeDb } from "./helpers";

/**
 * The dashboard is a Vite build served by the control plane at /dashboard.
 *
 * These assertions deliberately follow the BUILT output rather than naming files: Vite
 * fingerprints asset filenames, so any test that hardcodes `js/app.js` is wrong the moment
 * anything changes. Reading index.html and checking what it actually references catches the real
 * failure — an asset the page asks for that the server will not serve.
 */
const DASHBOARD_DIR = resolve(import.meta.dir, "../../packages/dashboard/dist");

const deps = { db: makeDb() };
const app = buildApp(deps);

/** Skip rather than fail when nothing is built: `make verify` builds first, a bare `bun test` may not. */
const built = await Bun.file(resolve(DASHBOARD_DIR, "index.html")).exists();

test("GET / redirects to the dashboard", async () => {
  const res = await app.request("/");
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toBe("/dashboard");
});

describe.skipIf(!built)("T-DASH-01 /dashboard serves the built app", () => {
  test("GET /dashboard serves the HTML shell", async () => {
    const res = await app.request("/dashboard");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type") ?? "").toContain("text/html");
    const html = await res.text();
    expect(html).toContain('id="root"');
  });

  test("every asset the page references is served", async () => {
    // The check that matters. A missing asset is a blank screen with a console error, and no
    // server-side test notices unless it follows the references.
    const html = await (await app.request("/dashboard")).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((h) => !/^(https?:|data:|#)/.test(h));
    expect(refs.length).toBeGreaterThan(0);

    for (const ref of refs) {
      const path = ref.startsWith("/") ? ref : `/dashboard/${ref}`;
      const res = await app.request(path);
      expect(res.status, `${ref} -> ${res.status}`).toBe(200);
    }
  });

  test("javascript and css arrive with usable content types", async () => {
    // A module served as text/plain is refused by the browser, and the page silently does nothing.
    const html = await (await app.request("/dashboard")).text();
    const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]!);
    for (const ref of refs) {
      if (!/\.(js|css)$/.test(ref)) continue;
      const res = await app.request(ref.startsWith("/") ? ref : `/dashboard/${ref}`);
      const ct = res.headers.get("content-type") ?? "";
      expect(ct, ref).toMatch(ref.endsWith(".css") ? /css/ : /javascript/);
    }
  });

  test("fingerprinted assets are cacheable, the HTML shell is not", async () => {
    // Cache index.html and a deploy pins browsers to a bundle whose assets no longer exist.
    const shell = await app.request("/dashboard");
    expect(shell.headers.get("cache-control") ?? "").toContain("no-cache");

    const html = await shell.text();
    const asset = [...html.matchAll(/(?:src|href)="([^"]*assets\/[^"]+)"/g)].map((m) => m[1]!)[0];
    if (asset) {
      const res = await app.request(asset.startsWith("/") ? asset : `/dashboard/${asset}`);
      expect(res.headers.get("cache-control") ?? "").toContain("immutable");
    }
  });

  test("path traversal never serves a file outside the build directory", async () => {
    for (const path of [
      "/dashboard/../../etc/passwd",
      "/dashboard/..%2f..%2fetc%2fpasswd",
      "/dashboard/%2e%2e/%2e%2e/etc/passwd",
      "/dashboard/../../api/src/index.ts",
      "/dashboard/assets/../../../../etc/passwd",
    ]) {
      const res = await app.request(path);
      expect([403, 404].includes(res.status), `${path} -> ${res.status}`).toBe(true);
      expect(await res.text(), path).not.toContain("root:");
    }
  });

  test("a missing file under /dashboard is 404, never the HTML shell", async () => {
    // Returning index.html for any unknown path is a common SPA default and it hides typos in
    // asset URLs: the browser gets HTML where it expected JavaScript.
    const res = await app.request("/dashboard/does-not-exist.js");
    expect(res.status).toBe(404);
  });

  test("the dashboard does not bypass API auth", async () => {
    const res = await app.request("/api/ori/v1/me");
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.code).toBe("unauthorized");
  });
});

describe("T-DASH-01 an unbuilt dashboard says so", () => {
  test("the handler distinguishes 'not built' from 'not found'", async () => {
    // Only meaningful when dist is absent; when it is present this documents the intent.
    const res = await app.request("/dashboard");
    if (!built) {
      expect(res.status).toBe(503);
      expect(await res.text()).toContain("not built");
    } else {
      expect(res.status).toBe(200);
    }
  });
});
