"use strict";

const mqtt = require("mqtt");

const TOPICS = [
  "/t_ms", "/thread_typing", "/orca_typing_notifications", "/orca_presence", "/legacy_web",
  "/br_sr", "/sr_res", "/webrtc", "/onevc", "/notify_disconnect", "/inbox", "/mercury",
  "/messaging_events", "/orca_message_notifications", "/pp", "/webrtc_response",
];

// Initial sync sequence id via GraphQL.
// The doc_id below is an internal Facebook value and may be outdated.
async function fetchSeqID(ctx) {
  const form = ctx.form({
    queries: JSON.stringify({
      o0: {
        doc_id: "3336396659757871",
        query_params: { limit: 1, before: null, tags: ["INBOX"], includeDeliveryReceipts: false, includeSeqID: true },
      },
    }),
    batch_name: "MessengerGraphQLThreadlistFetcher",
  });
  const text = await ctx.http.postRaw("https://www.facebook.com/api/graphqlbatch/", form);
  const first = text.split("\n")[0].replace(/^for \(;;\);/, "");
  let json;
  try {
    json = JSON.parse(first);
  } catch (e) {
    throw new Error("Could not parse sequence id response (session invalid?)");
  }
  const seq =
    json && json.o0 && json.o0.data && json.o0.data.viewer && json.o0.data.viewer.message_threads &&
    json.o0.data.viewer.message_threads.sync_sequence_id;
  if (!seq) throw new Error("Could not read sync_sequence_id (doc_id outdated or session invalid)");
  return seq;
}

const tid = (key) => String((key && (key.threadFbId || key.otherUserFbId)) || "");
const isGroupKey = (key) => !!(key && key.threadFbId);

// Returns an array of normalized events for one delta
function parseDelta(delta, api) {
  const out = [];
  const cls = delta.class;
  const md = delta.messageMetadata;

  if (cls === "NewMessage" && md) {
    const threadID = tid(md.threadKey);
    const isGroup = isGroupKey(md.threadKey);
    out.push({
      type: "message",
      threadID,
      senderID: String(md.actorFbId),
      messageID: md.messageId,
      body: delta.body || "",
      timestamp: md.timestamp,
      isGroup,
      attachments: delta.attachments || [],
      replyToMessageID: delta.messageReply && delta.messageReply.replyToMessageId
        ? delta.messageReply.replyToMessageId.id
        : null,
      reply: (text) => api.sendMessage(text, threadID, { isGroup }),
    });
  } else if (cls === "ParticipantsAddedToGroupThread" && md) {
    out.push({
      type: "event",
      logMessageType: "log:subscribe",
      threadID: tid(md.threadKey),
      authorID: String(md.actorFbId),
      addedParticipants: (delta.addedParticipants || []).map((p) => String(p.userFbId)),
      isGroup: true,
    });
  } else if (cls === "ParticipantLeftGroupThread" && md) {
    out.push({
      type: "event",
      logMessageType: "log:unsubscribe",
      threadID: tid(md.threadKey),
      authorID: String(md.actorFbId),
      leftParticipantFbId: String(delta.leftParticipantFbId),
      isGroup: true,
    });
  } else if (cls === "ThreadName" && md) {
    out.push({
      type: "event",
      logMessageType: "log:thread-name",
      threadID: tid(md.threadKey),
      authorID: String(md.actorFbId),
      name: delta.name,
      isGroup: true,
    });
  } else if (cls === "ReadReceipt") {
    out.push({
      type: "read_receipt",
      threadID: tid(delta.threadKey),
      readerID: String(delta.actorFbId),
      time: delta.actionTimestampMs,
    });
  } else if (cls === "ClientPayload" && Array.isArray(delta.payload)) {
    // Reactions and unsends arrive as a byte-array JSON payload
    let inner;
    try {
      inner = JSON.parse(Buffer.from(delta.payload).toString("utf8"));
    } catch (e) {
      return out;
    }
    for (const d of inner.deltas || []) {
      if (d.deltaMessageReaction) {
        const r = d.deltaMessageReaction;
        out.push({
          type: "message_reaction",
          threadID: tid(r.threadKey),
          messageID: r.messageId,
          senderID: String(r.senderId), // author of the reacted message
          userID: String(r.userId), // person who reacted
          reaction: r.reaction,
          action: r.action === 1 ? "remove" : "add",
        });
      }
      if (d.deltaRecallMessageData) {
        const r = d.deltaRecallMessageData;
        out.push({
          type: "message_unsend",
          threadID: tid(r.threadKey),
          messageID: r.messageID,
          senderID: String(r.senderID),
          deletionTimestamp: r.deletionTimestamp,
        });
      }
    }
  }
  return out;
}

