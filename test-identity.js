// Quick test to see what Identity/get returns from Fastmail
const FASTMAIL_SESSION_ENDPOINT = "https://api.fastmail.com/jmap/session";
const bearerToken = process.env.FASTMAIL_API_TOKEN;

if (!bearerToken) {
  console.error("FASTMAIL_API_TOKEN environment variable is required");
  process.exit(1);
}

async function testIdentity() {
  try {
    // Get session
    const sessionRes = await fetch(FASTMAIL_SESSION_ENDPOINT, {
      headers: { Authorization: `Bearer ${bearerToken}` },
    });
    const session = await sessionRes.json();
    const accountId = session.primaryAccounts["urn:ietf:params:jmap:mail"];
    const apiUrl = session.apiUrl;

    // Call Identity/get
    const identityRes = await fetch(apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearerToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        using: [
          "urn:ietf:params:jmap:core",
          "urn:ietf:params:jmap:mail",
          "urn:ietf:params:jmap:submission",
        ],
        methodCalls: [["Identity/get", { accountId }, "a"]],
      }),
    });

    const result = await identityRes.json();
    console.log("Identity/get response:");
    console.log(JSON.stringify(result, null, 2));

    // Check for signature fields
    const identities = result.methodResponses[0][1].list;
    if (identities && identities.length > 0) {
      console.log("\n=== First Identity Object ===");
      console.log(JSON.stringify(identities[0], null, 2));
      console.log("\n=== Signature Fields ===");
      console.log("textSignature:", identities[0].textSignature || "(not set)");
      console.log("htmlSignature:", identities[0].htmlSignature || "(not set)");
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

testIdentity();
