# Pattern: Move and Archive Emails

## Archive an Email

Move from current mailbox to archive:

```json
{
  "methodCalls": [
    ["Mailbox/query", {
      "filter": { "role": "archive" },
      "limit": 1
    }, "mb"],
    ["Email/set", {
      "update": {
        "msg1": {
          "mailboxIds": { "ARCHIVE_MAILBOX_ID": true }
        }
      }
    }, "u"]
  ]
}
```

Like the unread inbox pattern, you need the archive mailbox ID first. Get it from `Mailbox/get` or `Mailbox/query`.

### Practical Approach

```json
{
  "methodCalls": [
    ["Mailbox/get", {}, "m"]
  ]
}
```

Find the mailbox with `"role": "archive"`, then:

```json
{
  "methodCalls": [
    ["Email/set", {
      "update": {
        "msg1": { "mailboxIds": { "ARCHIVE_ID": true } }
      }
    }, "u"]
  ]
}
```

## Move to Trash

```json
["Email/set", {
  "update": {
    "msg1": { "mailboxIds": { "TRASH_ID": true } }
  }
}, "u"]
```

## Move to a Specific Folder

```json
["Email/set", {
  "update": {
    "msg1": { "mailboxIds": { "TARGET_MAILBOX_ID": true } }
  }
}, "u"]
```

## Bulk Move

Move multiple emails at once:

```json
["Email/set", {
  "update": {
    "msg1": { "mailboxIds": { "ARCHIVE_ID": true } },
    "msg2": { "mailboxIds": { "ARCHIVE_ID": true } },
    "msg3": { "mailboxIds": { "ARCHIVE_ID": true } }
  }
}, "u"]
```

## Mark as Spam

Move to the junk mailbox:

```json
["Email/set", {
  "update": {
    "msg1": { "mailboxIds": { "JUNK_ID": true } }
  }
}, "u"]
```

Find the junk mailbox using `"role": "junk"` from `Mailbox/get`.
