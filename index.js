"use strict";

const crypto = require("crypto");
const Http = require("./src/http");
const { buildApi } = require("./src/api");

const DEFAULT_OPTIONS = {
  selfListen: false, // নিজের পাঠানো message-এও event পাবে কিনা
  listenEvents: true, // group join/leave, reaction, typing ইত্যাদি event
  sendDelayMs: 1200, // দুটি message-এর মাঝে ন্যূনতম বিরতি (ban ঝুঁকি কমায়)
  autoReconnect: true,
  maxRetries: 20,
};

function computeJazoest(dtsg) {
  let sum = 0;
  for (let i = 0; i < dtsg.length; i++) sum += dtsg.charCodeAt(i);
  return "2" + sum;
}

function parseHome(html) {
  const dtsg = (
    html.match(/"DTSGInitialData",\[\],\{"token":"([^"]+)"/) ||
    html.match(/name="fb_dtsg" value="([^"]+)"/) ||
    html.match(/"dtsg":\{"token":"([^"]+)"/) ||
    []
  )[1];
  if (!dtsg) {
    throw new Error(
      "fb_dtsg not found: AppState expired, checkpoint required, or Facebook changed its page layout"
    );
  }
  const jazoest = (html.match(/name="jazoest" value="(\d+)"/) || [])[1] || computeJazoest(dtsg);
  const region = ((html.match(/"region":"([a-z]{3})"/i) || [])[1] || "prn").toLowerCase();
  return { dtsg, jazoest, region };
}

async function doLogin(credentials) {
  if (!credentials || !Array.isArray(credentials.appState)) {
    throw new Error("appState (array of cookies) is required");
  }

  const http = new Http(credentials.appState);
  const userID = http.jar.get("c_user");
  if (!userID) throw new Error("c_user cookie missing: AppState is invalid or expired");

  const ctx = {
    http,
    userID,
    fbDtsg: "",
    jazoest: "",
    region: "prn",
    clientID: crypto.randomBytes(4).toString("hex"),
    req: 0,
    lastSeqId: null,
    syncToken: null,
    options: { ...DEFAULT_OPTIONS, ...(credentials.options || {}) },

    // Common form fields Facebook expects on ajax calls
    form(extra = {}) {
      ctx.req += 1;
      return {
        __user: userID,
        __a: "1",
        __req: ctx.req.toString(36),
        __rev: "1000000000",
        fb_dtsg: ctx.fbDtsg,
        jazoest: ctx.jazoest,
        ...extra,
      };
    },

    // Re-scrape tokens (used on reconnect / after session hiccups)
    async refreshTokens() {
      const html = await http.getText("https://www.facebook.com/");
      const t = parseHome(html);
      ctx.fbDtsg = t.dtsg;
      ctx.jazoest = t.jazoest;
      ctx.region = t.region;
    },
  };

  await ctx.refreshTokens();
  return buildApi(ctx);
}

// Works both with callback and with promises
function login(credentials, callback) {
  const p = doLogin(credentials);
  if (typeof callback === "function") {
    p.then((api) => callback(null, api)).catch((err) => callback(err));
    return;
  }
  return p;
}

module.exports = login;
