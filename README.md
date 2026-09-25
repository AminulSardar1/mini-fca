# mini-fca

Minimal unofficial Facebook Messenger chat API for Node.js. Reverse-engineered
from Facebook's web client (ajax endpoints + MQTT over WebSocket) — this is
**not** Meta's official API, and it *will* break when Facebook changes internal
endpoints, GraphQL `doc_id` values, or page markup. Untested against a live
account; treat as a starting skeleton, not a finished product.

## Install

```bash
npm install
```

Requires Node 18+ (uses global `fetch`, `FormData`, `Blob`).

## Setup

1. Log into Facebook in a browser with the account you'll automate — **use a
   throwaway/test account**, not your main one.
2. Export cookies as AppState JSON, e.g. with the `c3c-fbstate` browser
   extension. Save it as `appstate.json` next to `example.js`.
3. `node example.js`

## API

```js
const login = require("./index");

login({ appState, options: { /* see below */ } }, (err, api) => {
  // or: const api = await login({ appState });
});
```

### Options

| key | default | meaning |
|---|---|---|
| `selfListen` | `false` | also emit events for messages you send |
| `listenEvents` | `true` | emit group/thread events, not just messages |
| `sendDelayMs` | `1200` | minimum gap between outgoing sends (throttling) |
| `autoReconnect` | `true` | reconnect MQTT with backoff on drop |
| `maxRetries` | `20` | give up after this many reconnect attempts |

### Methods

- `api.sendMessage(body | {body, attachment, sticker, mentions, replyTo}, threadID, {isGroup})`
- `api.unsendMessage(messageID)`
- `api.setMessageReaction(emoji, messageID)` — pass `""` to remove
- `api.markAsRead(threadID, read=true)`
- `api.sendTypingIndicator(threadID, isTyping, isGroup)`
- `api.uploadAttachment(path | Buffer | {buffer, filename, contentType} | stream)`
- `api.getUserInfo(userID)`
- `api.getFriendsList()`
- `api.getThreadInfo(threadID)`
- `api.getThreadList(limit, offset)`
- `api.getThreadHistory(threadID, amount, beforeTimestamp, isGroup)`
- `api.changeNickname(nickname, threadID, participantID)`
- `api.setTitle(newTitle, threadID)`
- `api.addUserToGroup(userIDs, threadID)`
- `api.removeUserFromGroup(userID, threadID)`
- `api.createGroup(userIDs, title?)` — needs ≥2 other participants, returns new `threadID`
- `api.changeAdminStatus(threadID, userID, makeAdmin=true)`
- `api.changeThreadColor(threadID, hexColor)`
- `api.changeThreadEmoji(threadID, emoji)`
- `api.muteThread(threadID, muteSeconds)` — `-1` mute indefinitely, `0` unmute
- `api.pinMessage(threadID, messageID, pinned=true)`
- `api.createPoll(threadID, question, options[], multiSelect=false)` → returns `pollID`
- `api.voteInPoll(pollID, optionIDs[])`
- `api.blockUser(userID)` / `api.unblockUser(userID)`
- `api.searchThreads(query, limit)` — find people/groups/pages by name
- `api.searchMessages(threadID, query, limit)` — search within one thread's history
- `api.uploadLargeAttachment(file, {chunkSizeBytes})` — chunked upload for large video/files, falls back to `uploadAttachment` under the chunk size
- `api.listen(callback)` / `api.listenMqtt(callback)` — returns a `stop()` function
- `api.getAppState()` — export refreshed cookies to persist between runs
- `api.setOptions(partial)`, `api.refreshTokens()`

### Listen events

`callback(err, event)` where `event.type` is one of:

- `"message"` — `{threadID, senderID, messageID, body, isGroup, attachments, reply()}`
- `"event"` — `logMessageType` of `log:subscribe` / `log:unsubscribe` / `log:thread-name`
- `"message_reaction"` — `{threadID, messageID, userID, reaction, action}`
- `"message_unsend"` — `{threadID, messageID, senderID}`
- `"read_receipt"` — `{threadID, readerID, time}`
- `"typ"` — typing indicator
- `"system"` — connection state (`connected`, `reconnecting`)

## Known weak points

- `src/listen.js` `fetchSeqID()` calls a GraphQL `doc_id` that Facebook rotates
  periodically. If `listen()` fails immediately, this is the first suspect —
  capture the endpoint again from browser devtools and swap the id.
- `pinMessage()` and `setMessageReaction()` also call `webgraphql/mutation/`
  with hardcoded `doc_id`s — same rotation risk as above.
- Legacy `ajax/mercury/*` endpoints (`thread_info.php`, `threadlist_info.php`,
  `search_snippets.php`) may return partial data or be deprecated outright.
- `searchMessages()`'s response shape is the least certain endpoint in this
  library — Facebook has changed its message-search backend multiple times;
  treat the return value as "probably an array of snippet objects" and log
  the raw response the first time you call it.
- `uploadLargeAttachment()`'s resumable-upload endpoints
  (`upload_resumable_start/chunk/finish.php`) are named by analogy with how
  Facebook's own resumable upload flow works elsewhere; they have not been
  confirmed against Messenger's current upload pipeline. For anything under
  ~25MB, prefer plain `uploadAttachment()`.
- `createGroup()` requires at least 2 other participants (Facebook's own
  restriction) — passing 1 will silently produce a 1-to-1 thread, not a
  group, and the returned `threadID` won't behave like a group thread.
- No captcha/checkpoint handling — if Facebook interrupts login with a
  checkpoint, `refreshTokens()` will throw and you resolve it manually in a
  browser, then re-export AppState.
- Not implemented at all: voice/video calls (needs a full WebRTC signaling +
  media stack, out of scope for an HTTP/MQTT client), Stories, vanish mode.

## Risk notes

- Automating a personal account this way violates Facebook's Terms of
  Service; the account can be checkpointed or banned regardless of how
  careful the code is.
- `appstate.json` is equivalent to your login session — never commit it or
  share it.
- For anything long-running or Page-based, Meta's official Messenger
  Platform API is the stable, ToS-compliant alternative.
