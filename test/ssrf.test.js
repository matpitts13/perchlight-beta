import { describe, it, expect } from "vitest";
// Copied from perchlight-hooks test/ssrf.test.js (src/lib/ssrf.js is copied unchanged).
import { checkTarget, localTargetsAllowed } from "../src/lib/ssrf.js";

const refused = (u, o) => {
  const r = checkTarget(u, o);
  expect(r.ok, `${u} should be refused`).toBe(false);
  return r.error;
};
const allowed = (u, o) => expect(checkTarget(u, o).ok, `${u} should be allowed`).toBe(true);

describe("SSRF rules for outgoing URLs", () => {
  it("refuses every private, loopback, link-local, CGNAT, multicast, unspecified and documentation IPv4 range", () => {
    for (const ip of ["127.0.0.1", "127.255.255.254", "10.0.0.5", "172.16.0.1", "172.31.255.255", "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "0.0.0.0", "0.1.2.3", "224.0.0.1", "239.255.255.255", "240.0.0.1", "255.255.255.255", "192.0.2.10", "198.51.100.1", "203.0.113.9", "198.18.0.1"]) {
      expect(refused(`https://${ip}/x`)).toMatch(/address/);
    }
    allowed("https://172.32.0.1/");
    allowed("https://100.128.0.1/");
    allowed("https://8.8.8.8/");
  });

  it("refuses decimal, hex, octal and short IPv4 forms (normalised by the URL parser)", () => {
    for (const u of ["http://2130706433/", "https://0x7f.0.0.1/", "https://0177.0.0.1/", "https://127.1/", "https://0x7f000001/", "https://017700000001/", "https://10.1/"]) refused(u, { allowHttp: true });
  });

  it("refuses IPv6 loopback, unspecified, unique-local, link-local, multicast, documentation and IPv4-mapped forms", () => {
    for (const u of ["https://[::1]/", "https://[::]/", "https://[fc00::1]/", "https://[fd12:3456::1]/", "https://[fe80::1]/", "https://[ff02::1]/", "https://[2001:db8::1]/", "https://[::ffff:127.0.0.1]/", "https://[::ffff:7f00:1]/", "https://[::ffff:a9fe:a9fe]/", "https://[::127.0.0.1]/", "https://[64:ff9b::a00:1]/"]) refused(u);
    allowed("https://[2606:4700::1111]/");
    allowed("https://[::ffff:8.8.8.8]/");
  });

  it("refuses localhost variants and local-only names", () => {
    for (const u of ["https://localhost/", "https://LOCALHOST./", "https://api.localhost/", "https://printer.local/", "https://db.internal/", "https://nas.home.arpa/", "https://intranet/"]) refused(u);
    allowed("https://example.com/");
  });

  it("refuses http unless allowed, credentials in the URL, other schemes", () => {
    expect(refused("http://example.com/")).toMatch(/https/);
    allowed("http://example.com/", { allowHttp: true });
    expect(refused("https://user:pw@example.com/")).toMatch(/user name or password/);
    refused("ftp://example.com/");
    refused("file:///etc/passwd");
    refused("not a url");
  });

  it("refuses this deployment's own capture and ping URLs (loops)", () => {
    expect(refused("https://hooks.test/h/abcdefghijklmnopqrstuv", { ownHost: "hooks.test" })).toMatch(/loop/);
    refused("https://HOOKS.test/p/abc", { ownHost: "hooks.test" });
    allowed("https://hooks.test/other", { ownHost: "hooks.test" });
  });

  it("local targets only for a local deployment that opted in", () => {
    expect(localTargetsAllowed({ ALLOW_LOCAL_TARGETS: "1", PUBLIC_URL: "http://127.0.0.1:8787" })).toBe(true);
    expect(localTargetsAllowed({ ALLOW_LOCAL_TARGETS: "1", PUBLIC_URL: "https://hooks.example.com" })).toBe(false);
    expect(localTargetsAllowed({ PUBLIC_URL: "http://127.0.0.1:8787" })).toBe(false);
    allowed("http://127.0.0.1:9311/job", { allowLocal: true });
    refused("http://10.0.0.1/", { allowLocal: true });
  });
});