function createListener(ctx, api, callback) {
  let client = null;
  let stopped = false;
  let retry = 0;
  let timer = null;

  const emit = (event) => {
    const o = ctx.options;
    if (event.type === "message") {
      if (!o.selfListen && event.senderID === ctx.userID) return;
    } else if (event.type !== "system" && !o.listenEvents) {
      return;
    }
    callback(null, event);
  };

  function scheduleReconnect() {
    if (stopped || !ctx.options.autoReconnect || timer) return;

    if (client) {
      client.removeAllListeners();
      client.on("error", () => {});
      client.end(true);
      client = null;
    }

    retry += 1;
    if (retry > ctx.options.maxRetries) {
      callback(new Error("Giving up after too many reconnect attempts"));
      return;
    }

    const delay = Math.min(30000, 1000 * 2 ** retry);
    emit({ type: "system", state: "reconnecting", attempt: retry, delayMs: delay });
    timer = setTimeout(async () => {
      timer = null;
      try {
        await ctx.refreshTokens();
      } catch (e) {
        /* ignore; connect() will report */
      }
      connect();
    }, delay);
  }

  async function connect() {
    if (stopped) return;
    try {
      if (!ctx.lastSeqId) ctx.lastSeqId = await fetchSeqID(ctx);

      const sessionID = Math.floor(Math.random() * 9007199254740991) + 1;
      const username = {
        u: ctx.userID, s: sessionID, chat_on: true, fg: false, d: ctx.clientID, ct: "websocket",
        aid: "219994525426954", aids: null, mqtt_sid: "", cp: 3, ecp: 10, st: [], pm: [], dc: "",
        no_auto_fg: true, gas: null, pack: [], p: null, php_override: "",
      };
      const url = `wss://edge-chat.facebook.com/chat?region=${ctx.region}&sid=${sessionID}&cid=${ctx.clientID}`;

      client = mqtt.connect(url, {
        clientId: "mqttwsclient",
        protocolId: "MQIsdp",
        protocolVersion: 3,
        username: JSON.stringify(username),
        clean: true,
        keepalive: 10,
        reschedulePings: false,
        reconnectPeriod: 0, // we handle reconnects ourselves
        wsOptions: {
          headers: {
            Cookie: ctx.http.cookieHeader(),
            Origin: "https://www.facebook.com",
            "User-Agent": ctx.http.userAgent,
            Referer: "https://www.facebook.com/",
            Host: "edge-chat.facebook.com",
          },
          origin: "https://www.facebook.com",
          protocolVersion: 13,
        },
      });

      client.on("connect", () => {
        retry = 0;
        TOPICS.forEach((t) => client.subscribe(t));

        const queue = {
          sync_api_version: 10,
          max_deltas_able_to_process: 1000,
          delta_batch_size: 500,
          encoding: "JSON",
          entity_fbid: ctx.userID,
        };
        let topic;
        if (ctx.syncToken) {
          topic = "/messenger_sync_get_diffs";
          queue.last_seq_id = ctx.lastSeqId;
          queue.sync_token = ctx.syncToken;
        } else {
          topic = "/messenger_sync_create_queue";
          queue.initial_titles_cursor = null;
          queue.device_params = null;
          queue.last_seq_id = ctx.lastSeqId;
        }
        client.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
        emit({ type: "system", state: "connected" });
      });

      client.on("message", (topic, payload) => {
        let msg;
        try {
          msg = JSON.parse(payload.toString());
        } catch (e) {
          return;
        }

        if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
          if (msg.type === "typ") {
            emit({
              type: "typ",
              isTyping: !!msg.state,
              from: String(msg.sender_fbid),
              threadID: String(msg.thread || msg.sender_fbid),
            });
          }
          return;
        }

        if (topic !== "/t_ms") return;

        if (msg.firstDeltaSeqId && msg.syncToken) {
          ctx.lastSeqId = msg.firstDeltaSeqId;
          ctx.syncToken = msg.syncToken;
        }
        if (msg.lastIssuedSeqId) ctx.lastSeqId = msg.lastIssuedSeqId;

        for (const delta of msg.deltas || []) {
          for (const event of parseDelta(delta, api)) emit(event);
        }
      });

      client.on("error", (err) => callback(err));
      client.on("close", scheduleReconnect);
    } catch (err) {
      callback(err);
      scheduleReconnect();
    }
  }

  connect();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    if (client) client.end(true);
  };
}

module.exports = { createListener };
