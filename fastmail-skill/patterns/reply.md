# Pattern: Reply to an Email

Replying is a multi-step workflow: read the original, create a reply draft, and submit it.

## Step 1: Get the Original Email

```json
{
  "methodCalls": [
    ["Email/get", {
      "ids": ["ORIGINAL_MSG_ID"],
      "properties": ["from", "to", "cc", "subject", "messageId", "references", "bodyValues", "textBody"],
      "fetchAllBodyValues": true
    }, "orig"],
    ["Identity/get", {}, "i"]
  ]
}
```

From the response, extract:
- `from` → becomes `to` in the reply
- `subject` → prepend "Re: " (if not already there)
- `messageId[0]` → goes into `inReplyTo` and `references`
- `references` → append the original `messageId` to build the full references chain
- Identity → pick the matching `from` address

## Step 2: Create and Send the Reply

```json
{
  "methodCalls": [
    ["Email/set", {
      "create": {
        "reply": {
          "mailboxIds": { "DRAFTS_ID": true },
          "keywords": { "$draft": true, "$seen": true },
          "from": [{ "name": "You", "email": "you@fastmail.com" }],
          "to": [{ "name": "Original Sender", "email": "sender@example.com" }],
          "subject": "Re: Original Subject",
          "inReplyTo": ["<original-message-id@server.example>"],
          "references": ["<earlier-ref@example>", "<original-message-id@server.example>"],
          "bodyStructure": { "type": "text/plain", "partId": "body" },
          "bodyValues": {
            "body": { "value": "Thanks for your message.\n\nHere is my reply." }
          }
        }
      }
    }, "c"],
    ["EmailSubmission/set", {
      "create": {
        "sub": {
          "#emailId": { "resultOf": "c", "name": "Email/set", "path": "/created/reply/id" },
          "identityId": "IDENTITY_ID"
        }
      }
    }, "s"]
  ]
}
```

**Remember**: `EmailSubmission/set` is destructive — the server will ask for user confirmation before sending.

## Reply All

For reply-all, merge the original `to` and `cc` lists (excluding yourself) into the reply's `to` and `cc`:

- `to`: Original `from` (the sender)
- `cc`: Original `to` + original `cc`, minus your own address

## After Sending

Optionally mark the original as answered:

```json
["Email/set", {
  "update": {
    "ORIGINAL_MSG_ID": { "keywords/$answered": true }
  }
}, "mark"]
```

You can include this in the same request as the send, after the `EmailSubmission/set` call.
