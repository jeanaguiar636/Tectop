export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Configuração de CORS
  const corsHeaders = {
    "Access-Control-Allow-Origin": "https://tectop.pages.dev",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };

  // Responde ao preflight do CORS
  if (request.method === "OPTIONS") {
    return new Response(null, {
      headers: corsHeaders
    });
  }

  try {
    // --- ROTA: GET /api/messages ---
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const roomId = url.searchParams.get("room_id") || "geral";
      
      // Busca as mensagens mais recentes
      const { results } = await env.DB.prepare(
        "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(roomId).all();

      return new Response(JSON.stringify(results), {
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }

    // --- ROTA: POST /api/messages ---
    if (url.pathname === "/api/messages" && request.method === "POST") {
      const contentType = request.headers.get("content-type") || "";
      
      // Cria a tabela se não existir (boa prática, embora já a tenhamos criado)
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

      if (contentType.includes("application/json")) {
        // Processa mensagem de texto
        const data = await request.json();
        const id = crypto.randomUUID();
        
        await env.DB.prepare(
          "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, data.room_id || "geral", data.sender || "Anónimo", data.content, data.type || "text").run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });

      } else if (contentType.includes("multipart/form-data")) {
        // Processa ficheiro para R2 (isto é para o futuro, mas fica seguro)
        const formData = await request.formData();
        const file = formData.get("file");
        const sender = formData.get("sender") || "Anónimo";
        const roomId = formData.get("room_id") || "geral";
        const key = `uploads/${crypto.randomUUID()}_${file.name}`;
        
        await env.MEDIA_BUCKET.put(key, file.stream());
        const fileUrl = `/api/files/${key}`;

        await env.DB.prepare(
            "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
        ).bind(crypto.randomUUID(), roomId, sender, fileUrl, "image").run();

        return new Response(JSON.stringify({ success: true, url: fileUrl }), {
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }
    }
    
    // --- ROTA: Fallback ---
    // Se o pedido não for /api/messages, devolvemos 404 ou tratamos o ficheiro estático
    // Como o seu `[[path]].js` apanha tudo, vamos devolver um erro amigável se não for a API
    if (!url.pathname.startsWith('/api/')) {
      return new Response("Esta página não existe. Por favor, aceda à página principal.", { 
        status: 404,
        headers: corsHeaders
      });
    }

    return new Response("Rota não encontrada", { 
        status: 404, 
        headers: corsHeaders 
    });

  } catch (err) {
    console.error("Erro no Worker:", err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders }
    });
  }
}
