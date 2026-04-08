---
name: fastmail
description: Use when interacting with the user's Fastmail email via the `execute`, `compose_email`, and `read_email` MCP tools. Covers JMAP method calls for querying, reading, sending, and managing emails and mailboxes, plus interactive UI widgets for composing and reading emails.
---

# JMAP Mail Skill

You manage a user's Fastmail email through the `execute` MCP tool. This tool accepts raw JMAP method calls and sends them to Fastmail. You write the JMAP; the server handles authentication, validation, and response cleaning.

## How `execute` Works

You pass an array of method call triples: `[methodName, args, callId]`.

```json
{
  "methodCalls": [
    ["Email/query", { "filter": { "inMailbox": "..." }, "limit": 10 }, "q"],
    ["Email/get", {
      "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["from", "subject", "receivedAt", "preview"]
    }, "g"]
  ]
}
```

The server injects `accountId` automatically — never include it yourself.

## Rules

1. **Every `/get` call must include a `properties` array** (except `Mailbox/get`, `Identity/get`, and `SearchSnippet/get`). The server rejects calls without it.
2. **Every `/query` call must include a `limit`** (number). Max recommended: 50.
3. **Never pass `ids: null`** to a `/get` call — it fetches everything. Use `/query` first.
4. **Use `resultOf` back-references** to chain calls instead of making separate requests.
5. **callId values must be unique strings** within a request (e.g., `"0"`, `"1"` or `"query"`, `"get"`).

## Allowed Methods

| Method | Purpose | Details |
|--------|---------|---------|
| `Mailbox/get` | List mailboxes | [mailbox/overview](mailbox/overview.md) |
| `Mailbox/query` | Find mailboxes by filter | [mailbox/overview](mailbox/overview.md) |
| `Mailbox/set` | Create/update/delete mailboxes | [mailbox/overview](mailbox/overview.md) |
| `Email/query` | Search/filter emails | [email/querying](email/querying.md) |
| `Email/get` | Fetch email details | [email/reading](email/reading.md) |
| `Email/set` | Create drafts, update flags, move, delete | [email/writing](email/writing.md) |
| `Thread/get` | Get conversation threads | [thread/overview](thread/overview.md) |
| `SearchSnippet/get` | Full-text search highlights | [email/search](email/search.md) |
| `Identity/get` | Get sender identities | [sending/workflow](sending/workflow.md) |
| `EmailSubmission/set` | Send an email | [sending/workflow](sending/workflow.md) |

Less common: `Mailbox/queryChanges`, `Email/queryChanges`, `EmailSubmission/get`, `EmailSubmission/query`, `Core/echo`.

## UI Tools (MCP Apps)

These tools render interactive widgets on hosts that support MCP Apps. The compose UI uses `execute` under the hood for drafts and sending.

### `compose_email`

Opens an interactive email compose form. Pre-fill any combination of fields; the user can edit before sending or saving as draft.

```json
{
  "to": "recipient@example.com",
  "cc": "other@example.com",
  "bcc": "secret@example.com",
  "subject": "Hello",
  "body": "Message text..."
}
```

All fields are optional. On hosts without MCP Apps, falls back to structured text.

### `read_email`

Displays an email in a rich reader widget with full HTML rendering, headers, and action buttons (reply, reply all, forward). The widget is shown to the user; the assistant receives only a brief metadata summary.

```json
{
  "emailId": "M1234abcd"
}
```

Use this instead of `Email/get` via `execute` when the goal is to **show** the email to the user rather than extract data for the assistant.

## Quick Reference

**Show unread inbox** → [patterns/unread-inbox](patterns/unread-inbox.md)
**Move/archive emails** → [patterns/move-archive](patterns/move-archive.md)
**Reply to an email** → [patterns/reply](patterns/reply.md)
**Request format & batching** → [core/request-format](core/request-format.md)
**Error handling** → [core/error-handling](core/error-handling.md)
