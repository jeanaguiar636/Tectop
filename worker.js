export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS headers para permitir requisições do seu frontend Pages
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 1. Endpoint para carregar o histórico de mensagens
    if (url.pathname === "/api/messages" && request.method === "GET") {
      const roomId = url.searchParams.get("room_id") || "geral";
      const { results } = await env.DB.prepare(
        "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC LIMIT 100"
      ).bind(roomId).all();

      return new Response(JSON.stringify(results), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Endpoint para Upload de Mídia (Imagens, Áudios, Vídeos) para o R2
    if (url.pathname === "/api/upload" && request.method === "POST") {
      const formData = await request.formData();
      const file = formData.get("file");
      const roomId = formData.get("room_id");
      const sender = formData.get("sender");
      const type = formData.get("type"); // image, audio, video

      if (!file) {
        return new Response(JSON.stringify({ error: "Ficheiro não encontrado" }), {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const fileName = `${Date.now()}-${file.name}`;
      await env.TECTOP_BUCKET.put(fileName, file.stream());

      // URL pública do R2 (ou custom domain configurado no bucket)
      const fileUrl = `https://seu-bucket.sua-conta.r2.cloudflarestorage.com/${fileName}`; 
      // Nota: Recomenda-se usar um domínio personalizado ou worker para servir os assets do R2 com facilidade.

      // Salvar referência no D1
      const id = crypto.randomUUID();
      await env.DB.prepare(
        "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
      ).bind(id, roomId, sender, fileUrl, type).run();

      return new Response(JSON.stringify({ success: true, url: fileUrl }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    return new Response("Tectop Cloudflare Backend Ativo!", { headers: corsHeaders });
  },
};