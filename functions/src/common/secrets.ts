import { defineSecret } from 'firebase-functions/params';

/**
 * Pepper mixed into API key secrets before hashing (sha256(secret + pepper)).
 * Shared between the apikeys.* Platform Actions (which hash on create) and
 * the MCP request authenticator (which hashes on every call to compare) —
 * both must bind this same secret via `secrets: [mcpKeyPepper]`.
 */
export const mcpKeyPepper = defineSecret('MCP_KEY_PEPPER');
