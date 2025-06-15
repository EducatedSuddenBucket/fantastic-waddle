// Deno imports
import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { router } from "https://deno.land/x/rutt@0.2.0/mod.ts";

// Java Edition Pinger
function createVarInt(value: number): Uint8Array {
  const bytes: number[] = [];
  while (true) {
    if ((value & 0xffffff80) === 0) {
      bytes.push(value);
      return new Uint8Array(bytes);
    }
    bytes.push(value & 0x7f | 0x80);
    value >>>= 7;
  }
}

function createPacket(id: number, data: Uint8Array): Uint8Array {
  const idBuffer = createVarInt(id);
  const lengthBuffer = createVarInt(idBuffer.length + data.length);
  const result = new Uint8Array(lengthBuffer.length + idBuffer.length + data.length);
  result.set(lengthBuffer, 0);
  result.set(idBuffer, lengthBuffer.length);
  result.set(data, lengthBuffer.length + idBuffer.length);
  return result;
}

function readVarInt(buffer: Uint8Array, offset: number): [number, number] {
  let value = 0;
  let size = 0;
  let byte: number;
  do {
    byte = buffer[offset++];
    value |= (byte & 0x7f) << (size++ * 7);
    if (size > 5) {
      throw new Error('VarInt is too big');
    }
  } while (byte & 0x80);
  return [value, offset];
}

async function connectToJavaServer(host: string, port: number): Promise<any> {
  return new Promise(async (resolve, reject) => {
    let conn: Deno.Conn;
    let buffer = new Uint8Array(0);
    let serverInfo: any;
    let pingStartTime: bigint;
    let hasResolvedOrRejected = false;

    // Set a timeout for the entire operation
    const overallTimeout = setTimeout(() => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        if (conn) conn.close();
        const error = new Error('timeout');
        (error as any).code = 'TIMEOUT';
        reject(error);
      }
    }, 7000); // 7 seconds

    try {
      conn = await Deno.connect({ hostname: host, port: port });

      const hostBytes = new TextEncoder().encode(host);
      const portBuffer = new Uint8Array(2);
      new DataView(portBuffer.buffer).setUint16(0, port, false);
      
      const handshakeData = new Uint8Array(
        createVarInt(-1).length + 
        createVarInt(hostBytes.length).length + 
        hostBytes.length + 
        portBuffer.length + 
        createVarInt(1).length
      );
      
      let offset = 0;
      const varIntNeg1 = createVarInt(-1);
      const varIntHostLen = createVarInt(hostBytes.length);
      const varInt1 = createVarInt(1);
      
      handshakeData.set(varIntNeg1, offset); offset += varIntNeg1.length;
      handshakeData.set(varIntHostLen, offset); offset += varIntHostLen.length;
      handshakeData.set(hostBytes, offset); offset += hostBytes.length;
      handshakeData.set(portBuffer, offset); offset += portBuffer.length;
      handshakeData.set(varInt1, offset);

      const handshakePacket = createPacket(0x00, handshakeData);
      await conn.write(handshakePacket);
      
      const statusRequestPacket = createPacket(0x00, new Uint8Array(0));
      await conn.write(statusRequestPacket);

      // Read response in chunks
      const readBuffer = new Uint8Array(4096);
      while (!hasResolvedOrRejected) {
        const bytesRead = await conn.read(readBuffer);
        if (bytesRead === null) break;
        
        const newBuffer = new Uint8Array(buffer.length + bytesRead);
        newBuffer.set(buffer);
        newBuffer.set(readBuffer.slice(0, bytesRead), buffer.length);
        buffer = newBuffer;

        try {
          let offset = 0;
          const [length, newOffset] = readVarInt(buffer, offset);
          offset = newOffset;
          
          if (buffer.length >= offset + length) {
            const [packetId, newOffset2] = readVarInt(buffer, offset);
            offset = newOffset2;
            
            if (packetId === 0x00) {
              const [jsonLength, newOffset3] = readVarInt(buffer, offset);
              offset = newOffset3;
              
              const jsonResponse = new TextDecoder().decode(buffer.slice(offset, offset + jsonLength));
              serverInfo = JSON.parse(jsonResponse);
              
              const pingPacket = createPacket(0x01, new Uint8Array([0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]));
              pingStartTime = performance.now();
              await conn.write(pingPacket);
              
              buffer = buffer.slice(offset + jsonLength);
            } else if (packetId === 0x01) {
              const latency = performance.now() - Number(pingStartTime);
              serverInfo.latency = Math.round(latency);
              if (!hasResolvedOrRejected) {
                hasResolvedOrRejected = true;
                clearTimeout(overallTimeout);
                conn.close();
                resolve(serverInfo);
              }
            }
          }
        } catch (e) {
          if (!hasResolvedOrRejected) {
            hasResolvedOrRejected = true;
            clearTimeout(overallTimeout);
            conn.close();
            reject(e);
          }
        }
      }
    } catch (err) {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(overallTimeout);
        if (conn!) conn.close();
        reject(err);
      }
    }
  });
}

