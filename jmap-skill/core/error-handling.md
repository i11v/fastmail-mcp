# Error Handling

## Server Validation Errors

The execute server validates your request before sending it to Fastmail. These errors are returned immediately:

| Error | Cause | Fix |
|-------|-------|-----|
| `unknown method "X"` | Method not in allowlist | Check SKILL.md for allowed methods |
| `requires a "properties" array` | `/get` call missing properties | Add `"properties": [...]` |
| `requires a "limit"` | `/query` call missing limit | Add `"limit": N` (max 50 recommended) |
| `ids: null fetches ALL items` | Passing `ids: null` to `/get` | Use `/query` first to get specific IDs |
| `resultOf references "X" which has not appeared` | Back-reference to unknown callId | Ensure referenced callId is in an earlier call |
| `duplicate callId` | Two calls share the same callId | Use unique callId strings |

## JMAP Protocol Errors

If validation passes but Fastmail returns an error, you'll see an error response triple:

```json
["error", {
  "type": "invalidArguments",
  "description": "The property 'foo' is not filterable"
}, "callId"]
```

Common JMAP error types:

| Type | Meaning |
|------|---------|
| `invalidArguments` | Bad argument names, types, or values |
| `invalidResultReference` | `resultOf` path didn't resolve to expected type |
| `notFound` | Referenced ID doesn't exist |
| `forbidden` | Not authorized for this operation |
| `stateMismatch` | `ifInState` didn't match (for conditional updates) |
| `tooLarge` | Request too large to process |

## Destructive Operation Errors

The server blocks destructive operations and asks you to confirm with the user first:

- `EmailSubmission/set` (sending email)
- Any `/set` with a `destroy` array

You'll receive an error like: `"This request contains destructive operations: ... Please confirm with the user before retrying."`

After getting user confirmation, retry the exact same request.

## Self-Correction Strategy

1. Read the error message carefully — it usually tells you exactly what to fix
2. Fix the specific issue (add missing properties, correct argument names, etc.)
3. Retry the request
4. If you get a JMAP `invalidArguments` error, check the relevant skill file for correct argument names
