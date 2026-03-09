# Email/query

Search and filter emails. Returns an array of email IDs. Chain with `Email/get` to fetch details.

## Basic Usage

```json
["Email/query", {
  "filter": { "inMailbox": "MAILBOX_ID" },
  "sort": [{ "property": "receivedAt", "isAscending": false }],
  "limit": 20
}, "q"]
```

## Filter Properties

Filters can be combined. All conditions must match (AND logic).

| Property | Type | Description |
|----------|------|-------------|
| `inMailbox` | string | Emails in this mailbox ID |
| `inMailboxOtherThan` | string[] | Emails NOT in these mailbox IDs |
| `from` | string | From header contains this text |
| `to` | string | To header contains this text |
| `cc` | string | Cc header contains this text |
| `bcc` | string | Bcc header contains this text |
| `subject` | string | Subject contains this text |
| `body` | string | Body contains this text |
| `text` | string | Matches any header or body text |
| `hasKeyword` | string | Has this keyword/flag (e.g., `"$seen"`, `"$flagged"`) |
| `notKeyword` | string | Does NOT have this keyword |
| `before` | string | Received before this UTC date (`"2025-01-15T00:00:00Z"`) |
| `after` | string | Received after this UTC date |
| `minSize` | number | Minimum size in bytes |
| `maxSize` | number | Maximum size in bytes |
| `hasAttachment` | boolean | Has file attachments |
| `header` | string[] | Raw header filter: `["X-Header-Name", "value"]` |

### Compound Filters

Use `operator` with `conditions` array for OR / NOT logic:

```json
{
  "filter": {
    "operator": "OR",
    "conditions": [
      { "from": "alice@example.com" },
      { "from": "bob@example.com" }
    ]
  }
}
```

Operators: `"AND"`, `"OR"`, `"NOT"`.

## Sort Properties

Array of sort objects. First sort takes priority.

| Property | Description |
|----------|-------------|
| `receivedAt` | Date received by server (most common) |
| `sentAt` | Date in the Date header |
| `size` | Email size in bytes |
| `from` | Sender name/address |
| `to` | Recipient name/address |
| `subject` | Subject line |

Each sort object: `{ "property": "receivedAt", "isAscending": false }`.

## Pagination

| Argument | Type | Description |
|----------|------|-------------|
| `limit` | number | **Required.** Max results to return |
| `position` | number | 0-based offset into the result set |
| `anchor` | string | Email ID to position relative to |
| `anchorOffset` | number | Offset from the anchor |

### Example: Page 2

```json
["Email/query", {
  "filter": { "inMailbox": "INBOX_ID" },
  "sort": [{ "property": "receivedAt", "isAscending": false }],
  "position": 20,
  "limit": 20
}, "q"]
```

## Response

```json
["Email/query", {
  "ids": ["msg1", "msg2", "msg3"],
  "total": 156
}, "q"]
```

- `ids`: Array of email IDs matching the query
- `total`: Total number of emails matching (across all pages)
