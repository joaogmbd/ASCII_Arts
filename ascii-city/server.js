#!/usr/bin/env node
/* ------------------------------------------------------------------ *
 * ASCII CITY — servidor de rede local
 *
 * Serve o jogo e leva os jogadores de um lado para o outro. Sem
 * dependência nenhuma: o aperto de mão e o enquadramento de WebSocket
 * cabem em cem linhas, e assim o projeto continua sendo "baixar e rodar",
 * sem npm install.
 *
 *   node server.js            # porta 8080
 *   node server.js 9000       # outra porta
 *
 * Depois é só abrir http://<ip-da-maquina>:8080 em cada computador da
 * rede. Como a página vem deste mesmo servidor, o jogo já sabe com quem
 * falar e o multiplayer aparece sozinho no menu.
 *
 * Por que WebSocket e não WebRTC: numa rede local o que se quer é achar
 * os amigos, e para isso alguém tem de manter a lista. WebRTC precisaria
 * de um servidor de sinalização de qualquer jeito — ou seja, deste mesmo
 * processo — e ainda traria ICE e NAT para um problema que não tem NAT.
 * ------------------------------------------------------------------ */

"use strict";
const http = require("http");
const fs   = require("fs");
const path = require("path");
const crypto = require("crypto");
const os   = require("os");

const PORTA = parseInt(process.argv[2], 10) || 8080;
const RAIZ  = __dirname;
const TICK  = 1000 / 15;              // 15 Hz de estado é de sobra a pé
const GUID  = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

const MIME = { ".html":"text/html; charset=utf-8", ".js":"text/javascript",
               ".css":"text/css", ".mp3":"audio/mpeg", ".txt":"text/plain; charset=utf-8",
               ".png":"image/png", ".ico":"image/x-icon" };

/* ---- arquivos estáticos ------------------------------------------- */
const srv = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split("?")[0]);
  if (rel === "/") rel = "/index.html";
  const alvo = path.normalize(path.join(RAIZ, rel));
  if (!alvo.startsWith(RAIZ)){ res.writeHead(403).end("nao"); return; }   // ../
  fs.readFile(alvo, (err, buf) => {
    if (err){ res.writeHead(404).end("nao achei"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(alvo)] || "application/octet-stream" });
    res.end(buf);
  });
});

/* ---- enquadramento de WebSocket ----------------------------------- */
/*  Só o que o jogo usa: quadros de texto, um por mensagem. Fragmentação
    entra porque uma arte grande passa de 64 KB fácil.                  */
function aperto(req, socket){
  const chave = req.headers["sec-websocket-key"];
  if (!chave){ socket.destroy(); return false; }
  const aceite = crypto.createHash("sha1").update(chave + GUID).digest("base64");
  socket.write("HTTP/1.1 101 Switching Protocols\r\n" +
               "Upgrade: websocket\r\nConnection: Upgrade\r\n" +
               "Sec-WebSocket-Accept: " + aceite + "\r\n\r\n");
  socket.setNoDelay(true);
  return true;
}

function envia(socket, texto){
  if (socket.destroyed) return;
  const dados = Buffer.from(texto, "utf8");
  const n = dados.length;
  let cab;
  if (n < 126){ cab = Buffer.alloc(2); cab[1] = n; }
  else if (n < 65536){ cab = Buffer.alloc(4); cab[1] = 126; cab.writeUInt16BE(n, 2); }
  else { cab = Buffer.alloc(10); cab[1] = 127; cab.writeBigUInt64BE(BigInt(n), 2); }
  cab[0] = 0x81;                                   // FIN + texto
  try { socket.write(Buffer.concat([cab, dados])); } catch (e) {}
}
function fecha(socket){ try { socket.end(Buffer.from([0x88, 0x00])); } catch (e) {} socket.destroy(); }

