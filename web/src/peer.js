const channelName = "wargame-match-v1";
const maxSignalLength = 4096;
const maxSdpLength = 16000;
const invitePrefix = "#match=";

async function readLimited(stream, limit) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > limit) throw new Error("This pairing code is too large.");
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const joined = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.length;
  }
  return joined;
}

export async function encodeSignal(description, sessionId) {
  const type = description.type === "offer" ? "o" : "a";
  if (!/^[0-9a-f]{16}$/.test(sessionId)) throw new Error("Invalid pairing session.");
  const stream = new Blob([description.sdp]).stream().pipeThrough(new CompressionStream("gzip"));
  const bytes = await readLimited(stream, 3000);
  const body = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${type}1.${sessionId}.${body}`;
}

export function parseSignalCode(input) {
  const value = input.trim();
  const start = value.indexOf(invitePrefix);
  const code = start === -1 ? value : value.slice(start + invitePrefix.length);
  if (code.length > maxSignalLength || !/^[oa]1\.[0-9a-f]{16}\.[A-Za-z0-9_-]+$/.test(code)) {
    throw new Error("Enter a valid Wargame invite or reply link.");
  }
  return code;
}

export async function decodeSignal(input, type) {
  const code = parseSignalCode(input);
  if (code[0] !== (type === "offer" ? "o" : "a")) throw new Error(`This step needs a multiplayer ${type}.`);
  const body = code.split(".")[2].replaceAll("-", "+").replaceAll("_", "/");
  const compressed = Uint8Array.from(atob(body), (char) => char.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const sdp = new TextDecoder().decode(await readLimited(stream, maxSdpLength));
  if (!sdp.startsWith("v=0") || !sdp.includes("m=application ") || /\nm=(?!application )/.test(sdp)) {
    throw new Error("The pairing code must describe a game data connection.");
  }
  return { type, sdp };
}

export function signalLink(code) {
  const url = new URL(location.href);
  url.search = "";
  url.hash = invitePrefix + code;
  return url.href;
}

async function finishGathering(peer) {
  if (peer.iceGatheringState === "complete") return;
  await new Promise((resolve) => {
    const check = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const finish = () => {
      clearTimeout(timer);
      peer.removeEventListener("icegatheringstatechange", check);
      resolve();
    };
    const timer = setTimeout(finish, 5500);
    peer.addEventListener("icegatheringstatechange", check);
    check();
  });
}

export function createPeer(host, handlers) {
  if (typeof RTCPeerConnection !== "function" || typeof CompressionStream !== "function" || typeof DecompressionStream !== "function") {
    throw new Error("This browser does not support peer-to-peer pairing. Try a current mobile or desktop browser.");
  }
  const peer = new RTCPeerConnection({ iceServers: [{ urls: "stun:stun.l.google.com:19302" }] });
  let sessionId = host ? Array.from(crypto.getRandomValues(new Uint8Array(8)), (byte) => byte.toString(16).padStart(2, "0")).join("") : null;
  let channel;
  let closed = false;
  let incomingMessages = Promise.resolve();
  function close(reason) {
    if (closed) return;
    closed = true;
    channel?.close();
    peer.close();
    if (reason) handlers.closed(reason);
  }
  function attach(incoming) {
    if (channel || incoming.label !== channelName) {
      incoming.close();
      return;
    }
    channel = incoming;
    channel.addEventListener("open", async () => {
      try {
        await handlers.open();
      } catch {
        close("The match could not start. Create a new invite.");
      }
    }, { once: true });
    channel.addEventListener("close", () => close("Your peer disconnected."));
    channel.addEventListener("error", () => close("The peer connection failed."));
    channel.addEventListener("message", (event) => {
      incomingMessages = incomingMessages.then(async () => {
        if (closed) return;
        if (typeof event.data !== "string" || event.data.length > 32_768) throw new Error("Invalid peer message.");
        await handlers.message(JSON.parse(event.data));
      }).catch(() => close("The peer sent an incompatible message. Reconnect from your last shared save."));
    });
  }
  if (host) attach(peer.createDataChannel(channelName));
  else peer.addEventListener("datachannel", (event) => attach(event.channel));
  peer.addEventListener("connectionstatechange", () => {
    if (peer.connectionState === "failed") close("A direct connection could not be made. Try the same Wi-Fi network.");
  });

  return {
    get connected() { return !closed && channel?.readyState === "open"; },
    close,
    matchesReply(input) {
      try {
        return host && parseSignalCode(input).startsWith(`a1.${sessionId}.`);
      } catch {
        return false;
      }
    },
    send(message) {
      if (channel?.readyState !== "open") throw new Error("The peer connection is closed.");
      channel.send(JSON.stringify(message));
    },
    async localSignal() {
      await peer.setLocalDescription(host ? await peer.createOffer() : await peer.createAnswer());
      await finishGathering(peer);
      return encodeSignal(peer.localDescription, sessionId);
    },
    async accept(input) {
      const code = parseSignalCode(input);
      const replySession = code.split(".")[1];
      if (host && replySession !== sessionId) throw new Error("This reply belongs to a different invite.");
      await peer.setRemoteDescription(await decodeSignal(code, host ? "answer" : "offer"));
      if (!host) sessionId = replySession;
    },
  };
}
