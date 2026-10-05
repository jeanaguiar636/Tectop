export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Configuração de CORS (para pedidos da API)
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

  // --- ROTA: API /api/messages ---
  if (url.pathname.startsWith("/api/messages")) {
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

      // GET: Carregar histórico
      if (request.method === "GET") {
        const roomId = url.searchParams.get("room_id") || "geral";
        const { results } = await env.DB.prepare(
          "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 50"
        ).bind(roomId).all();

        return new Response(JSON.stringify(results), {
          headers: { "Content-Type": "application/json", ...corsHeaders }
        });
      }

      // POST: Enviar mensagem
      if (request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        
        if (contentType.includes("application/json")) {
            const data = await request.json();
            const id = crypto.randomUUID();
            
            await env.DB.prepare(
              "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
            ).bind(id, data.room_id || "geral", data.sender || "Anónimo", data.content || "", data.type || "text").run();

            return new Response(JSON.stringify({ success: true }), {
              headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        } else {
             throw new Error("Formato de dados inválido. Apenas JSON é suportado.");
        }
      }

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { "Content-Type": "application/json", ...corsHeaders }
      });
    }
  }

  // --- FALLBACK: Servir a aplicação principal ---
  // Se não for um pedido de API, servimos o ficheiro estático (index.html)
  // O Cloudflare Pages trata disto automaticamente se não dermos resposta aqui.
  // No entanto, para garantir, vamos devolver uma resposta vazia com o status 200,
  // permitindo que o Cloudflare Pages sirva o asset estático correspondente ao [[path]].
  
  return context.next(); // Isto diz ao Cloudflare para continuar com o comportamento normal (servir assets)
}
