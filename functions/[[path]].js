export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tectop.pages.dev",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  if (request.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Garante que a tabela existe
    await env.DB.prepare(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        room_id TEXT,
        sender TEXT,
        content TEXT,
        type TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `).run();

    // ROTA GET: Carregar mensagens
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const roomId = url.searchParams.get("room_id") || "geral";
      const { results } = await env.DB.prepare(
        "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(roomId).all();

      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // ROTA POST: Enviar mensagem (Texto ou Ficheiro)
    if (url.pathname === "/api/messages" && request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";

      // 1. Processamento de Mensagem de Texto (JSON)
      if (contentType.includes("application/json")) {
        const data = await request.json();
        if (!data.content || data.content.trim() === "") {
          throw new Error("A mensagem não pode estar vazia");
        }

        const id = crypto.randomUUID();
        await env.DB.prepare(
          "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, data.room_id || "geral", data.sender || "Anónimo", data.content, data.type || "text").run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // 2. Processamento de Ficheiro (Imagem/Vídeo/Áudio via FormData)
      if (contentType.includes("multipart/form-data")) {
        const formData = await request.formData();
        const file = formData.get("file");
        const sender = formData.get("sender") || "Anónimo";
        const roomId = formData.get("room_id") || "geral";
        const type = formData.get("type") || "image";

        if (!file) {
          throw new Error("Nenhum ficheiro foi enviado");
        }

        // Gera um nome único para o ficheiro no R2
        const fileName = `uploads/${Date.now()}_${file.name}`;
        
        // Guarda o ficheiro no Balde R2 (MEDIA_BUCKET)
        await env.MEDIA_BUCKET.put(fileName, file.stream(), {
          httpMetadata: { contentType: file.type }
        });

        // URL pública ou endpoint para aceder ao ficheiro
        const fileUrl = `https://tectop.pages.dev/api/files/${fileName}`;
        const id = crypto.randomUUID();

        // Guarda o registo na base de dados D1
        await env.DB.prepare(
          "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, roomId, sender, fileUrl, type).run();

        return new Response(JSON.stringify({ success: true, url: fileUrl }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      throw new Error("Content-Type não suportado");
    }

    // ROTA GET: Servir ficheiros guardados no R2
    if (url.pathname.startsWith("/api/files/")) {
      const key = url.pathname.replace("/api/files/", "");
      const object = await env.MEDIA_BUCKET.get(key);

      if (!object) {
        return new Response("Ficheiro não encontrado", { status: 404, headers: corsHeaders });
      }

      const headers = new Headers(corsHeaders);
      object.writeHttpMetadata(headers);
      headers.set("etag", object.httpEtag);

      return new Response(object.body, { headers });
    }

    return new Response("Rota não encontrada", { status: 404, headers: corsHeaders });

  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
