// Cloudflare Pages Function: roda antes do site e atende tudo que começa com /api/
// Bindings usados: env.DB (D1) e env.MEDIA_BUCKET (R2)

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Pin",
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
  pronto = true;
}

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
        await env.DB.prepare("INSERT INTO tecnicos (slug, pin_hash) VALUES (?, ?)").bind(slug, h).run();
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
