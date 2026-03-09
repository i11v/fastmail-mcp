# Mailbox

Mailboxes are folders that contain emails. Every email belongs to at least one mailbox.

## Mailbox/get

Fetch all mailboxes. No `properties` array required (mailbox objects are small).

```json
["Mailbox/get", {}, "m"]
```

### Response

```json
["Mailbox/get", {
  "list": [
    { "id": "mb1", "name": "Inbox", "role": "inbox", "totalEmails": 1523, "unreadEmails": 3, "parentId": null },
    { "id": "mb2", "name": "Drafts", "role": "drafts", "totalEmails": 2, "unreadEmails": 0, "parentId": null },
    { "id": "mb3", "name": "Sent", "role": "sent", "totalEmails": 845, "unreadEmails": 0, "parentId": null },
    { "id": "mb4", "name": "Trash", "role": "trash", "totalEmails": 12, "unreadEmails": 0, "parentId": null },
    { "id": "mb5", "name": "Archive", "role": "archive", "totalEmails": 5000, "unreadEmails": 0, "parentId": null },
    { "id": "mb6", "name": "Spam", "role": "junk", "totalEmails": 45, "unreadEmails": 45, "parentId": null },
    { "id": "mb7", "name": "Projects", "role": null, "totalEmails": 200, "unreadEmails": 5, "parentId": null },
    { "id": "mb8", "name": "Active", "role": null, "totalEmails": 50, "unreadEmails": 2, "parentId": "mb7" }
  ]
}, "m"]
```

### Mailbox Properties

| Property | Type | Description |
|----------|------|-------------|
| `id` | string | Mailbox ID (use this in `Email/query` filters and `Email/set` moves) |
| `name` | string | Display name |
| `role` | string\|null | Well-known role (see below) or `null` for user-created |
| `parentId` | string\|null | Parent mailbox ID for nested folders, `null` for top-level |
| `totalEmails` | number | Total emails in this mailbox |
| `unreadEmails` | number | Unread emails in this mailbox |
| `totalThreads` | number | Total threads |
| `unreadThreads` | number | Unread threads |
| `sortOrder` | number | Display order |

## Well-Known Roles

| Role | Meaning |
|------|---------|
| `inbox` | Inbox |
| `drafts` | Drafts |
| `sent` | Sent mail |
| `trash` | Trash / Deleted |
| `junk` | Spam |
| `archive` | Archive |

Match on `role` to find system mailboxes regardless of what the user named them.

## Mailbox/query

Find mailboxes by filter. Useful to find a specific mailbox by role:

```json
["Mailbox/query", {
  "filter": { "role": "inbox" },
  "limit": 1
}, "q"]
```

Filter properties: `name`, `role`, `parentId`, `hasAnyRole` (boolean).

## Mailbox/set

Create, rename, or delete mailboxes.

### Create

```json
["Mailbox/set", {
  "create": {
    "new1": {
      "name": "Projects",
      "parentId": null
    }
  }
}, "c"]
```

### Rename

```json
["Mailbox/set", {
  "update": {
    "mb7": { "name": "Work Projects" }
  }
}, "u"]
```

### Delete

**Destructive** — server will require user confirmation:

```json
["Mailbox/set", {
  "destroy": ["mb7"],
  "onDestroyRemoveEmails": true
}, "d"]
```

Set `onDestroyRemoveEmails` to `true` to delete contained emails, or `false` to fail if the mailbox isn't empty.
