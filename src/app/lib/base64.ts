// UTF-8-safe base64 helpers.
//
// WHY THIS EXISTS: the naive `atob(content)` decodes base64 into a *binary*
// string — every multi-byte UTF-8 character (em dashes, accented letters,
// emoji, non-Latin scripts) comes out as mojibake. The AI then analyzes a
// corrupted file, and `btoa(content)` on the encode side throws an
// InvalidCharacterError for any character above U+00FF, which silently
// killed commits of AI fixes that contained a single “smart quote”.
//
// These helpers round-trip real UTF-8 through TextEncoder/TextDecoder.

/** Decode a base64 string (as returned by the GitHub/GitLab contents APIs)
 *  into a proper UTF-8 string. Newlines inside the base64 payload are
 *  tolerated (GitHub inserts them every 60 chars). */
export function b64DecodeUtf8(b64: string): string {
  const clean = b64.replace(/\s/g, '');
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}

/** Encode a UTF-8 string to base64 for the GitHub contents API. */
export function b64EncodeUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000; // avoid call-stack limits on large files
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
