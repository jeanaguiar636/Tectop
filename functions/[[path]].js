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
  for (const col of ["criado INTEGER", "status TEXT", "mp_id TEXT", "origem TEXT"]) {
    try { await db.prepare(`ALTER TABLE tecnicos ADD COLUMN ${col}`).run(); } catch (e) {}
  }
  try { await db.prepare("ALTER TABLE calls ADD COLUMN modo TEXT").run(); } catch (e) {}
  pronto = true;
}

const TESTE_MS = 4 * 24 * 3600 * 1000; // 4 dias grátis
const PRECO = 18; // R$ por mês

// true se o técnico pode atender: assinatura ativa ou ainda dentro dos 4 dias de teste
async function acessoOk(env, slug) {
  const r = await env.DB.prepare("SELECT status, criado FROM tecnicos WHERE slug = ?").bind(slug).first();
  if (!r) return false; // código de link que não existe
  if (r.status === "ativo") return true;
  if (r.status === "suspenso") return false;
  return !r.criado || Date.now() < r.criado + TESTE_MS;
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
      const row = await env.DB.prepare("SELECT nome, cor, base, (pin_hash IS NOT NULL) AS tem_pin FROM tecnicos WHERE slug = ?").bind(slug).first();
      const ativo = await acessoOk(env, slug);
      return json(row ? { ...row, tem_pin: !!row.tem_pin, ativo } : { tem_pin: false, ativo });
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
      if (d.acao === "criar" && row) return json({ error: "Esse código de link já está em uso" }, 409);
      if (!row) {
        await env.DB.prepare("INSERT INTO tecnicos (slug, pin_hash, criado, status) VALUES (?, ?, ?, 'teste')").bind(slug, h, Date.now()).run();
      } else if (!row.pin_hash) {
        await env.DB.prepare("UPDATE tecnicos SET pin_hash = ? WHERE slug = ?").bind(h, slug).run();
      } else if (row.pin_hash !== h) {
        return json({ error: "PIN incorreto" }, 401);
      }
      if (d.acao === "trocar_pin") {
        const novo = String(d.novo || "");
        if (!/^\d{4,8}$/.test(novo)) return json({ error: "O novo PIN precisa ter de 4 a 8 números" }, 400);
        await env.DB.prepare("UPDATE tecnicos SET pin_hash = ? WHERE slug = ?").bind(await hashPin(slug, novo), slug).run();
        return json({ ok: true });
      }
      if (d.acao === "login") {
        const info = await env.DB.prepare("SELECT status, criado FROM tecnicos WHERE slug = ?").bind(slug).first();
        return json({
          ok: true,
          status: info?.status || "teste",
          fim_teste: info?.criado ? info.criado + TESTE_MS : null,
          ativo: await acessoOk(env, slug),
        });
      }

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
          "SELECT id, sender, modo FROM calls WHERE status = 'ringing' AND criado > ? AND room_id LIKE ? ORDER BY criado DESC"
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
        if (!(await acessoOk(env, String(d.room_id).split(":")[0]))) return json({ error: "Atendimento indisponível no momento" }, 402);
        const id = crypto.randomUUID();
        await env.DB.prepare("INSERT INTO calls (id, room_id, sender, status, criado, modo) VALUES (?, ?, ?, 'ringing', ?, ?)")
          .bind(id, String(d.room_id).slice(0, 100), String(d.sender || "Cliente").slice(0, 60), Date.now(), d.modo === "audio" ? "audio" : "video").run();
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
        if (d.acao === "resetpin") {
          await env.DB.prepare("UPDATE tecnicos SET pin_hash = NULL WHERE slug = ?").bind(String(d.slug || "")).run();
          return json({ ok: true });
        }
        if (!["teste", "ativo", "suspenso"].includes(d.status)) throw new Error("Status inválido");
        const slug = String(d.slug || "");
        const t = await env.DB.prepare("SELECT mp_id FROM tecnicos WHERE slug = ?").bind(slug).first();
        if (!t) return json({ error: "Técnico não encontrado" }, 404);
        let mpCancelado = false;
        if (d.status === "ativo") {
          await env.DB.prepare("UPDATE tecnicos SET status = 'ativo', origem = CASE WHEN origem = 'mp' THEN 'mp' ELSE 'manual' END WHERE slug = ?").bind(slug).run();
        } else if (d.status === "teste") {
          await env.DB.prepare("UPDATE tecnicos SET status = 'teste', criado = ?, origem = NULL WHERE slug = ?").bind(Date.now(), slug).run();
        } else {
          // Cancelar: se o técnico paga pelo Mercado Pago, cancela a cobrança lá também
          if (t.mp_id && env.MP_ACCESS_TOKEN) {
            const r = await fetch("https://api.mercadopago.com/preapproval/" + encodeURIComponent(t.mp_id), {
              method: "PUT",
              headers: { Authorization: "Bearer " + env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
              body: JSON.stringify({ status: "cancelled" }),
            });
            if (!r.ok) return json({ error: "Não consegui cancelar a cobrança no Mercado Pago. Nada foi alterado. Tente de novo." }, 502);
            mpCancelado = true;
          }
          await env.DB.prepare("UPDATE tecnicos SET status = 'suspenso' WHERE slug = ?").bind(slug).run();
        }
        return json({ ok: true, mp_cancelado: mpCancelado });
      }
      const t = await env.DB.prepare(
        `SELECT t.slug, t.nome, COALESCE(t.status, 'teste') AS status, t.criado, t.origem, (t.mp_id IS NOT NULL) AS tem_mp,
                (SELECT COUNT(*) FROM clientes c WHERE c.slug = t.slug) AS clientes
         FROM tecnicos t ORDER BY t.criado DESC`).all();
      const c = await env.DB.prepare(
        `SELECT c.nome, c.tel, c.slug, c.criado, t.nome AS tecnico
         FROM clientes c LEFT JOIN tecnicos t ON t.slug = c.slug ORDER BY c.criado DESC LIMIT 500`).all();
      return json({ tecnicos: t.results, clientes: c.results, mp: !!env.MP_ACCESS_TOKEN });
    }

    // ---- Manifest do app instalável (nome e link próprios de cada técnico) ----
    if (url.pathname === "/api/manifest" && request.method === "GET") {
      const slug = (url.searchParams.get("t") || "").toLowerCase();
      const ok = /^[a-z0-9-]{2,30}$/.test(slug);
      const row = ok ? await env.DB.prepare("SELECT nome FROM tecnicos WHERE slug = ?").bind(slug).first() : null;
      const nome = (row && row.nome) || "Atendimento Técnico";
      const start = ok ? "/?t=" + slug : "/";
      return new Response(JSON.stringify({
        id: start, name: nome, short_name: nome.slice(0, 12), description: "Atendimento técnico de " + nome,
        start_url: start, scope: "/", display: "standalone", orientation: "portrait",
        background_color: "#020617", theme_color: "#020617", lang: "pt-BR",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      }), { headers: { "Content-Type": "application/manifest+json", "Cache-Control": "no-cache", ...cors } });
    }

    // ---- Assinatura: cria a cobrança recorrente no Mercado Pago e devolve o link de pagamento ----
    if (url.pathname === "/api/assinar" && request.method === "POST") {
      const d = await request.json();
      const slug = String(d.slug || "");
      if (!(await pinConfere(env, slug, request.headers.get("X-Pin")))) return json({ error: "Não autorizado" }, 401);
      if (!env.MP_ACCESS_TOKEN) return json({ error: "O pagamento ainda não foi configurado" }, 503);
      const email = String(d.email || "").trim();
      if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "Informe um e-mail válido" }, 400);
      const r = await fetch("https://api.mercadopago.com/preapproval", {
        method: "POST",
        headers: { Authorization: "Bearer " + env.MP_ACCESS_TOKEN, "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: "Tectop - assinatura mensal",
          external_reference: slug,
          payer_email: email,
          auto_recurring: { frequency: 1, frequency_type: "months", transaction_amount: PRECO, currency_id: "BRL" },
          back_url: url.origin + "/?t=" + slug + "&painel=1",
          status: "pending",
        }),
      });
      const mp = await r.json().catch(() => ({}));
      if (!r.ok || !mp.init_point) {
        const detalhe = String(mp.message || mp.error || "").slice(0, 200);
        return json({ error: "O Mercado Pago não aceitou o pedido.", detalhe, codigo: r.status }, 502);
      }
      return json({ url: mp.init_point });
    }

    // ---- Aviso do Mercado Pago (webhook): confirma o status direto na API e atualiza o técnico ----
    if (url.pathname === "/api/mp-webhook") {
      if (!env.MP_ACCESS_TOKEN) return json({ ok: false }, 503);
      let id = url.searchParams.get("data.id") || url.searchParams.get("id");
      let tipo = url.searchParams.get("type") || url.searchParams.get("topic") || "";
      if (request.method === "POST") {
        try {
          const b = await request.json();
          id = id || (b && b.data && b.data.id);
          tipo = tipo || (b && (b.type || b.topic)) || "";
        } catch (e) {}
      }
      if (id && String(tipo).includes("preapproval")) {
        const r = await fetch("https://api.mercadopago.com/preapproval/" + encodeURIComponent(id), {
          headers: { Authorization: "Bearer " + env.MP_ACCESS_TOKEN },
        });
        if (r.ok) {
          const a = await r.json();
          const slug = String(a.external_reference || "");
          const st = a.status === "authorized" ? "ativo" : (a.status === "cancelled" || a.status === "paused") ? "suspenso" : null;
          if (slug && st) await env.DB.prepare("UPDATE tecnicos SET status = ?, mp_id = ?, origem = 'mp' WHERE slug = ?").bind(st, String(a.id || id), slug).run();
        }
      }
      return json({ ok: true });
    }

    // ---- Mensagens: ler ----
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const slug = url.searchParams.get("slug");
      if (slug) {
        if (!(await acessoOk(env, slug))) return json({ error: "Assinatura necessária" }, 402);
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
        if (d.room_id && !(await acessoOk(env, String(d.room_id).split(":")[0]))) {
          return json({ error: "Atendimento indisponível no momento" }, 402);
        }
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
        if (!(await acessoOk(env, roomId.split(":")[0]))) return json({ error: "Atendimento indisponível no momento" }, 402);
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
