'use strict';

// Remote Connection and Director Mode servers (BrowserServer.swift and
// DirectorServer.swift). Each serves one page over HTTP on its port and
// talks WebSocket on port + 1, the same protocol the Mac app documents.

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const WEB_DIR = path.join(__dirname, '..', 'web');

function localIPAddress() {
  const candidates = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' || a.internal) continue;
      let score = 0;
      if (/^192\.168\./.test(a.address)) score += 3;
      else if (/^10\./.test(a.address)) score += 2;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(a.address)) score += 1;
      if (/^(vEthernet|docker|br-|veth|virbr|utun|vmnet|VirtualBox)/i.test(name)) score -= 5;
      candidates.push({ address: a.address, score });
    }
  }
  candidates.sort((x, y) => y.score - x.score);
  return candidates.length ? candidates[0].address : '127.0.0.1';
}

class PageServer {
  constructor({ page, port, substitutions, maxClients }) {
    this.page = page;
    this.port = port;
    this.substitutions = substitutions;
    this.maxClients = maxClients;
    this.http = null;
    this.wss = null;
    this.clients = new Set();
    this.lastPayload = '';
  }

  get running() {
    return !!this.http;
  }

  html() {
    let html = fs.readFileSync(path.join(WEB_DIR, this.page), 'utf8');
    for (const [k, v] of Object.entries(this.substitutions())) html = html.split(k).join(String(v));
    return html;
  }

  async start() {
    if (this.running) return;
    const server = http.createServer((req, res) => {
      if (req.method !== 'GET') {
        res.writeHead(405).end();
        return;
      }
      const body = Buffer.from(this.html(), 'utf8');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Length': body.length,
        'Cache-Control': 'no-cache',
      });
      res.end(body);
    });
    await listen(server, this.port);
    const wsHttp = http.createServer((req, res) => res.writeHead(426).end());
    try {
      await listen(wsHttp, this.port + 1);
    } catch (e) {
      server.close();
      throw e;
    }
    this.http = server;
    this.wsHttp = wsHttp;
    this.wss = new WebSocketServer({ server: wsHttp, maxPayload: 1024 * 1024 });
    this.wss.on('connection', (socket) => {
      if (this.clients.size >= this.maxClients) {
        socket.close(1013, 'Too many connections');
        return;
      }
      this.clients.add(socket);
      socket.on('close', () => this.clients.delete(socket));
      socket.on('error', () => this.clients.delete(socket));
      this.onConnection(socket);
    });
  }

  onConnection() {}

  stop() {
    for (const c of this.clients) c.terminate();
    this.clients.clear();
    if (this.wss) this.wss.close();
    if (this.http) this.http.close();
    if (this.wsHttp) this.wsHttp.close();
    this.http = this.wsHttp = this.wss = null;
    this.lastPayload = '';
  }

  send(socket, payload) {
    if (socket.readyState === 1) socket.send(payload);
  }

  url() {
    return `http://${localIPAddress()}:${this.port}`;
  }
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    const onError = (e) => reject(e.code === 'EADDRINUSE' ? new Error(`Port ${port} is already in use.`) : e);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/// Read-only prompter view for phones, tablets and other computers.
class RemoteServer extends PageServer {
  constructor(port) {
    super({ page: 'remote.html', port, substitutions: () => ({ __WS_PORT__: this.port + 1 }), maxClients: 16 });
  }

  broadcast(state) {
    if (!this.clients.size) return;
    const payload = JSON.stringify(state);
    for (const c of this.clients) this.send(c, payload);
  }
}

/// Lets someone else write and push the script from a browser.
class DirectorServer extends PageServer {
  constructor(port, handlers) {
    super({
      page: 'director.html',
      port,
      substitutions: () => ({ __WS_PORT__: this.port + 1, __AUTH_TOKEN__: this.token }),
      maxClients: 5,
    });
    this.handlers = handlers;
    this.token = crypto.randomBytes(32).toString('hex');
    this.authed = new WeakSet();
  }

  onConnection(socket) {
    const timer = setTimeout(() => {
      if (!this.authed.has(socket)) socket.close(1008, 'Authentication required');
    }, 5000);
    socket.on('close', () => clearTimeout(timer));
    socket.on('message', (data) => {
      let cmd;
      try {
        cmd = JSON.parse(String(data));
      } catch (e) {
        return;
      }
      if (!cmd || typeof cmd.type !== 'string') return;
      if (!this.authed.has(socket)) {
        if (cmd.type === 'auth' && typeof cmd.text === 'string' && safeEqual(cmd.text, this.token)) {
          this.authed.add(socket);
          clearTimeout(timer);
          if (this.lastPayload) this.send(socket, this.lastPayload);
        } else {
          socket.close(1008, 'Authentication failed');
        }
        return;
      }
      if (cmd.type === 'setText' && typeof cmd.text === 'string') this.handlers.setText(cmd.text);
      else if (cmd.type === 'updateText' && typeof cmd.text === 'string' && Number.isFinite(cmd.readCharCount)) {
        this.handlers.updateText(cmd.text, cmd.readCharCount);
      } else if (cmd.type === 'stop') this.handlers.stop();
    });
  }

  broadcast(state) {
    const payload = JSON.stringify(state);
    if (payload === this.lastPayload) return;
    this.lastPayload = payload;
    for (const c of this.clients) if (this.authed.has(c)) this.send(c, payload);
  }
}

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/// The Mac app's BrowserState and DirectorState payloads.
function browserState(content, tick, style) {
  if (!content.active) {
    return {
      words: [], highlightedCharCount: 0, totalCharCount: 0, audioLevels: [], isListening: false,
      isDone: false, fontColor: '#ffffff', cueColor: '#ffffff', hasNextPage: false, isActive: false,
      highlightWords: true, lastSpokenText: '',
    };
  }
  return {
    words: content.words,
    highlightedCharCount: tick.charCount,
    totalCharCount: content.totalCharCount,
    audioLevels: tick.levels,
    isListening: tick.isListening,
    isDone: tick.isDone,
    fontColor: style.fontColor,
    cueColor: style.cueColor,
    hasNextPage: tick.hasNextPage,
    isActive: true,
    highlightWords: content.highlightWords,
    lastSpokenText: tick.lastSpokenText,
  };
}

function directorState(content, tick, style) {
  const active = content.active && content.directorMode;
  return {
    words: active ? content.words : [],
    highlightedCharCount: active ? tick.charCount : 0,
    totalCharCount: active ? content.totalCharCount : 0,
    isActive: active,
    isDone: active && content.totalCharCount > 0 && tick.charCount >= content.totalCharCount,
    isListening: active && tick.isListening,
    fontColor: active ? style.fontColor : '#ffffff',
    cueColor: active ? style.cueColor : '#ffffff',
    lastSpokenText: active ? tick.lastSpokenText : '',
    audioLevels: active ? tick.levels : [],
  };
}

module.exports = { RemoteServer, DirectorServer, browserState, directorState, localIPAddress };
