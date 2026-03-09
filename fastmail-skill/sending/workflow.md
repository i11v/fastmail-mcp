# Sending Email

Sending requires three steps in a single request: get identity, create draft, submit.

## Step 1: Get Your Identity

```json
["Identity/get", {}, "i"]
```

Response includes your sending identities:

```json
["Identity/get", {
  "list": [
    { "id": "id1", "name": "Your Name", "email": "you@fastmail.com" },
    { "id": "id2", "name": "Your Name", "email": "you@customdomain.com" }
  ]
}, "i"]
```

Pick the identity matching the `from` address you want to use. If unsure, use the first one or ask the user.

## Step 2: Create Draft + Submit (Single Request)

```json
{
  "methodCalls": [
    ["Identity/get", {}, "i"],
    ["Email/set", {
      "create": {
        "draft": {
          "mailboxIds": { "DRAFTS_MAILBOX_ID": true },
          "keywords": { "$draft": true, "$seen": true },
          "from": [{ "name": "Your Name", "email": "you@fastmail.com" }],
          "to": [{ "name": "Recipient", "email": "recipient@example.com" }],
          "subject": "Meeting tomorrow",
          "bodyStructure": {
            "type": "text/plain",
            "partId": "body"
          },
          "bodyValues": {
            "body": { "value": "Hi, are we still on for tomorrow's meeting?" }
          }
        }
      }
    }, "c"],
    ["EmailSubmission/set", {
      "create": {
        "sub": {
          "#emailId": {
            "resultOf": "c",
            "name": "Email/set",
            "path": "/created/draft/id"
          },
          "identityId": "IDENTITY_ID"
        }
      }
    }, "s"]
  ]
}
```

**Important**: `EmailSubmission/set` is a destructive operation. The server will block it and ask you to confirm with the user before sending. After confirmation, retry the same request.

## With CC, BCC, Reply-To

```json
{
  "from": [{ "name": "You", "email": "you@fastmail.com" }],
  "to": [{ "name": "Alice", "email": "alice@example.com" }],
  "cc": [{ "name": "Bob", "email": "bob@example.com" }],
  "bcc": [{ "name": "Carol", "email": "carol@example.com" }],
  "replyTo": [{ "name": "You", "email": "replies@example.com" }],
  "subject": "Team update"
}
```

## Replying to an Email

When replying, include threading headers and the reply subject:

```json
{
  "mailboxIds": { "DRAFTS_MAILBOX_ID": true },
  "keywords": { "$draft": true, "$seen": true },
  "from": [{ "name": "You", "email": "you@fastmail.com" }],
  "to": [{ "name": "Original Sender", "email": "sender@example.com" }],
  "subject": "Re: Original Subject",
  "inReplyTo": ["<original-message-id@example.com>"],
  "references": ["<original-message-id@example.com>"],
  "bodyStructure": { "type": "text/plain", "partId": "body" },
  "bodyValues": {
    "body": { "value": "Thanks for your email. Here's my reply..." }
  }
}
```

Get the `messageId`, `from`, and `subject` from the original email first using `Email/get` with those properties.

## Envelope Override (Advanced)

By default, JMAP derives the envelope (SMTP FROM/TO) from the email headers. To override:

```json
["EmailSubmission/set", {
  "create": {
    "sub": {
      "emailId": "Mdeadbeef123",
      "identityId": "id1",
      "envelope": {
        "mailFrom": { "email": "you@fastmail.com" },
        "rcptTo": [
          { "email": "recipient@example.com" },
          { "email": "bcc-recipient@example.com" }
        ]
      }
    }
  }
}, "s"]
```
