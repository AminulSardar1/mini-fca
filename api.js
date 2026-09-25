"use strict";

const fs = require("fs");
const path = require("path");
const { createListener } = require("./listen");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MIME = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".gif": "image/gif",
  ".webp": "image/webp", ".mp4": "video/mp4", ".mov": "video/quicktime", ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4", ".ogg": "audio/ogg", ".wav": "audio/wav", ".pdf": "application/pdf",
  ".txt": "text/plain", ".zip": "application/zip",
};

// Offline threading ID: timestamp bits + 22 random bits, as a decimal string
function genOfflineThreadingID() {
  const now = Date.now();
  const rand = Math.floor(Math.random() * 4294967295);
  const bits = ("0000000000000000000000" + rand.toString(2)).slice(-22);
  return BigInt("0b" + now.toString(2) + bits).toString();
}

async function streamToBuffer(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks);
}

// Accepts: file path | Buffer | { buffer, filename, contentType } | readable stream
async function toFile(att) {
  let buffer, filename = "file", ext = "";
  if (typeof att === "string") {
    buffer = await fs.promises.readFile(att);
    filename = path.basename(att);
  } else if (Buffer.isBuffer(att)) {
    buffer = att;
  } else if (att && att.buffer) {
    buffer = att.buffer;
    filename = att.filename || filename;
  } else if (att && typeof att.pipe === "function") {
    buffer = await streamToBuffer(att);
    if (att.path) filename = path.basename(String(att.path));
  } else {
    throw new Error("Unsupported attachment type");
  }
  ext = path.extname(filename).toLowerCase();
  const contentType = (att && att.contentType) || MIME[ext] || "application/octet-stream";
  return { buffer, filename, contentType };
}

