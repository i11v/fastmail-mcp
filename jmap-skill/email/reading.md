# Email/get

Fetch email details by ID. Always specify a `properties` array to avoid fetching unnecessary data.

## Basic Usage

```json
["Email/get", {
  "ids": ["msg1", "msg2"],
  "properties": ["from", "subject", "receivedAt", "preview"]
}, "g"]
```

## Available Properties

### Metadata
| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Email ID |
| `threadId` | string | Thread/conversation ID |
| `mailboxIds` | object | Map of mailbox ID → `true` for each mailbox containing this email |
| `keywords` | object | Map of keyword → `true` (flags like `$seen`, `$flagged`, `$draft`, `$answered`) |
| `size` | number | Size in bytes |
| `receivedAt` | string | UTC timestamp when received |

### Headers
| Property | Type | Description |
|----------|------|-------------|
| `from` | object[] | Sender(s): `[{ "name": "Alice", "email": "alice@example.com" }]` |
| `to` | object[] | Recipients |
| `cc` | object[] | CC recipients |
| `bcc` | object[] | BCC recipients |
| `replyTo` | object[] | Reply-To addresses |
| `sender` | object[] | Sender (if different from From) |
| `subject` | string | Subject line |
| `sentAt` | string | Date header value |
| `messageId` | string[] | Message-ID header |
| `inReplyTo` | string[] | In-Reply-To header (for threading) |
| `references` | string[] | References header (for threading) |

### Body
| Property | Type | Description |
|----------|------|-------------|
| `preview` | string | Short plaintext preview (~256 chars) |
| `bodyValues` | object | Map of part ID → body content (must request with `fetchAllBodyValues`) |
| `textBody` | object[] | Plain text body parts |
| `htmlBody` | object[] | HTML body parts |
| `bodyStructure` | object | Full MIME structure |
| `hasAttachment` | boolean | Whether the email has attachments |
| `attachments` | object[] | List of attachment parts |

### Fetching Body Content

To get full body text, request `bodyValues` and set `fetchAllBodyValues`:

```json
["Email/get", {
  "ids": ["msg1"],
  "properties": ["from", "to", "subject", "bodyValues", "textBody", "htmlBody"],
  "fetchAllBodyValues": true
}, "g"]
```

The response includes body content keyed by part ID:

```json
{
  "list": [{
    "id": "msg1",
    "bodyValues": {
      "1": { "value": "Hello, this is the email body...", "isEncodingProblem": false }
    },
    "textBody": [{ "partId": "1", "type": "text/plain" }]
  }]
}
```

Match `textBody[].partId` or `htmlBody[].partId` to `bodyValues` keys to get content.

## Using with Back-References

The most common pattern — query then get:

```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": { "inMailbox": "INBOX_ID" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 10
    }, "q"],
    ["Email/get", {
      "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["from", "to", "subject", "receivedAt", "preview"]
    }, "g"]
  ]
}
```

## Response

```json
["Email/get", {
  "list": [
    {
      "id": "msg1",
      "from": [{ "name": "Alice", "email": "alice@example.com" }],
      "subject": "Hello",
      "receivedAt": "2025-03-15T10:30:00Z",
      "preview": "Hi, just wanted to check in..."
    }
  ],
  "notFound": []
}, "g"]
```

- `list`: Array of email objects with requested properties
- `notFound`: IDs that didn't match any email
