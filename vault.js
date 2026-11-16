// AutoNod - password lock (used by background.js and the dashboard)
//
// How it works:
//  - When you set a lock password, a key pair is made. The PUBLIC key is saved as is,
//    the PRIVATE key is saved locked with your lock password (PBKDF2 600k + AES-GCM).
//  - New passwords are locked with the public key right when they are saved, so AutoNod
//    never needs your lock password to work.
//  - To SEE or COPY a password, the dashboard asks for your lock password once and keeps
//    the unlocked key only in that tab's memory (gone when the tab is closed or "Lock" is pressed).
//  - Forgot the lock password = the saved passwords can't be opened by anyone (also not by us).
const Vault = (() => {
  const enc = new TextEncoder(), dec = new TextDecoder();
  const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
  const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  const RSA = { name: "RSA-OAEP", hash: "SHA-256" };

  async function wrapKeyFrom(pass, salt) {
    const base = await crypto.subtle.importKey("raw", enc.encode(pass), "PBKDF2", false, ["deriveKey"]);
    return crypto.subtle.deriveKey({ name: "PBKDF2", salt, iterations: 600000, hash: "SHA-256" }, base,
      { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  }

  // -> { pub, priv, salt, iv }  (all base64) + the unlocked private key
  async function create(pass) {
    const kp = await crypto.subtle.generateKey({ ...RSA, modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]) },
      true, ["encrypt", "decrypt"]);
    const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
    const pkcs8 = await crypto.subtle.exportKey("pkcs8", kp.privateKey);
    const locked = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await wrapKeyFrom(pass, salt), pkcs8);
    const vault = { pub: b64(await crypto.subtle.exportKey("spki", kp.publicKey)), priv: b64(locked), salt: b64(salt), iv: b64(iv) };
    return { vault, key: kp.privateKey };
  }

  // lock one password with the public key (no lock password needed)
  async function seal(vault, text) {
    const pub = await crypto.subtle.importKey("spki", unb64(vault.pub), RSA, false, ["encrypt"]);
    return b64(await crypto.subtle.encrypt(RSA, pub, enc.encode(text)));
  }

  // lock password -> private key (throws on a wrong lock password)
  async function unlock(vault, pass) {
    const pkcs8 = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(vault.iv) },
      await wrapKeyFrom(pass, unb64(vault.salt)), unb64(vault.priv));
    return crypto.subtle.importKey("pkcs8", pkcs8, RSA, false, ["decrypt"]);
  }

  async function open(key, sealed) {
    return dec.decode(await crypto.subtle.decrypt(RSA, key, unb64(sealed)));
  }

  return { create, seal, unlock, open };
})();
