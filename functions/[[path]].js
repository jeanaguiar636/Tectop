export async function onRequest(context) {
    const { request, env } = context;
    const url = new URL(request.url);

    // Configuração de CORS para permitir pedidos do seu site
    const corsHeaders = {
        "Access-Control-Allow-Origin": "https://tectop.pages.dev",
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
    };

    // Responde ao pedido OPTIONS (preflight do CORS)
    if (request.method === "OPTIONS") {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        // Garante que a tabela existe (cria apenas se não existir)
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

        // ROTA GET /api/messages: Carrega o histórico
        if (request.method === "GET" && url.pathname === "/api/messages") {
            const roomId = url.searchParams.get("room_id") || "geral";

            const { results } = await env.DB.prepare(
                "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 50"
            ).bind(roomId).all();

            return new Response(JSON.stringify(results), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // ROTA POST /api/messages: Envia uma nova mensagem de texto
        if (request.method === "POST" && url.pathname === "/api/messages") {
            const contentType = request.headers.get("content-type") || "";

            if (!contentType.includes("application/json")) {
                throw new Error("O Content-Type deve ser application/json");
            }

            const data = await request.json();

            if (!data.content || data.content.trim() === "") {
                throw new Error("O conteúdo da mensagem não pode estar vazio");
            }

            const id = crypto.randomUUID();
            const sender = data.sender || "Anónimo";
            const roomId = data.room_id || "geral";
            const type = data.type || "text";

            await env.DB.prepare(
                "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
            ).bind(id, roomId, sender, data.content, type).run();

            return new Response(JSON.stringify({ success: true }), {
                headers: { "Content-Type": "application/json", ...corsHeaders }
            });
        }

        // Se não for GET nem POST para /api/messages
        return new Response("Rota não encontrada", {
            status: 404,
            headers: corsHeaders
        });

    } catch (err) {
        // Captura qualquer erro e devolve-o em formato JSON (evita o erro do navegador)
        return new Response(JSON.stringify({ error: err.message }), {
            status: 500,
            headers: { "Content-Type": "application/json", ...corsHeaders }
        });
    }
}