// Bedrock Edition Pinger
function createBedrockPacket(): Uint8Array {
  const packetId = new Uint8Array([0x01]);
  const timeBuffer = new Uint8Array(8);
  new DataView(timeBuffer.buffer).setBigUint64(0, BigInt(Date.now()), false);
  const magic = new Uint8Array([0x00, 0xff, 0xff, 0x00, 0xfe, 0xfe, 0xfe, 0xfe, 0xfd, 0xfd, 0xfd, 0xfd, 0x12, 0x34, 0x56, 0x78]);
  const clientGUID = new Uint8Array(8);
  new DataView(clientGUID.buffer).setBigUint64(0, BigInt(Math.floor(Math.random() * 1e15)), false);
  
  const result = new Uint8Array(packetId.length + timeBuffer.length + magic.length + clientGUID.length);
  result.set(packetId, 0);
  result.set(timeBuffer, packetId.length);
  result.set(magic, packetId.length + timeBuffer.length);
  result.set(clientGUID, packetId.length + timeBuffer.length + magic.length);
  return result;
}

function readBedrockResponse(buffer: Uint8Array): any {
  const packetId = buffer[0];
  if (packetId !== 0x1c) {
    throw new Error('Invalid packet ID');
  }
  const offset = 35;
  const serverInfoStr = new TextDecoder().decode(buffer.slice(offset));
  const serverInfoParts = serverInfoStr.split(';');
  return {
    edition: serverInfoParts[0],
    motd: serverInfoParts[1],
    protocol: parseInt(serverInfoParts[2], 10),
    version: serverInfoParts[3],
    playersOnline: parseInt(serverInfoParts[4], 10),
    playersMax: parseInt(serverInfoParts[5], 10),
    serverId: serverInfoParts[6],
    worldname: serverInfoParts[7],
    gameMode: serverInfoParts[8],
    nintendoLimited: serverInfoParts[9],
    portIPv4: serverInfoParts[10],
    portIPv6: serverInfoParts[11]
  };
}

async function pingBedrockServer(host: string, port: number): Promise<any> {
  return new Promise(async (resolve, reject) => {
    let conn: Deno.DatagramConn;
    let hasResolvedOrRejected = false;

    const timeout = setTimeout(() => {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        if (conn) conn.close();
        const error = new Error('timeout');
        (error as any).code = 'TIMEOUT';
        reject(error);
      }
    }, 7000); // 7 seconds

    try {
      conn = Deno.listenDatagram({ port: 0, transport: "udp" });
      const pingPacket = createBedrockPacket();
      const addr: Deno.NetAddr = { hostname: host, port: port, transport: "udp" };
      
      await conn.send(pingPacket, addr);

      // Wait for response
      const [msg] = await conn.receive();
      
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(timeout);
        try {
          const serverInfo = readBedrockResponse(new Uint8Array(msg));
          const responseTime = BigInt(Date.now()) - new DataView(msg).getBigUint64(1, false);
          serverInfo.latency = Number(responseTime);
          resolve(serverInfo);
        } catch (error) {
          reject(error);
        } finally {
          conn.close();
        }
      }
    } catch (err) {
      if (!hasResolvedOrRejected) {
        hasResolvedOrRejected = true;
        clearTimeout(timeout);
        if (conn!) conn.close();
        reject(err);
      }
    }
  });
}