/** desmonta o fluxo de bytes em mensagens completas */
function leitor(socket, aoReceber, aoFechar){
  let buf = Buffer.alloc(0), partes = [], opParte = 0;
  socket.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;){
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0, op = buf[0] & 0x0f;
      const mascarado = (buf[1] & 0x80) !== 0;
      let n = buf[1] & 0x7f, p = 2;
      if (n === 126){ if (buf.length < 4) return; n = buf.readUInt16BE(2); p = 4; }
      else if (n === 127){ if (buf.length < 10) return; n = Number(buf.readBigUInt64BE(2)); p = 10; }
      if (n > 4 * 1024 * 1024){ fecha(socket); return; }        // arte gigante: fora
      const mp = p; if (mascarado) p += 4;
      if (buf.length < p + n) return;
      const carga = Buffer.from(buf.subarray(p, p + n));
      if (mascarado) for (let i = 0; i < n; i++) carga[i] ^= buf[mp + (i & 3)];
      buf = buf.subarray(p + n);

      if (op === 0x8){ aoFechar(); fecha(socket); return; }
      if (op === 0x9){ socket.write(Buffer.concat([Buffer.from([0x8a, carga.length]), carga])); continue; }
      if (op === 0xa) continue;                                  // pong
      if (op === 0x0){ partes.push(carga); } else { partes = [carga]; opParte = op; }
      if (!fin) continue;
      const inteiro = Buffer.concat(partes); partes = [];
      if (opParte === 0x1) aoReceber(inteiro.toString("utf8"));
    }
  });
}

/* ---- sessões ------------------------------------------------------- */
/*  Toda sessão é multiplayer desde o primeiro segundo: quem entra sem
    escolher nada ganha a sua, já anunciada na lista, e o amigo cai
    dentro dela a qualquer hora.                                        */
let proxId = 1;
const clientes = new Map();          // id -> cliente
const sessoes  = new Map();          // id -> sessão

function novaSessao(nome, semente){
  const id = "s" + (proxId++);
  const s = { id, nome: nome || "cidade", semente: semente >>> 0, membros: new Set() };
  sessoes.set(id, s);
  return s;
}
function resumoSessoes(){
  const fora = [];
  for (const s of sessoes.values()){
    if (!s.membros.size) continue;
    const nomes = [];
    for (const cid of s.membros){ const c = clientes.get(cid); if (c) nomes.push(c.nome); }
    fora.push({ id: s.id, nome: s.nome, semente: s.semente, n: s.membros.size, quem: nomes });
  }
  fora.sort((a, b) => b.n - a.n || (a.nome < b.nome ? -1 : 1));
  return fora;
}
function difundeLista(){
  const msg = JSON.stringify({ t: "lista", s: resumoSessoes() });
  for (const c of clientes.values()) envia(c.socket, msg);
}
function paraSessao(sess, msg, exceto){
  const txt = typeof msg === "string" ? msg : JSON.stringify(msg);
  for (const cid of sess.membros){
    if (cid === exceto) continue;
    const c = clientes.get(cid);
    if (c) envia(c.socket, txt);
  }
}
function sai(c, calado){
  const s = c.sessao && sessoes.get(c.sessao);
  c.sessao = null;
  if (!s) return;
  s.membros.delete(c.id);
  paraSessao(s, { t: "saiu", id: c.id });
  if (!s.membros.size) sessoes.delete(s.id);
  if (!calado) difundeLista();
}
function entra(c, s){
  if (c.sessao === s.id) return;
  sai(c, true);
  c.sessao = s.id;
  s.membros.add(c.id);
  const jog = [];
  for (const cid of s.membros){
    if (cid === c.id) continue;
    const o = clientes.get(cid);
    if (o) jog.push({ id: o.id, nome: o.nome, arte: o.arte });
  }
  /*  A arte de cada um vai junto do "entrou": quem chega depois recebe a
      de todo mundo que já estava, e quem já estava recebe a de quem
      chega. Por isso o jogador nunca reenvia arte à mão — o navegador
      guarda a dele e manda uma vez por conexão, sozinho.               */
  envia(c.socket, JSON.stringify({ t: "entrou", id: s.id, nome: s.nome,
                                   semente: s.semente, jog }));
  paraSessao(s, { t: "jog", id: c.id, nome: c.nome, arte: c.arte }, c.id);
  difundeLista();
}

