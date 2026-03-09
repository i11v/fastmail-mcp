# SearchSnippet/get

Get highlighted search snippets showing where search terms match in email subjects and bodies. Useful for showing search results with context.

## Usage

`SearchSnippet/get` must be paired with an `Email/query` that uses a text-based filter. Pass the same filter and reference the query's email IDs:

```json
{
  "methodCalls": [
    ["Email/query", {
      "filter": { "text": "project deadline" },
      "sort": [{ "property": "receivedAt", "isAscending": false }],
      "limit": 10
    }, "q"],
    ["SearchSnippet/get", {
      "#emailIds": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "filter": { "text": "project deadline" }
    }, "s"],
    ["Email/get", {
      "#ids": { "resultOf": "q", "name": "Email/query", "path": "/ids" },
      "properties": ["from", "to", "subject", "receivedAt"]
    }, "g"]
  ]
}
```

**Note**: `SearchSnippet/get` does not require a `properties` array.

## Arguments

| Argument | Type | Required | Description |
|----------|------|----------|-------------|
| `emailIds` | string[] | Yes | Email IDs to get snippets for (usually via `#emailIds` back-reference) |
| `filter` | object | Yes | Must match the filter from the `Email/query` call |

## Response

```json
["SearchSnippet/get", {
  "list": [
    {
      "emailId": "msg1",
      "subject": "Re: <mark>Project</mark> <mark>deadline</mark> update",
      "preview": "...the <mark>project</mark> <mark>deadline</mark> has been moved to next Friday..."
    }
  ],
  "notFound": []
}, "s"]
```

- `subject`: Subject with `<mark>` tags around matching terms (or `null` if no match in subject)
- `preview`: Body snippet with `<mark>` tags (or `null` if no match in body)

## When to Use

- **Use SearchSnippet** when the user is searching for something and wants to see where matches occur
- **Skip SearchSnippet** when you already know which emails to fetch (e.g., unread inbox, specific IDs)
