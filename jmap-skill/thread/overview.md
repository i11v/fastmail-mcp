# Thread/get

Threads group related emails into conversations. Each email has a `threadId` property.

## Usage

Fetch thread details to see all emails in a conversation:

```json
["Thread/get", {
  "ids": ["thread1"],
  "properties": ["emailIds"]
}, "t"]
```

## Response

```json
["Thread/get", {
  "list": [
    {
      "id": "thread1",
      "emailIds": ["msg1", "msg3", "msg7"]
    }
  ]
}, "t"]
```

- `emailIds`: Ordered list of email IDs in the thread (chronological order)

## Common Pattern: Expand a Conversation

Get an email's thread, then fetch all emails in it:

```json
{
  "methodCalls": [
    ["Email/get", {
      "ids": ["msg1"],
      "properties": ["threadId"]
    }, "e"],
    ["Thread/get", {
      "#ids": { "resultOf": "e", "name": "Email/get", "path": "/list/*/threadId" },
      "properties": ["emailIds"]
    }, "t"],
    ["Email/get", {
      "#ids": { "resultOf": "t", "name": "Thread/get", "path": "/list/*/emailIds" },
      "properties": ["from", "to", "subject", "receivedAt", "preview", "keywords"]
    }, "emails"]
  ]
}
```

This three-step chain: gets the threadId → gets the thread's email list → fetches all emails in the thread.

**Note**: The `/list/*/threadId` and `/list/*/emailIds` path syntax collects values from all items in the list.