srv.on("upgrade", (req, socket) => {
  if (!aperto(req, socket)) return;
  const c = { id: "c" + (proxId++), socket, nome: "anon", arte: null,
              sessao: null, est: null, ultimoChat: 0 };
  clientes.set(c.id, c);
  envia(socket, JSON.stringify({ t: "eu", id: c.id }));
  envia(socket, JSON.stringify({ t: "lista", s: resumoSessoes() }));

  const encerra = () => {
    if (!clientes.has(c.id)) return;
    sai(c);
    clientes.delete(c.id);
  };
  socket.on("error", encerra);
  socket.on("close", encerra);

  leitor(socket, (texto) => {
    let m; try { m = JSON.parse(texto); } catch (e) { return; }
    switch (m.t){
      case "ola": {
        c.nome = String(m.nome || "anon").slice(0, 16);
        if (m.arte) c.arte = limpaArte(m.arte);
        if (!c.sessao){
          const s = novaSessao(c.nome, (m.semente >>> 0) || (Math.random() * 1e9) >>> 0);
          entra(c, s);
        } else {
          const s = sessoes.get(c.sessao);
          if (s) paraSessao(s, { t: "nome", id: c.id, nome: c.nome }, c.id);
          difundeLista();
        }
        break;
      }
      case "arte": {
        c.arte = m.arte ? limpaArte(m.arte) : null;
        const s = c.sessao && sessoes.get(c.sessao);
        if (s) paraSessao(s, { t: "arte", id: c.id, arte: c.arte }, c.id);
        break;
      }
      case "criar": {
        entra(c, novaSessao(String(m.nome || c.nome).slice(0, 24),
                            (m.semente >>> 0) || (Math.random() * 1e9) >>> 0));
        break;
      }
      case "entrar": {
        const s = sessoes.get(m.id);
        if (s) entra(c, s);
        else envia(socket, JSON.stringify({ t: "erro", txt: "essa sessao acabou" }));
        break;
      }
      case "est": {
        c.est = { x: +m.x || 0, y: +m.y || 0, z: +m.z || 0, yaw: +m.yaw || 0,
                  sk: !!m.sk, mv: +m.mv || 0 };
        break;
      }
      case "chat": {
        const agora = Date.now();
        if (agora - c.ultimoChat < 400) break;               // anti-enxurrada
        c.ultimoChat = agora;
        const txt = String(m.txt || "").slice(0, 120);
        if (!txt.trim()) break;
        const s = c.sessao && sessoes.get(c.sessao);
        if (s) paraSessao(s, { t: "chat", id: c.id, nome: c.nome, txt });
        break;
      }
    }
  }, encerra);
});

/** a arte chega de um txt qualquer, então nada de confiar no formato */
function limpaArte(a){
  if (!Array.isArray(a.l)) return null;
  const l = a.l.slice(0, 40).map(s => String(s).slice(0, 60));
  if (!l.length) return null;
  const w = Math.max(...l.map(s => s.length));
  return { l: l.map(s => s.padEnd(w, " ")), w, h: l.length,
           cor: Array.isArray(a.cor) && a.cor.length === 3
                ? a.cor.map(v => Math.max(0, Math.min(1, +v || 0))) : [0.85, 0.9, 1] };
}

/* ---- pulso de estado ----------------------------------------------- */
setInterval(() => {
  for (const s of sessoes.values()){
    if (s.membros.size < 2) continue;
    const e = [];
    for (const cid of s.membros){
      const c = clientes.get(cid);
      if (c && c.est) e.push({ id: c.id, ...c.est });
    }
    if (e.length) paraSessao(s, { t: "est", e });
  }
}, TICK);

srv.listen(PORTA, () => {
  const ips = [];
  for (const lista of Object.values(os.networkInterfaces()))
    for (const i of lista || []) if (i.family === "IPv4" && !i.internal) ips.push(i.address);
  console.log("ASCII CITY servindo em:");
  console.log("  http://localhost:" + PORTA);
  for (const ip of ips) console.log("  http://" + ip + ":" + PORTA + "   <- este para os amigos");
});
