import { serve } from "https://deno.land/std@0.201.0/http/server.ts";
import { resolveDns } from "https://deno.land/std@0.201.0/dns/mod.ts";

// Helper: VarInt encoding/decoding
function createVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  while (true) {
    if ((value & 0xffffff80) === 0) {
      bytes.push(value);
      return new Uint8Array(bytes);
    }
    bytes.push((value & 0x7f) | 0x80);
    value >>>= 7;
  }
}

function readVarInt(buffer: Uint8Array, offset = 0): { value: number; size: number } {
  let value = 0;
  let size = 0;
  let byte = 0;
  do {
    byte = buffer[offset++];
    value |= (byte & 0x7f) << (size++ * 7);
    if (size > 5) throw new Error("VarInt too big");
  } while (byte & 0x80);
  return { value, size: offset };
}

// Java edition ping
async function pingJava(host: string, port: number) {
  const conn = await Deno.connect({ hostname: host, port });
  try {
    const hostBuf = new TextEncoder().encode(host);
    const portBuf = new Uint8Array(2);
    new DataView(portBuf.buffer).setUint16(0, port);
    const handshakePayload = new Uint8Array([
      ...createVarInt(-1),
      ...createVarInt(hostBuf.length),
      ...hostBuf,
      ...portBuf,
      ...createVarInt(1)
    ]);
    const handshakePacket = new Uint8Array([
      ...createVarInt(0x00),
      ...createVarInt(handshakePayload.length),
      ...handshakePayload
    ]);
    await conn.write(handshakePacket);
    // Status request
    await conn.write(new Uint8Array([...createVarInt(0x00), ...createVarInt(0)]));

    const buf = new Uint8Array(1024);
    const n = (await conn.read(buf))!;
    const { value: length, size: off1 } = readVarInt(buf, 0);
    const { value: packetId, size: off2 } = readVarInt(buf, off1);
    if (packetId !== 0x00) throw new Error("Invalid packet");
    const { value: jsonLen, size: off3 } = readVarInt(buf, off2);
    const json = new TextDecoder().decode(buf.slice(off3, off3 + jsonLen));
    const info = JSON.parse(json);
    // Ping
    const payload = new Uint8Array([1,2,3,4,5,6,7,8]);
    const pingPacket = new Uint8Array([
      ...createVarInt(0x01),
      ...createVarInt(payload.length),
      ...payload
    ]);
    const start = performance.now();
    await conn.write(pingPacket);
    await conn.read(buf);
    info.latency = Math.round(performance.now() - start);
    return info;
  } finally {
    conn.close();
  }
}

// Bedrock edition ping
function createBedrockPacket(): Uint8Array {
  const packetId = new Uint8Array([0x01]);
  const timeBuf = new Uint8Array(8);
  new DataView(timeBuf.buffer).setBigUint64(0, BigInt(Date.now()));
  const magic = new Uint8Array([0x00,0xff,0xff,0x00,0xfe,0xfe,0xfe,0xfe,0xfd,0xfd,0xfd,0xfd,0x12,0x34,0x56,0x78]);
  const clientId = new Uint8Array(8);
  new DataView(clientId.buffer).setBigUint64(0, BigInt(Math.floor(Math.random()*1e15)));
  return new Uint8Array([...packetId, ...timeBuf, ...magic, ...clientId]);
}

async function pingBedrock(host: string, port: number) {
  const sock = Deno.listenDatagram({ port: 0, transport: "udp" });
  await sock.send(createBedrockPacket(), { hostname: host, port });
  const [msg] = await sock.receive();
  sock.close();
  if (msg[0] !== 0x1c) throw new Error("Invalid bedrock packet");
  const str = new TextDecoder().decode(msg.slice(35));
  const parts = str.split(";");
  const timeSent = Number(new DataView(msg.buffer).getBigUint64(1));
  return { edition: parts[0], motd: parts[1], protocol: +parts[2], version: parts[3], playersOnline: +parts[4], playersMax: +parts[5], serverId: parts[6], worldname: parts[7], gameMode: parts[8], latency: Date.now() - timeSent };
}

// Resolve SRV
async function resolveSrv(host: string) {
  try {
    const res = await resolveDns(`_minecraft._tcp.${host}`, "SRV");
    if (res.length) return { target: res[0].target, port: res[0].port };
  } catch { }
  return null;
}

// CORS headers
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" };

// Launch server
serve(async (req) => {
  const { pathname } = new URL(req.url);
  if (req.method === "OPTIONS") return new Response(null, { headers: CORS });

  if (pathname.startsWith("/api/status/bedrock/")) {
    const addr = pathname.substring(20);
    const [host, portStr] = addr.split(":");
    const port = +portStr || 19132;
    try {
      const srv = await resolveSrv(host) || { target: host, port };
      const info = await pingBedrock(srv.target, srv.port);
      return new Response(JSON.stringify({ success: true, ...info }), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }

  if (pathname.startsWith("/api/status/")) {
    const addr = pathname.substring(12);
    const [host, portStr] = addr.split(":");
    const port = +portStr || 25565;
    try {
      const srv = await resolveSrv(host) || { target: host, port };
      const info = await pingJava(srv.target, srv.port);
      return new Response(JSON.stringify({ success: true, version: info.version, players: info.players, description: info.description, latency: info.latency, favicon: info.favicon }), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }

  if (pathname.startsWith("/api/png/")) {
    const addr = pathname.substring(9);
    const [host, portStr] = addr.split(":");
    const port = +portStr || 25565;
    try {
      const srv = await resolveSrv(host) || { target: host, port };
      const info: any = await pingJava(srv.target, srv.port);
      if (info.favicon?.startsWith("data:image/png;base64,")) {
        const data = info.favicon.split(",")[1];
        const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
        return new Response(bytes, { headers: { ...CORS, "Content-Type": "image/png" } });
      }
      return new Response(JSON.stringify({ success: false, error: "no_favicon" }), { headers: { ...CORS, "Content-Type": "application/json" } });
    } catch (e) {
      return new Response(JSON.stringify({ success: false, error: e.message }), { headers: { ...CORS, "Content-Type": "application/json" } });
    }
  }

  return new Response("Not Found", { status: 404, headers: CORS });
});
