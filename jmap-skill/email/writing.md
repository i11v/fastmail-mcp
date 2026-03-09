# Email/set

Create, update, and destroy emails. Used for drafting, moving, flagging, and deleting.

## Creating a Draft

```json
["Email/set", {
  "create": {
    "draft1": {
      "mailboxIds": { "DRAFTS_MAILBOX_ID": true },
      "keywords": { "$draft": true, "$seen": true },
      "from": [{ "name": "Your Name", "email": "you@example.com" }],
      "to": [{ "name": "Recipient", "email": "recipient@example.com" }],
      "subject": "Hello",
      "bodyStructure": {
        "type": "text/plain",
        "partId": "body"
      },
      "bodyValues": {
        "body": { "value": "This is the email body." }
      }
    }
  }
}, "c"]
```

For HTML emails, use `"type": "text/html"` in bodyStructure.

For multipart (plain + HTML):

```json
{
  "bodyStructure": {
    "type": "multipart/alternative",
    "subParts": [
      { "type": "text/plain", "partId": "text" },
      { "type": "text/html", "partId": "html" }
    ]
  },
  "bodyValues": {
    "text": { "value": "Plain text version" },
    "html": { "value": "<p>HTML version</p>" }
  }
}
```

### Create Response

```json
["Email/set", {
  "created": {
    "draft1": { "id": "Mdeadbeef123" }
  }
}, "c"]
```

The server-assigned ID is in `created.<clientId>.id`. Use `#` reference to pass it to `EmailSubmission/set` in the same request.

## Updating Emails

### Move to Another Mailbox

Set the target mailbox to `true` and the source to `false`:

```json
["Email/set", {
  "update": {
    "msg1": {
      "mailboxIds": { "ARCHIVE_MAILBOX_ID": true }
    }
  }
}, "u"]
```

Using `mailboxIds` as a full replacement moves the email out of all current mailboxes into only the specified ones.

To add/remove specific mailboxes without affecting others, use patch syntax:

```json
["Email/set", {
  "update": {
    "msg1": {
      "mailboxIds/ARCHIVE_MAILBOX_ID": true,
      "mailboxIds/INBOX_ID": null
    }
  }
}, "u"]
```

### Set Keywords (Flags)

Common keywords:
- `$seen` — Read
- `$flagged` — Starred/flagged
- `$answered` — Replied to
- `$draft` — Draft message

Mark as read:
```json
["Email/set", {
  "update": {
    "msg1": { "keywords/$seen": true }
  }
}, "u"]
```

Mark as unread:
```json
["Email/set", {
  "update": {
    "msg1": { "keywords/$seen": null }
  }
}, "u"]
```

Toggle flagged:
```json
["Email/set", {
  "update": {
    "msg1": { "keywords/$flagged": true }
  }
}, "u"]
```

### Bulk Update

Update multiple emails in one call:

```json
["Email/set", {
  "update": {
    "msg1": { "keywords/$seen": true },
    "msg2": { "keywords/$seen": true },
    "msg3": { "mailboxIds": { "TRASH_ID": true } }
  }
}, "u"]
```

### Update Response

```json
["Email/set", {
  "updated": { "msg1": null, "msg2": null },
  "notUpdated": {}
}, "u"]
```

## Destroying (Deleting) Emails

**This is a destructive operation.** The server will block the request and ask you to confirm with the user first.

```json
["Email/set", {
  "destroy": ["msg1", "msg2"]
}, "d"]
```

Typically, move to Trash instead of destroying:

```json
["Email/set", {
  "update": {
    "msg1": { "mailboxIds": { "TRASH_MAILBOX_ID": true } }
  }
}, "u"]
```

## Finding Mailbox IDs

You usually need mailbox IDs for moves. Get them first:

```json
{
  "methodCalls": [
    ["Mailbox/get", {}, "m"],
    ["Email/set", {
      "update": { "msg1": { "mailboxIds": { "USE_ARCHIVE_ID_FROM_ABOVE": true } } }
    }, "u"]
  ]
}
```

Or use `Mailbox/query` with a role filter — see [mailbox/overview](../mailbox/overview.md).
