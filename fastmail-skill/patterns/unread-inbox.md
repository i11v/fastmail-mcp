# Pattern: Show Unread Inbox

The most common request. Finds the inbox, queries unread emails, and fetches their details.

## Full Request

```json
{
  "methodCalls": [
    ["Mailbox/query", {
      "filter": { "role": "inbox" },
      "limit": 1
    }, "mb"],
    ["Email/query", {
      "#filter": {
        "resultOf": "mb",
        "name": "Mailbox/query",
        "path": "/ids"
      },
      "filter": { "hasKeyword": "$seen", "inMailbox": "NEED_INBOX_ID" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 20
    }, "q"],
    ["Email/get", {
      "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["from", "subject", "receivedAt", "preview", "keywords"]
    }, "g"]
  ]
}
```

**Note**: You can't use a `resultOf` reference for a single value inside a filter object. So in practice, do it in two steps:

## Practical Two-Step Approach

### Step 1: Get the inbox mailbox ID

```json
{
  "methodCalls": [
    ["Mailbox/get", {}, "m"]
  ]
}
```

Find the mailbox with `"role": "inbox"` in the response and note its `id`.

### Step 2: Query and fetch unread emails

```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": {
        "inMailbox": "INBOX_ID_FROM_STEP_1",
        "notKeyword": "$seen"
      },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 20
    }, "q"],
    ["Email/get", {
      "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["from", "subject", "receivedAt", "preview"]
    }, "g"]
  ]
}
```

## Variations

**All inbox (read + unread):** Remove the `notKeyword` filter.

**Flagged emails:** Use `"hasKeyword": "$flagged"` instead.

**Unread count only:** Just use `Mailbox/get` — the `unreadEmails` property has the count.
