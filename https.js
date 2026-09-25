"use strict";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

class Http {
  constructor(appState) {
    this.jar = new Map();
    for (const c of appState) {
      const name = c.key || c.name;
      if (name && c.value !== undefined) this.jar.set(name, c.value);
    }
  }

  get userAgent() {
    return UA;
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  exportAppState() {
    return [...this.jar].map(([key, value]) => ({
      key,
      value,
      domain: ".facebook.com",
      path: "/",
    }));
  }

  _absorb(res) {
    const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
    for (const line of list) {
      const kv = line.split(";")[0];
      const i = kv.indexOf("=");
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  _headers(extra = {}) {
    return {
      "User-Agent": UA,
      Cookie: this.cookieHeader(),
      Origin: "https://www.facebook.com",
      Referer: "https://www.facebook.com/",
      "Accept-Language": "en-US,en;q=0.9",
      ...extra,
    };
  }

  _parse(text) {
    try {
      // Facebook prefixes JSON responses with "for (;;);"
      return JSON.parse(text.replace(/^for \(;;\);/, ""));
    } catch (e) {
      const err = new Error("Non-JSON response from Facebook (session expired, blocked, or endpoint changed)");
      err.raw = text.slice(0, 300);
      throw err;
    }
  }

  async getText(url) {
    const res = await fetch(url, { headers: this._headers(), redirect: "follow" });
    this._absorb(res);
    return res.text();
  }

  async postRaw(url, form) {
    const res = await fetch(url, {
      method: "POST",
      headers: this._headers({ "Content-Type": "application/x-www-form-urlencoded" }),
      body: new URLSearchParams(form).toString(),
    });
    this._absorb(res);
    return res.text();
  }

  async postJson(url, form) {
    return this._parse(await this.postRaw(url, form));
  }

  // file: { field, buffer, filename, contentType }
  async postMultipart(url, form, file) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, String(v));
    fd.append(file.field, new Blob([file.buffer], { type: file.contentType }), file.filename);
    const res = await fetch(url, { method: "POST", headers: this._headers(), body: fd });
    this._absorb(res);
    return this._parse(await res.text());
  }
}

module.exports = Http;
