// Cloudflare Pages Function: roda antes do site e atende tudo que começa com /api/
// Bindings usados: env.DB (D1) e env.MEDIA_BUCKET (R2)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Pin, X-Admin",
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });

let pronto = false;
async function preparar(db) {
  if (pronto) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, room_id TEXT, sender TEXT, content TEXT, type TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS tecnicos (
    slug TEXT PRIMARY KEY, nome TEXT, cor TEXT, base INTEGER, pin_hash TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS calls (
    id TEXT PRIMARY KEY, room_id TEXT, sender TEXT, status TEXT, criado INTEGER)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS sinais (
    id INTEGER PRIMARY KEY AUTOINCREMENT, call_id TEXT, de TEXT, tipo TEXT, dados TEXT)`).run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS clientes (
    id TEXT PRIMARY KEY, slug TEXT, nome TEXT, tel TEXT, criado INTEGER)`).run();
  for (const col of ["criado INTEGER", "status TEXT"]) {
    try { await db.prepare(`ALTER TABLE tecnicos ADD COLUMN ${col}`).run(); } catch (e) {}
  }
  pronto = true;
}

const adminOk = (req, env) => !!env.ADMIN_KEY && req.headers.get("X-Admin") === env.ADMIN_KEY;

async function hashPin(slug, pin) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(slug + ":" + pin));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pinConfere(env, slug, pin) {
  if (!/^[a-z0-9-]{2,30}$/.test(slug || "") || !/^\d{4,8}$/.test(pin || "")) return false;
  const row = await env.DB.prepare("SELECT pin_hash FROM tecnicos WHERE slug = ?").bind(slug).first();
  return !!row && row.pin_hash === (await hashPin(slug, pin));
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (request.method === "OPTIONS") return new Response(null, { headers: cors });
  if (!url.pathname.startsWith("/api/")) return context.next();

  try {
    await preparar(env.DB);

    // ---- Técnico: ler configuração pública ----
    if (url.pathname === "/api/tecnico" && request.method === "GET") {
      const slug = url.searchParams.get("slug") || "";
      const row = await env.DB.prepare("SELECT nome, cor, base FROM tecnicos WHERE slug = ?").bind(slug).first();
      return json(row ? { ...row, tem_pin: true } : { tem_pin: false });
    }

    // ---- Técnico: entrar / criar / salvar (o primeiro PIN registra o código) ----
    if (url.pathname === "/api/tecnico" && request.method === "POST") {
      const d = await request.json();
      const slug = String(d.slug || "");
      const pin = String(d.pin || "");
      if (!/^[a-z0-9-]{2,30}$/.test(slug)) return json({ error: "Código de link inválido" }, 400);
      if (!/^\d{4,8}$/.test(pin)) return json({ error: "PIN inválido" }, 400);

      const row = await env.DB.prepare("SELECT pin_hash FROM tecnicos WHERE slug = ?").bind(slug).first();
      const h = await hashPin(slug, pin);
      if (!row) {
        await env.DB.prepare("INSERT INTO tecnicos (slug, pin_hash, criado, status) VALUES (?, ?, ?, 'teste')").bind(slug, h, Date.now()).run();
      } else if (row.pin_hash !== h) {
        return json({ error: "PIN incorreto" }, 401);
      }
      if (d.acao === "login") return json({ ok: true });

      const nome = String(d.nome || "").trim().slice(0, 60) || "Técnico";
      const cor = /^#[0-9a-f]{6}$/i.test(d.cor || "") ? d.cor : "#10b981";
      const base = Math.max(0, Math.min(100000, Number(d.base) || 0));
      await env.DB.prepare("UPDATE tecnicos SET nome = ?, cor = ?, base = ? WHERE slug = ?")
        .bind(nome, cor, base, slug).run();
      return json({ ok: true });
    }

    // ---- Chamada de vídeo: só sinalização (o vídeo vai direto entre os celulares) ----
    if (url.pathname === "/api/call" && request.method === "GET") {
      const slug = url.searchParams.get("slug");
      if (slug) {
        if (!(await pinConfere(env, slug, request.headers.get("X-Pin")))) return json({ error: "Não autorizado" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT id, sender FROM calls WHERE status = 'ringing' AND criado > ? AND room_id LIKE ? ORDER BY criado DESC"
        ).bind(Date.now() - 45000, slug + ":%").all();
        return json(results);
      }
      const id = url.searchParams.get("id") || "";
      const de = url.searchParams.get("de") === "t" ? "t" : "c";
      const apos = Number(url.searchParams.get("apos")) || 0;
      const { results } = await env.DB.prepare(
        "SELECT id, tipo, dados FROM sinais WHERE call_id = ? AND de = ? AND id > ? ORDER BY id ASC LIMIT 50"
      ).bind(id, de, apos).all();
      return json({ sinais: results });
    }

    if (url.pathname === "/api/call" && request.method === "POST") {
      const d = await request.json();
      if (d.acao === "ligar") {
        if (!d.room_id) throw new Error("Informe a sala");
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO calls (id, room_id, sender, status, criado) VALUES (?, ?, ?, 'ringing', ?)")
          .bind(id, String(d.room_id).slice(0, 100), String(d.sender || "Cliente").slice(0, 60), Date.now()).run();
        return json({ id });
      }
      if (d.acao === "sinal") {
        const call = await env.DB.prepare("SELECT room_id FROM calls WHERE id = ?").bind(String(d.id || "")).first();
        if (!call) return json({ error: "Chamada não encontrada" }, 404);
        const de = d.de === "t" ? "t" : "c";
        if (de === "t" && !(await pinConfere(env, call.room_id.split(":")[0], request.headers.get("X-Pin")))) {
          return json({ error: "Não autorizado" }, 401);
        }
        const tipo = ["offer", "answer", "ice", "fim"].includes(d.tipo) ? d.tipo : null;
        if (!tipo) throw new Error("Tipo inválido");
        await env.DB.prepare("INSERT INTO sinais (call_id, de, tipo, dados) VALUES (?, ?, ?, ?)")
          .bind(d.id, de, tipo, String(d.dados || "").slice(0, 20000)).run();
        if (tipo === "answer") await env.DB.prepare("UPDATE calls SET status = 'ativa' WHERE id = ?").bind(d.id).run();
        if (tipo === "fim") await env.DB.prepare("UPDATE calls SET status = 'fim' WHERE id = ?").bind(d.id).run();
        return json({ ok: true });
      }
      throw new Error("Ação inválida");
    }

    // ---- Cadastro de cliente (para o painel do administrador) ----
    if (url.pathname === "/api/cliente" && request.method === "POST") {
      const d = await request.json();
      const slug = String(d.slug || "");
      const id = String(d.id || "");
      if (!/^[a-z0-9-]{2,30}$/.test(slug) || id.length < 8) return json({ error: "Dados inválidos" }, 400);
      await env.DB.prepare("INSERT OR IGNORE INTO clientes (id, slug, nome, tel, criado) VALUES (?, ?, ?, ?, ?)")
        .bind(id.slice(0, 64), slug, String(d.nome || "").slice(0, 60), String(d.tel || "").replace(/\D/g, "").slice(0, 15), Date.now()).run();
      return json({ ok: true });
    }

    // ---- Painel do administrador (exige a variável secreta ADMIN_KEY) ----
    if (url.pathname === "/api/admin") {
      if (!env.ADMIN_KEY) return json({ error: "Defina a variável ADMIN_KEY na Cloudflare" }, 503);
      if (!adminOk(request, env)) return json({ error: "Não autorizado" }, 401);
      if (request.method === "POST") {
        const d = await request.json();
        if (!["teste", "ativo", "suspenso"].includes(d.status)) throw new Error("Status inválido");
        await env.DB.prepare("UPDATE tecnicos SET status = ? WHERE slug = ?").bind(d.status, String(d.slug || "")).run();
        return json({ ok: true });
      }
      const t = await env.DB.prepare(
        `SELECT t.slug, t.nome, COALESCE(t.status, 'teste') AS status, t.criado,
                (SELECT COUNT(*) FROM clientes c WHERE c.slug = t.slug) AS clientes
         FROM tecnicos t ORDER BY t.criado DESC`).all();
      const c = await env.DB.prepare(
        `SELECT c.nome, c.tel, c.slug, c.criado, t.nome AS tecnico
         FROM clientes c LEFT JOIN tecnicos t ON t.slug = c.slug ORDER BY c.criado DESC LIMIT 500`).all();
      return json({ tecnicos: t.results, clientes: c.results });
    }

    // ---- Mensagens: ler ----
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const slug = url.searchParams.get("slug");
      if (slug) {
        // Visão do técnico: todas as salas dele, só com PIN
        if (!(await pinConfere(env, slug, request.headers.get("X-Pin")))) return json({ error: "Não autorizado" }, 401);
        const { results } = await env.DB.prepare(
          "SELECT * FROM messages WHERE room_id LIKE ? ORDER BY created_at DESC LIMIT 200"
        ).bind(slug + ":%").all();
        return json(results);
      }
      const roomId = url.searchParams.get("room_id") || "";
      if (!roomId) return json({ error: "Informe a sala" }, 400);
      const { results } = await env.DB.prepare(
        "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at DESC LIMIT 100"
      ).bind(roomId).all();
      return json(results);
    }

    // ---- Mensagens: enviar texto (JSON) ou arquivo (multipart) ----
    if (url.pathname === "/api/messages" && request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      if (contentType.includes("application/json")) {
        const d = await request.json();
        if (d.acao === "apagar") {
          const slug = String(d.slug || "");
          if (!(await pinConfere(env, slug, request.headers.get("X-Pin")))) return json({ error: "Não autorizado" }, 401);
          const m = await env.DB.prepare("SELECT room_id, content, type FROM messages WHERE id = ?").bind(String(d.id || "")).first();
          if (!m || !m.room_id.startsWith(slug + ":")) return json({ error: "Mensagem não encontrada" }, 404);
          const pref = url.origin + "/api/files/";
          if (m.type !== "text" && m.content.startsWith(pref)) {
            await env.MEDIA_BUCKET.delete(decodeURIComponent(m.content.slice(pref.length)));
          }
          await env.DB.prepare("DELETE FROM messages WHERE id = ?").bind(String(d.id)).run();
          return json({ ok: true });
        }
        const content = String(d.content || "").trim();
        if (!content) throw new Error("A mensagem não pode estar vazia");
        if (!d.room_id) throw new Error("Informe a sala");
        await env.DB.prepare(
          "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, 'text')"
        ).bind(crypto.randomUUID(), String(d.room_id).slice(0, 100), String(d.sender || "Cliente").slice(0, 60), content.slice(0, 2000)).run();
        return json({ success: true });
      }

      if (contentType.includes("multipart/form-data")) {
        const form = await request.formData();
        const file = form.get("file");
        const roomId = String(form.get("room_id") || "");
        if (!file || !roomId) throw new Error("Arquivo ou sala ausente");
        if (file.size > 50 * 1024 * 1024) throw new Error("Arquivo maior que 50 MB");

        const tipos = ["image", "video", "audio"];
        const pedido = String(form.get("type") || "");
        const type = tipos.includes(pedido) ? pedido : "image";
        const nomeSeguro = String(file.name || "arquivo").replace(/[^\w.-]/g, "_").slice(-60);
        const key = `uploads/${Date.now()}_${crypto.randomUUID().slice(0, 8)}_${nomeSeguro}`;

        await env.MEDIA_BUCKET.put(key, file.stream(), { httpMetadata: { contentType: file.type } });
        const fileUrl = `${url.origin}/api/files/${key}`;
        await env.DB.prepare(
          "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), roomId.slice(0, 100), String(form.get("sender") || "Cliente").slice(0, 60), fileUrl, type).run();
        return json({ success: true, url: fileUrl });
      }

      throw new Error("Content-Type não suportado");
    }

    // ---- Arquivos do R2 ----
    if (url.pathname.startsWith("/api/files/")) {
      const key = decodeURIComponent(url.pathname.replace("/api/files/", ""));
      const object = await env.MEDIA_BUCKET.get(key);
      if (!object) return new Response("Arquivo não encontrado", { status: 404, headers: cors });
      const headers = new Headers(cors);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);
      return new Response(object.body, { headers });
    }

    return new Response("Rota da API não encontrada", { status: 404, headers: cors });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}
