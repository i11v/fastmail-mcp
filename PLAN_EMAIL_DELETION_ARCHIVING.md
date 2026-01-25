# Implementation Plan: Email Deletion and Archiving

This document outlines the plan for implementing email deletion and archiving using the `Email/set` JMAP method via the `effect-jmap` library.

## Overview

The JMAP `Email/set` method (RFC 8621) allows:
- **Update**: Modify email properties (mailboxIds, keywords, etc.)
- **Destroy**: Permanently delete emails

For deletion and archiving, we'll modify the `mailboxIds` property to move emails between mailboxes.

## JMAP Email/set Method Reference

Based on [RFC 8621](https://datatracker.ietf.org/doc/html/rfc8621):

```json
{
  "using": [
    "urn:ietf:params:jmap:core",
    "urn:ietf:params:jmap:mail"
  ],
  "methodCalls": [
    ["Email/set", {
      "accountId": "account-id",
      "update": {
        "email-id-1": {
          "mailboxIds": { "trash-mailbox-id": true }
        }
      }
    }, "call-id"]
  ]
}
```

Key behaviors:
- **Move to Trash**: Set `mailboxIds` to only contain the trash mailbox ID
- **Archive**: Set `mailboxIds` to only contain the archive mailbox ID
- **Permanent Delete**: Use the `destroy` property to permanently remove emails

## Implementation Steps

### Step 1: Define Zod Schemas

Add new schemas in `src/tools.ts`:

```typescript
// Schema for email deletion (move to trash)
export const EmailDeleteSchema = z.object({
  accountId: z.string().optional().describe("JMAP account ID (auto-detected if not provided)"),
  emailIds: z.array(z.string()).min(1).max(50).describe("Array of email IDs to delete"),
  permanent: z.boolean().default(false).describe("If true, permanently destroy emails instead of moving to trash"),
});

// Schema for email archiving
export const EmailArchiveSchema = z.object({
  accountId: z.string().optional().describe("JMAP account ID (auto-detected if not provided)"),
  emailIds: z.array(z.string()).min(1).max(50).describe("Array of email IDs to archive"),
});

// Schema for moving emails between mailboxes (general purpose)
export const EmailMoveSchema = z.object({
  accountId: z.string().optional().describe("JMAP account ID (auto-detected if not provided)"),
  emailIds: z.array(z.string()).min(1).max(50).describe("Array of email IDs to move"),
  toMailboxIds: z.array(z.string()).min(1).describe("Target mailbox IDs"),
});

export type EmailDeleteArgs = z.infer<typeof EmailDeleteSchema>;
export type EmailArchiveArgs = z.infer<typeof EmailArchiveSchema>;
export type EmailMoveArgs = z.infer<typeof EmailMoveSchema>;
```

### Step 2: Implement Helper Function for Email/set

Since `effect-jmap` may not expose `EmailService.set()` directly, use `JMAPClientService.batch()` for raw JMAP calls (similar to the existing `Identity/get` pattern):

```typescript
/**
 * Execute Email/set JMAP method for updating/destroying emails
 */
async function emailSet(
  accountId: string,
  options: {
    update?: Record<string, { mailboxIds?: Record<string, boolean>; keywords?: Record<string, boolean> }>;
    destroy?: string[];
  },
  layers: Layer.Layer<any>
): Promise<{
  updated?: Record<string, any>;
  notUpdated?: Record<string, { type: string; description: string }>;
  destroyed?: string[];
  notDestroyed?: Record<string, { type: string; description: string }>;
}> {
  const program = Effect.gen(function* () {
    const client = yield* JMAPClientService;
    const callId = `email-set-${Date.now()}`;

    const methodCall: ["Email/set", any, string] = [
      "Email/set",
      {
        accountId,
        ...(options.update && { update: options.update }),
        ...(options.destroy && { destroy: options.destroy }),
      },
      callId,
    ];

    const response = yield* client.batch(
      [methodCall],
      [
        "urn:ietf:params:jmap:core",
        "urn:ietf:params:jmap:mail",
      ]
    );

    const emailSetResponse = response.methodResponses.find(
      ([method]) => method === "Email/set"
    );

    if (!emailSetResponse) {
      return yield* Effect.fail(new Error("Email/set response not found"));
    }

    const [, data] = emailSetResponse;
    return data;
  });

  return await Effect.runPromise(program.pipe(Effect.provide(layers)));
}
```

### Step 3: Implement emailDelete Function

```typescript
/**
 * Tool: Delete emails (move to trash or permanent delete)
 */
export async function emailDelete(
  args: EmailDeleteArgs,
  extra: RequestHandlerExtra<any, any>
): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = args.accountId || (await getAccountId(bearerToken, layers));

  if (args.permanent) {
    // Permanent deletion using destroy
    const result = await emailSet(
      accountId,
      { destroy: args.emailIds },
      layers
    );

    return {
      success: true,
      destroyed: result.destroyed || [],
      notDestroyed: result.notDestroyed || {},
    };
  }

  // Move to trash
  const program = Effect.gen(function* () {
    const mailboxService = yield* MailboxService;
    const mailboxes = yield* mailboxService.getAll(accountId);
    const trashMailbox = mailboxes.find((mb) => mb.role === "trash");

    if (!trashMailbox) {
      return yield* Effect.fail(new Error("Trash mailbox not found"));
    }

    return trashMailbox.id;
  });

  const trashMailboxId = await Effect.runPromise(program.pipe(Effect.provide(layers)));

  // Build update object for all emails
  const update: Record<string, { mailboxIds: Record<string, boolean> }> = {};
  for (const emailId of args.emailIds) {
    update[emailId] = {
      mailboxIds: { [trashMailboxId]: true },
    };
  }

  const result = await emailSet(accountId, { update }, layers);

  return {
    success: true,
    movedToTrash: Object.keys(result.updated || {}),
    notMoved: result.notUpdated || {},
    trashMailboxId,
  };
}
```

### Step 4: Implement emailArchive Function

```typescript
/**
 * Tool: Archive emails (move to archive mailbox)
 */
export async function emailArchive(
  args: EmailArchiveArgs,
  extra: RequestHandlerExtra<any, any>
): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = args.accountId || (await getAccountId(bearerToken, layers));

  // Find archive mailbox
  const program = Effect.gen(function* () {
    const mailboxService = yield* MailboxService;
    const mailboxes = yield* mailboxService.getAll(accountId);
    const archiveMailbox = mailboxes.find((mb) => mb.role === "archive");

    if (!archiveMailbox) {
      return yield* Effect.fail(
        new Error("Archive mailbox not found. You may need to create one in Fastmail settings.")
      );
    }

    return archiveMailbox.id;
  });

  const archiveMailboxId = await Effect.runPromise(program.pipe(Effect.provide(layers)));

  // Build update object for all emails
  const update: Record<string, { mailboxIds: Record<string, boolean> }> = {};
  for (const emailId of args.emailIds) {
    update[emailId] = {
      mailboxIds: { [archiveMailboxId]: true },
    };
  }

  const result = await emailSet(accountId, { update }, layers);

  return {
    success: true,
    archived: Object.keys(result.updated || {}),
    notArchived: result.notUpdated || {},
    archiveMailboxId,
  };
}
```

### Step 5: Implement emailMove Function (Optional but Recommended)

```typescript
/**
 * Tool: Move emails to specified mailboxes
 */
export async function emailMove(
  args: EmailMoveArgs,
  extra: RequestHandlerExtra<any, any>
): Promise<any> {
  const bearerToken = extractBearerToken(extra);
  const layers = createLayers(bearerToken);
  const accountId = args.accountId || (await getAccountId(bearerToken, layers));

  // Build mailboxIds object
  const mailboxIds: Record<string, boolean> = {};
  for (const mailboxId of args.toMailboxIds) {
    mailboxIds[mailboxId] = true;
  }

  // Build update object for all emails
  const update: Record<string, { mailboxIds: Record<string, boolean> }> = {};
  for (const emailId of args.emailIds) {
    update[emailId] = { mailboxIds };
  }

  const result = await emailSet(accountId, { update }, layers);

  return {
    success: true,
    moved: Object.keys(result.updated || {}),
    notMoved: result.notUpdated || {},
    targetMailboxIds: args.toMailboxIds,
  };
}
```

### Step 6: Update Tool Definitions

```typescript
export const toolDefinitions = {
  // ... existing tools
  email_delete: {
    description: "Delete emails by moving them to trash, or permanently destroy them",
    parameters: EmailDeleteSchema,
  },
  email_archive: {
    description: "Archive emails by moving them to the archive mailbox",
    parameters: EmailArchiveSchema,
  },
  email_move: {
    description: "Move emails to specified mailbox(es)",
    parameters: EmailMoveSchema,
  },
};
```

### Step 7: Register Tools with MCP Server

Add registrations in `registerTools()`:

```typescript
// Tool: Delete emails
server.registerTool(
  "email_delete",
  {
    description: "Delete emails by moving them to trash, or permanently destroy them. Use permanent=true for permanent deletion.",
    inputSchema: EmailDeleteSchema,
  },
  async (args, extra) => {
    try {
      const result = await emailDelete(args, extra);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Archive emails
server.registerTool(
  "email_archive",
  {
    description: "Archive emails by moving them to the archive mailbox",
    inputSchema: EmailArchiveSchema,
  },
  async (args, extra) => {
    try {
      const result = await emailArchive(args, extra);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);

// Tool: Move emails
server.registerTool(
  "email_move",
  {
    description: "Move emails to specified mailbox(es). Use mailbox_get to find mailbox IDs.",
    inputSchema: EmailMoveSchema,
  },
  async (args, extra) => {
    try {
      const result = await emailMove(args, extra);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    } catch (error) {
      return {
        content: [
          {
            type: "text",
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  }
);
```

## File Changes Summary

| File | Changes |
|------|---------|
| `src/tools.ts` | Add schemas, helper function, tool implementations, definitions, and registrations |

## Testing Plan

1. **Unit Tests**: Test each function with mocked JMAP responses
2. **Integration Tests**:
   - Delete email → verify moved to trash
   - Archive email → verify moved to archive
   - Move email → verify in target mailbox
   - Permanent delete → verify email destroyed
3. **Edge Cases**:
   - Non-existent email IDs
   - Missing trash/archive mailbox
   - Insufficient permissions
   - Batch operations (multiple emails)

## API Response Examples

### email_delete Response (move to trash)
```json
{
  "success": true,
  "movedToTrash": ["email-id-1", "email-id-2"],
  "notMoved": {},
  "trashMailboxId": "M123456"
}
```

### email_delete Response (permanent)
```json
{
  "success": true,
  "destroyed": ["email-id-1", "email-id-2"],
  "notDestroyed": {}
}
```

### email_archive Response
```json
{
  "success": true,
  "archived": ["email-id-1"],
  "notArchived": {},
  "archiveMailboxId": "M789012"
}
```

## References

- [RFC 8621 - JMAP for Mail](https://datatracker.ietf.org/doc/html/rfc8621)
- [JMAP Mail Specification](https://jmap.io/spec-mail.html)
- [effect-jmap package](https://www.npmjs.com/package/effect-jmap)
- Existing implementation patterns in `src/tools.ts`
