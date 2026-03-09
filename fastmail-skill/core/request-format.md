# Request Format

## Method Call Structure

Every request to the `execute` tool is an object with a `methodCalls` array. Each element is a triple:

```
[methodName, arguments, callId]
```

- **methodName**: A string like `"Email/query"` or `"Mailbox/get"`
- **arguments**: An object with method-specific parameters
- **callId**: A unique string identifier for this call (e.g., `"0"`, `"q1"`)

## Batching

Put multiple calls in a single request. They execute in order:

```json
{
  "methodCalls": [
    ["Mailbox/get", {}, "0"],
    ["Email/query", { "filter": { "inMailbox": "INBOX_ID" }, "limit": 10 }, "1"]
  ]
}
```

## Back-References with `resultOf`

Chain calls by referencing earlier results. Use `#` prefix on the argument key and provide a reference object:

```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": { "inMailbox": "INBOX_ID" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 10
    }, "q"],
    ["Email/get", {
      "#ids": {
        "resultOf": "q",
        "name": "Email/query",
        "path": "/ids"
      },
      "properties": ["from", "subject", "receivedAt", "preview"]
    }, "g"]
  ]
}
```

The `#ids` key tells the server to resolve the value from:
- `resultOf`: the callId of the earlier call
- `name`: the method name of that call
- `path`: a JSON Pointer into the result (e.g., `/ids` for the ids array from a query)

**Important**: The `resultOf` reference must point to a callId that appears **earlier** in the same request. The server validates this.

## Response Format

The server returns an array of response triples:

```json
[
  ["Email/query", { "ids": ["msg1", "msg2"], "total": 42 }, "q"],
  ["Email/get", { "list": [{ "id": "msg1", ... }, { "id": "msg2", ... }] }, "g"]
]
```

Each response triple matches the format: `[methodName, result, callId]`.

The server automatically strips protocol noise (`state`, `queryState`, `canCalculateChanges`, `position`, `accountId`) from responses.