function extractText(obj: any): string {
  let text = '';
  
  // Handle plain string
  if (typeof obj === 'string') {
    return obj;
  }
  
  // Handle color and formatting codes
  if (obj.color) {
    text += `§${getColorCode(obj.color)}`;
  }
  if (obj.bold) {
    text += '§l';
  }
  if (obj.italic) {
    text += '§o';
  }
  if (obj.underlined) {
    text += '§n';
  }
  if (obj.strikethrough) {
    text += '§m';
  }
  if (obj.obfuscated) {
    text += '§k';
  }
  
  // Add text content
  if (obj.text) {
    text += obj.text;
  }
  
  // Process extra array with proper reset codes
  if (obj.extra) {
    for (let i = 0; i < obj.extra.length; i++) {
      const item = obj.extra[i];
      const hasFormatting = item.color || item.bold || item.italic || 
                          item.underline || item.strikethrough || item.obfuscated;
      
      // Add reset code between elements in the extra array if needed
      if (i > 0) {
        const prevItem = obj.extra[i - 1];
        const prevHasFormatting = prevItem.color || prevItem.bold || prevItem.italic || 
                               prevItem.underline || prevItem.strikethrough || prevItem.obfuscated;
        
        if (prevHasFormatting) {
          text += '§r';
        }
      }
      
      // Process the item recursively
      text += extractText(item);
    }
  }
  
  return text;
}

function removeColorCodes(text: string): string {
  // Remove all Minecraft formatting codes (§ followed by any character)
  return text.replace(/§[0-9a-fklmnor]/gi, '');
}

function getColorCode(colorName: string): string {
  const colorCodes: { [key: string]: string } = {
    black: '0',
    dark_blue: '1',
    dark_green: '2',
    dark_aqua: '3',
    dark_red: '4',
    dark_purple: '5',
    gold: '6',
    gray: '7',
    dark_gray: '8',
    blue: '9',
    green: 'a',
    aqua: 'b',
    red: 'c',
    light_purple: 'd',
    yellow: 'e',
    white: 'f'
  };
  return colorCodes[colorName] || 'f';
}

async function resolveSrv(host: string): Promise<any> {
  try {
    const records = await Deno.resolveDns(`_minecraft._tcp.${host}`, "SRV");
    return records.length > 0 ? { name: records[0].target, port: records[0].port } : null;
  } catch (err) {
    return null;
  }
}

async function resolveAndConnect(host: string, port: number, isJava = true): Promise<any> {
  try {
    const srvRecord = await resolveSrv(host);
    if (srvRecord) {
      console.log(`SRV record found: ${srvRecord.name}:${srvRecord.port}`);
      host = srvRecord.name;
      port = srvRecord.port;
    }
    
    // Verify if the domain can be resolved
    await Deno.resolveDns(host, "A");
    
    if (isJava) {
      return await connectToJavaServer(host, port);
    } else {
      return await pingBedrockServer(host, port);
    }
  } catch (error) {
    console.error('Error resolving or connecting:', error);
    throw error;
  }
}

function createErrorResponse(err: any) {
  let errorResponse = {
    success: false,
    error: {
      code: 'unknown_error',
      message: 'Failed to connect to the server'
    }
  };

  if (err.code === 'TIMEOUT') {
    errorResponse.error = {
      code: 'timeout',
      message: 'Connection to server timed out'
    };
  } else if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
    errorResponse.error = {
      code: 'invalid_domain',
      message: 'The domain name could not be resolved'
    };
  } else if (err.code === 'ECONNREFUSED') {
    errorResponse.error = {
      code: 'connection_refused',
      message: 'Server refused the connection'
    };
  } else {
    errorResponse.error = {
      code: 'offline',
      message: 'Server appears to be offline or unreachable'
    };
  }

  return errorResponse;
}

