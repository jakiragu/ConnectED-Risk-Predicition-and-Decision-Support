
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

const encodeTime = (now, len = 10) => {
  let out = '';
  for (let i = len - 1; i >= 0; i--) {
    const mod = now % 32;
    out = ENCODING[mod] + out;
    now = (now - mod) / 32;
  }
  return out;
};

const encodeRandom = (len = 16) => {
  const bytes = new Uint8Array(len);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < len; i++) out += ENCODING[bytes[i] % 32];
  return out;
};

export const ulid = (now = Date.now()) => encodeTime(now) + encodeRandom();