function buildApi(ctx) {
  const api = {};

  // ---------- internal helpers ----------
  const call = async (url, extra = {}) => {
    const res = await ctx.http.postJson(url, ctx.form(extra));
    if (res.error) {
      const e = new Error(
        `${url.split("/").slice(-2).join("/")} failed: ${res.errorDescription || res.errorSummary || res.error}`
      );
      e.code = res.error;
      e.response = res;
      throw e;
    }
    return res;
  };

  // Serialize sends with a minimum delay to reduce spam detection
  let chain = Promise.resolve();
  const enqueue = (fn) => {
    const run = chain.then(fn);
    chain = run.catch(() => {}).then(() => sleep(ctx.options.sendDelayMs));
    return run;
  };

  const messageBase = () => {
    const otid = genOfflineThreadingID();
    return {
      otid,
      fields: {
        client: "mercury",
        action_type: "ma-type:user-generated-message",
        author: "fbid:" + ctx.userID,
        timestamp: Date.now(),
        source: "source:chat:web",
        "source_tags[0]": "source:chat",
        html_body: false,
        ui_push_phase: "V3",
        status: "0",
        offline_threading_id: otid,
        message_id: otid,
        threading_id: `<${Date.now()}:${Math.floor(Math.random() * 4294967295)}-${ctx.clientID}@mail.projektitan.com>`,
        "ephemeral_ttl_mode:": "0",
        manual_retry_cnt: "0",
        has_attachment: false,
        signatureID: Math.floor(Math.random() * 2147483648).toString(16),
      },
    };
  };

  const SEND_URL = "https://www.facebook.com/messaging/send/";

  // ---------- session ----------
  api.getCurrentUserID = () => ctx.userID;
  api.getAppState = () => ctx.http.exportAppState();
  api.setOptions = (opts) => Object.assign(ctx.options, opts);
  api.refreshTokens = () => ctx.refreshTokens();

  // ---------- attachments ----------
  api.uploadAttachment = async (att) => {
    const file = await toFile(att);
    const res = await ctx.http.postMultipart(
      "https://upload.facebook.com/ajax/mercury/upload.php",
      ctx.form({ voice_clip: "false" }),
      { field: "upload_1024", ...file }
    );
    if (res.error) throw new Error("upload failed: " + (res.errorDescription || res.error));
    const meta = res.payload && res.payload.metadata && res.payload.metadata[0];
    if (!meta) throw new Error("upload failed: empty metadata");
    const key = Object.keys(meta).find((k) => /_id$/.test(k));
    if (!key) throw new Error("upload failed: unknown metadata shape");
    return { type: key, id: meta[key] }; // e.g. { type: "image_id", id: "123..." }
  };

  // ---------- messaging ----------
  // sendMessage("hi", threadID, { isGroup })
  // sendMessage({ body, attachment: [path|Buffer], sticker, mentions:[{tag,id}], replyTo }, threadID, { isGroup })
  api.sendMessage = (message, threadID, opts = {}) =>
    enqueue(async () => {
      if (!threadID) throw new Error("threadID is required");
      const msg = typeof message === "string" ? { body: message } : { ...message };
      if (!msg.body && !msg.attachment && !msg.sticker) throw new Error("Nothing to send");

      const { otid, fields } = messageBase();
      fields.body = msg.body || "";

      (msg.mentions || []).forEach((m, i) => {
        const offset = fields.body.indexOf(m.tag, m.fromIndex || 0);
        if (offset < 0) return;
        fields[`profile_xmd[${i}][id]`] = m.id;
        fields[`profile_xmd[${i}][offset]`] = offset;
        fields[`profile_xmd[${i}][length]`] = m.tag.length;
        fields[`profile_xmd[${i}][type]`] = "p";
      });

      const atts = msg.attachment ? [].concat(msg.attachment) : [];
      const counters = {};
      for (const a of atts) {
        const { type, id } = await api.uploadAttachment(a);
        const n = counters[type] || 0;
        counters[type] = n + 1;
        fields[`${type}s[${n}]`] = id;
        fields.has_attachment = true;
      }

      if (msg.sticker) {
        fields.sticker_id = msg.sticker;
        fields.has_attachment = true;
      }
      if (msg.replyTo) fields.replied_to_message_id = msg.replyTo;

      if (opts.isGroup) {
        fields.thread_fbid = threadID;
      } else {
        fields.other_user_fbid = threadID;
        fields["specific_to_list[0]"] = "fbid:" + threadID;
        fields["specific_to_list[1]"] = "fbid:" + ctx.userID;
      }

      const res = await call(SEND_URL, fields);
      const act = res.payload && res.payload.actions && res.payload.actions[0];
      return { messageID: (act && act.message_id) || otid, threadID };
    });

  api.unsendMessage = async (messageID) => {
    await call("https://www.facebook.com/messaging/unsend_message/", { message_id: messageID });
  };

  // emoji = "❤" etc. Pass "" to remove the reaction
  api.setMessageReaction = async (emoji, messageID) => {
    const res = await ctx.http.postJson(
      "https://www.facebook.com/webgraphql/mutation/",
      ctx.form({
        doc_id: "1491398900900362",
        variables: JSON.stringify({
          data: {
            action: emoji ? "ADD_REACTION" : "REMOVE_REACTION",
            client_mutation_id: "1",
            actor_id: ctx.userID,
            message_id: String(messageID),
            reaction: emoji || undefined,
          },
        }),
        dpr: 1,
      })
    );
    if (res.error) throw new Error("setMessageReaction failed: " + (res.errorDescription || res.error));
  };

  api.markAsRead = async (threadID, read = true) => {
    await call("https://www.facebook.com/ajax/mercury/change_read_status.php", {
      [`ids[${threadID}]`]: read,
      watermarkTimestamp: Date.now(),
      shouldSendReadReceipt: true,
      commerce_last_message_type: "non_ad",
    });
  };

  api.sendTypingIndicator = async (threadID, isTyping = true, isGroup = false) => {
    await ctx.http.postRaw(
      "https://www.facebook.com/ajax/messaging/typ.php",
      ctx.form({ typ: isTyping ? 1 : 0, to: isGroup ? "" : threadID, source: "mercury-chat", thread: threadID })
    );
  };

  // ---------- users ----------
  api.getUserInfo = async (userID) => {
    const res = await call("https://www.facebook.com/chat/user_info/", { "ids[0]": userID });
    return res.payload && res.payload.profiles ? res.payload.profiles[userID] || null : null;
  };

  api.getFriendsList = async () => {
    const res = await call("https://www.facebook.com/chat/user_info_all", { viewer: ctx.userID });
    const p = (res && res.payload) || {};
    return Object.keys(p).map((id) => ({ userID: id, ...p[id] }));
  };

  // ---------- threads ----------
  api.getThreadInfo = async (threadID) => {
    const res = await call("https://www.facebook.com/ajax/mercury/thread_info.php", {
      client: "mercury",
      "threads[thread_fbids][0]": threadID,
    });
    return (res.payload && res.payload.threads && res.payload.threads[0]) || null;
  };

  api.getThreadList = async (limit = 20, offset = 0) => {
    const res = await call("https://www.facebook.com/ajax/mercury/threadlist_info.php", {
      client: "mercury",
      "inbox[offset]": offset,
      "inbox[limit]": limit,
      "inbox[filter]": "",
    });
    return (res.payload && res.payload.threads) || [];
  };

  api.getThreadHistory = async (threadID, amount = 20, beforeTimestamp = null, isGroup = false) => {
    const kind = isGroup ? "thread_fbids" : "user_ids";
    const form = {
      client: "mercury",
      [`messages[${kind}][${threadID}][offset]`]: 0,
      [`messages[${kind}][${threadID}][limit]`]: amount,
    };
    if (beforeTimestamp) form[`messages[${kind}][${threadID}][timestamp]`] = beforeTimestamp;
    const res = await call("https://www.facebook.com/ajax/mercury/thread_info.php", form);
    return (res.payload && res.payload.actions) || [];
  };

  // ---------- group management ----------
  api.changeNickname = async (nickname, threadID, participantID) => {
    await call("https://www.facebook.com/messaging/save_thread_nickname/", {
      nickname,
      participant_id: participantID,
      thread_or_other_fbid: threadID,
    });
  };

  api.setTitle = (newTitle, threadID) =>
    enqueue(async () => {
      const { fields } = messageBase();
      Object.assign(fields, {
        action_type: "ma-type:log-message",
        log_message_type: "log:thread-name",
        thread_name: newTitle,
        thread_fbid: threadID,
        thread_id: threadID,
      });
      await call(SEND_URL, fields);
    });

  api.addUserToGroup = (userIDs, threadID) =>
    enqueue(async () => {
      const { fields } = messageBase();
      Object.assign(fields, {
        action_type: "ma-type:log-message",
        log_message_type: "log:subscribe",
        thread_fbid: threadID,
      });
      [].concat(userIDs).forEach((id, i) => {
        fields[`log_message_data[added_participants][${i}]`] = "fbid:" + id;
      });
      await call(SEND_URL, fields);
    });

  api.removeUserFromGroup = async (userID, threadID) => {
    await call("https://www.facebook.com/chat/remove_participants/", { uid: userID, tid: threadID });
  };

  // Create a brand-new group chat. Returns the new threadID.
  // Facebook requires at least 2 other participants to create a *group* thread;
  // with exactly 1 participant it will just be a normal 1-to-1 thread.
  api.createGroup = (userIDs, title) =>
    enqueue(async () => {
      const ids = [].concat(userIDs);
      if (ids.length < 2) throw new Error("createGroup needs at least 2 other participants");

      const { otid, fields } = messageBase();
      fields.body = "";
      ids.forEach((id, i) => {
        fields[`specific_to_list[${i}]`] = "fbid:" + id;
      });
      fields[`specific_to_list[${ids.length}]`] = "fbid:" + ctx.userID;
      fields.client_thread_id = "root:" + otid;
      if (title) fields.thread_name = title;

      const res = await call(SEND_URL, fields);
      const act = res.payload && res.payload.actions && res.payload.actions[0];
      const threadID = act && (act.thread_fbid || act.threadid);
      if (!threadID) throw new Error("createGroup: could not read new thread id from response");
      return String(threadID);
    });

  // role: "admin" grants, "member" revokes
  api.changeAdminStatus = async (threadID, userID, makeAdmin = true) => {
    await call("https://www.facebook.com/messaging/save_admins/", {
      thread_fbid: threadID,
      [`admin_ids[${makeAdmin ? "add" : "remove"}][0]`]: userID,
    });
  };

  // hex color like "#0084ff", or one of Messenger's named theme ids
  api.changeThreadColor = async (threadID, color) => {
    await call("https://www.facebook.com/messaging/save_thread_color/", {
      thread_fbid: threadID,
      color,
    });
  };

  // emoji = single emoji character used as the thread's quick-reaction/icon
  api.changeThreadEmoji = async (threadID, emoji) => {
    await call("https://www.facebook.com/messaging/save_thread_emoji/", {
      thread_fbid: threadID,
      emoji_choice: emoji,
    });
  };

  api.muteThread = async (threadID, muteSeconds = -1) => {
    // muteSeconds: -1 = mute indefinitely, 0 = unmute, N = mute for N seconds
    await call("https://www.facebook.com/ajax/mercury/change_mute_thread.php", {
      thread_fbid: threadID,
      mute_settings: muteSeconds,
    });
  };

  api.pinMessage = async (threadID, messageID, pinned = true) => {
    const res = await ctx.http.postJson(
      "https://www.facebook.com/webgraphql/mutation/",
      ctx.form({
        doc_id: "4260452710709500",
        variables: JSON.stringify({
          input: {
            thread_key: threadID,
            message_id: messageID,
            pinned_state: pinned ? "PINNED" : "UNPINNED",
            actor_id: ctx.userID,
            client_mutation_id: "1",
          },
        }),
      })
    );
    if (res.error) throw new Error("pinMessage failed: " + (res.errorDescription || res.error));
  };

  // options: array of strings; multiSelect allows more than one vote per person
  api.createPoll = async (threadID, question, options, multiSelect = false) => {
    const form = ctx.form({
      thread_fbid: threadID,
      question_text: question,
      group_poll_allow_multiselect: multiSelect,
    });
    options.forEach((opt, i) => {
      form[`options_text_array[${i}]`] = opt;
    });
    const res = await call("https://www.facebook.com/messaging/group_polling/create_poll/", form);
    return (res.payload && res.payload.poll_id) || null;
  };

  api.voteInPoll = async (pollID, optionIDs) => {
    const form = ctx.form({ question_id: pollID });
    [].concat(optionIDs).forEach((id, i) => {
      form[`option_ids[${i}]`] = id;
    });
    await call("https://www.facebook.com/messaging/group_polling/update_vote/", form);
  };

  // ---------- privacy ----------
  api.blockUser = async (userID) => {
    await call("https://www.facebook.com/ajax/settings/blocking/block.php", { uid: userID });
  };

  api.unblockUser = async (userID) => {
    await call("https://www.facebook.com/ajax/settings/blocking/unblock.php", { uid: userID });
  };

  // ---------- search ----------
  // Search threads by name (people or group titles)
  api.searchThreads = async (query, limit = 10) => {
    const res = await call("https://www.facebook.com/ajax/typeahead/search.php", {
      filter: "user,group,pages",
      value: query,
      viewer: ctx.userID,
      rsp: "search",
      context: "search",
      limit,
    });
    return (res.payload && (res.payload.entries || res.payload)) || [];
  };

  // Full-text search within one thread's message history.
  // Facebook's search backend for this shifts around; treat the shape of
  // the response as unstable and verify against your own account.
  api.searchMessages = async (threadID, query, limit = 20) => {
    const res = await call("https://www.facebook.com/ajax/mercury/search_snippets.php", {
      query,
      snippetLimit: limit,
      "identifiers[0]": threadID,
    });
    return (res.payload && res.payload.snippets && res.payload.snippets[threadID]) || [];
  };

  // ---------- media (large/chunked upload) ----------
  // For files too large for a single multipart POST (long videos, large
  // archives). Splits into chunks and uploads sequentially, then finalizes.
  // Chunk size and the resumable-upload endpoint shape are the parts of
  // Facebook's upload pipeline most likely to have moved; if this fails,
  // fall back to api.uploadAttachment for files under ~25MB.
  api.uploadLargeAttachment = async (att, { chunkSizeBytes = 4 * 1024 * 1024 } = {}) => {
    const file = await toFile(att);
    const total = file.buffer.length;
    if (total <= chunkSizeBytes) return api.uploadAttachment(att);

    const startRes = await ctx.http.postJson(
      "https://www.facebook.com/ajax/mercury/upload_resumable_start.php",
      ctx.form({ file_name: file.filename, file_size: total, content_type: file.contentType })
    );
    if (startRes.error) throw new Error("resumable start failed: " + (startRes.errorDescription || startRes.error));
    const uploadSessionId = startRes.payload && startRes.payload.upload_session_id;
    if (!uploadSessionId) throw new Error("resumable start: no upload_session_id in response");

    for (let offset = 0; offset < total; offset += chunkSizeBytes) {
      const chunk = file.buffer.subarray(offset, Math.min(offset + chunkSizeBytes, total));
      const res = await ctx.http.postMultipart(
        "https://upload.facebook.com/ajax/mercury/upload_resumable_chunk.php",
        ctx.form({ upload_session_id: uploadSessionId, offset }),
        { field: "chunk", buffer: chunk, filename: file.filename, contentType: file.contentType }
      );
      if (res.error) throw new Error(`chunk upload failed at offset ${offset}: ` + (res.errorDescription || res.error));
    }

    const finishRes = await ctx.http.postJson(
      "https://www.facebook.com/ajax/mercury/upload_resumable_finish.php",
      ctx.form({ upload_session_id: uploadSessionId })
    );
    if (finishRes.error) throw new Error("resumable finish failed: " + (finishRes.errorDescription || finishRes.error));
    const meta = finishRes.payload && finishRes.payload.metadata && finishRes.payload.metadata[0];
    if (!meta) throw new Error("resumable finish: empty metadata");
    const key = Object.keys(meta).find((k) => /_id$/.test(k));
    return { type: key, id: meta[key] };
  };

  // ---------- listening ----------
  // const stop = api.listen((err, event) => {...})
  api.listen = (callback) => createListener(ctx, api, callback);
  api.listenMqtt = api.listen; // FCA-style alias

  return api;
}

module.exports = { buildApi };
