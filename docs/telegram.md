# Telegram inbound

Send a message to your own bot and it lands in the local database. Text,
photos, voice notes and documents. Nothing interprets them yet — that is the
next step; this one is the reliable pipe underneath it.

```text
 iPhone ──► Telegram ──► telegram-server (long poll)
                              │  validate chat → store row → COMMIT
                              │  then download media to disk
                              ▼
                         data.sqlite: telegram_updates
                         <db dir>/telegram-media/YYYY/MM/DD/<sha256>.jpg
```

## Why long polling and not a webhook

A webhook needs a public HTTPS endpoint. Long polling makes only outbound
calls, so this process opens no port and needs no certificate, no tunnel and
no firewall change. On a machine holding years of personal health data, that
is the whole point.

**Only one process may consume `getUpdates` per bot.** Sending has no such
limit, so a separate briefing sender using the same bot needs no change.

## Setup

1. Create a bot with [@BotFather](https://t.me/botfather), or reuse an
   existing token.
2. Put `TELEGRAM_BOT_TOKEN` and `TELEGRAM_ALLOWED_CHAT_ID` in `.env` — see
   `.env.example`. To find your chat id, message the bot and read
   `logs/telegram.log`, which reports rejected chat ids.
3. `npm run telegram-server`
4. Message the bot. It replies "Got it — saved."

For an always-on setup, copy the launchd template in `docs/launchd.md` and
change the label and script name. **Do run it under launchd:** Telegram
discards undelivered updates after roughly 24 hours, so a server that is down
after a reboot loses messages while you believe they were recorded.

## What gets stored

One row per accepted update in `telegram_updates`, with the whole update
verbatim in `raw`, plus media on disk under the media root (`0700`
directory, `0600` files), named by content hash.

```sql
SELECT datetime(sent_epoch, 'unixepoch') AS sent, kind, text, media_path
  FROM telegram_updates
 WHERE superseded_by IS NULL
 ORDER BY sent_epoch DESC LIMIT 10;
```

`superseded_by IS NULL` matters: editing a message in Telegram creates a
_new_ update carrying the same `message_id`, so both versions are kept and
the older one points at the newer. Ignore that and a corrected meal counts
twice.

## Things worth knowing

- **Messages from any other chat are discarded unread.** A bot username is
  discoverable, so anyone can message it. Nothing about a third party is
  stored, and the bot never replies to them. Rejected ids still advance the
  poll cursor — otherwise one stranger's message would pin the queue forever.
- **Whoever holds the bot token can read your messages**, not just send them:
  `getUpdates` is available to any holder. Treat a leak as a data incident.
- **A photo sent at full size arrives as a `document`**, not a `photo`. Both
  are stored.
- **Albums have no completion signal.** Each part is a separate update sharing
  a `media_group_id`; a consumer must debounce after the last part.
- **Telegram sends no timezone.** Rows carry `tz_assumed` — what the server
  assumed, named so nothing mistakes it for something the sender asserted.
- **Download links expire after about an hour** and bots may download at most
  20 MB, so media is fetched immediately after the row commits, with retries
  and then a terminal `dead` state rather than an endless loop.