// Routes
const routes = router({
  "/api/png/:serverip": async (req) => {
    const serverip = req.params?.serverip;
    if (!serverip) {
      return new Response(JSON.stringify({ success: false, error: { code: 'missing_parameter', message: 'Server IP is required' } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const [serverHost, serverPortStr] = serverip.split(':');
    const serverPort = serverPortStr ? parseInt(serverPortStr) : 25565;

    try {
      const response = await resolveAndConnect(serverHost, serverPort);
      if (response.favicon && response.favicon.startsWith('data:image/png;base64,')) {
        const faviconData = response.favicon.split(',')[1];
        const faviconBuffer = Uint8Array.from(atob(faviconData), c => c.charCodeAt(0));
        return new Response(faviconBuffer, {
          headers: { "Content-Type": "image/png" }
        });
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: {
            code: 'no_favicon',
            message: 'Server does not have a favicon'
          }
        }), {
          headers: { "Content-Type": "application/json" }
        });
      }
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify(createErrorResponse(err)), {
        headers: { "Content-Type": "application/json" }
      });
    }
  },

  "/api/status/:serverAddress": async (req) => {
    const serverAddress = req.params?.serverAddress;
    if (!serverAddress) {
      return new Response(JSON.stringify({ success: false, error: { code: 'missing_parameter', message: 'Server address is required' } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const [serverHost, serverPortStr] = serverAddress.split(':');
    const port = serverPortStr ? parseInt(serverPortStr, 10) : 25565;

    try {
      const response = await resolveAndConnect(serverHost, port);
      let description = '';
      if (typeof response.description === 'string') {
        description = response.description;
      } else if (response.description) {
        description = extractText(response.description);
      }

      const serverInfo = {
        success: true,
        version: response.version,
        players: {
          max: response.players.max,
          online: response.players.online,
          list: response.players.sample || []
        },
        description: description,
        description_clean: removeColorCodes(description),
        latency: response.latency,
        favicon: response.favicon
      };

      return new Response(JSON.stringify(serverInfo), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (err) {
      console.error(err);
      return new Response(JSON.stringify(createErrorResponse(err)), {
        headers: { "Content-Type": "application/json" }
      });
    }
  },

  "/api/status/bedrock/:serverAddress": async (req) => {
    const serverAddress = req.params?.serverAddress;
    if (!serverAddress) {
      return new Response(JSON.stringify({ success: false, error: { code: 'missing_parameter', message: 'Server address is required' } }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const [serverHost, serverPortStr] = serverAddress.split(':');
    const port = serverPortStr ? parseInt(serverPortStr, 10) : 19132;

    try {
      const response = await resolveAndConnect(serverHost, port, false);
      const serverInfo = {
        success: true,
        motd: response.motd,
        motd_clean: removeColorCodes(response.motd),
        levelName: response.worldname,
        playersOnline: response.playersOnline,
        playersMax: response.playersMax,
        gamemode: response.gameMode,
        serverId: response.serverId,
        protocol: response.protocol,
        version: response.version,
        latency: response.latency
      };

      return new Response(JSON.stringify(serverInfo), {
        headers: { "Content-Type": "application/json" }
      });
    } catch (error) {
      console.error('Ping failed:', error);
      return new Response(JSON.stringify(createErrorResponse(error)), {
        headers: { "Content-Type": "application/json" }
      });
    }
  }
});

// Enable CORS
function addCorsHeaders(response: Response): Response {
  response.headers.set("Access-Control-Allow-Origin", "*");
  response.headers.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  response.headers.set("Access-Control-Allow-Headers", "Content-Type");
  return response;
}

// Main handler
async function handler(req: Request): Promise<Response> {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return addCorsHeaders(new Response(null, { status: 200 }));
  }

  const response = await routes(req);
  return addCorsHeaders(response);
}

// Start server
const port = parseInt(Deno.env.get("PORT") || "8000");
console.log(`Server listening at http://localhost:${port}`);
serve(handler, { port });
