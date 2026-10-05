export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Listar mensagens de uma sala
      if (url.pathname === "/api/messages" && request.method === "GET") {
        const roomId = url.searchParams.get("room_id") || "geral";
        const { results } = await env.DB.prepare(
          "SELECT * FROM messages WHERE room_id = ? ORDER BY created_at ASC"
        ).bind(roomId).all();
        
        return new Response(JSON.stringify(results), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Enviar nova mensagem ou ficheiro de mídia
      if (url.pathname === "/api/messages" && request.method === "POST") {
        const contentType = request.headers.get("content-type") || "";
        let roomId, sender, content, type = "text";

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData();
          roomId = formData.get("room_id") || "geral";
          sender = formData.get("sender") || "Técnico";
          const file = formData.get("file");

          if (file) {
            const fileName = `${Date.now()}-${file.name}`;
            await env.MEDIA_BUCKET.put(fileName, file.stream(), {
              httpMetadata: { contentType: file.type }
            });
            content = fileName;
            type = file.type.startsWith("image/") ? "image" : "file";
          } else {
            content = formData.get("content") || "";
          }
        } else {
          const body = await request.json();
          roomId = body.room_id || "geral";
          sender = body.sender || "Técnico";
          content = body.content || "";
          type = body.type || "text";
        }

        const id = "msg_" + Date.now() + Math.random().toString(36.substring(2, 7));
        
        await env.DB.prepare(
          "INSERT INTO messages (id, room_id, sender, content, type) VALUES (?, ?, ?, ?, ?)"
        ).bind(id, roomId, sender, content, type).run();

        return new Response(JSON.stringify({ success: true, id }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }

      // Servir ficheiros guardados no R2
      if (url.pathname.startsWith("/api/media/")) {
        const fileName = url.pathname.replace("/api/media/", "");
        const object = await env.MEDIA_BUCKET.get(fileName);

        if (!object) {
          return new Response("Ficheiro não encontrado", { status: 404, headers: corsHeaders });
        }

        const headers = new Headers(corsHeaders);
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);

        return new Response(object.body, { headers });
      }

      return new Response("Endpoint não encontrado", { status: 404, headers: corsHeaders });
    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }
  }
};
