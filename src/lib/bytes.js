// Bytes as base64 text, for storage and messages.

/** @param {ArrayBuffer | ArrayBufferView} bytes */
export function toBase64(bytes) {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let text = "";
  for (const byte of view) text += String.fromCharCode(byte);
  return btoa(text);
}

/** @returns {Uint8Array} */
export function fromBase64(text) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
