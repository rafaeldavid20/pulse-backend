import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { salesforceTokenKey } from '../common/secrets';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // el tamaño que recomienda GCM
const KEY_BYTES = 32;

function loadKey(): Buffer {
  const raw = salesforceTokenKey.value();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== KEY_BYTES) {
    // Un error acá es de configuración, no de runtime: mejor romper fuerte al
    // primer uso que cifrar con una clave corta y descubrirlo cuando no se
    // pueda descifrar nada.
    throw new Error(
      `SALESFORCE_TOKEN_KEY tiene ${key.length} bytes; se esperan ${KEY_BYTES} (32 bytes random en base64).`
    );
  }
  return key;
}

/**
 * Cifra un refresh token de Salesforce para guardarlo en Firestore.
 *
 * AES-256-GCM y no un hash porque el token hay que **recuperarlo** para
 * refrescar el access token — no alcanza con poder verificarlo, que es lo que
 * hace `hashApiKeySecret` con las keys del MCP.
 *
 * Formato: `iv:tag:ciphertext`, las tres partes en base64. El iv es aleatorio
 * por cifrado, así que dos tokens iguales no producen el mismo texto cifrado.
 */
export function encryptToken(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, loadKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ciphertext.toString('base64')}`;
}

/**
 * Descifra lo que produjo `encryptToken`. Lanza si el texto está corrupto o
 * si la clave cambió: GCM autentica, así que un token manipulado falla acá en
 * vez de llegar como basura a Salesforce.
 */
export function decryptToken(encrypted: string): string {
  const parts = encrypted.split(':');
  if (parts.length !== 3) {
    throw new Error('Token cifrado con formato inválido (se esperaba iv:tag:ciphertext).');
  }
  const [ivB64, tagB64, dataB64] = parts;
  const decipher = createDecipheriv(ALGORITHM, loadKey(), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}
