export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ROTA GET: Carregar mensagens do Banco D1
    if (url.pathname === '/api/messages' && request.method === 'GET') {
      try {
        const { results } = await env.DB.prepare(
          "SELECT * FROM messages ORDER BY id DESC LIMIT 50"
        ).all();
        return new Response(JSON.stringify(results), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ROTA POST: Enviar mensagem de texto para o D1
    if (url.pathname === '/api/messages' && request.method === 'POST') {
      try {
        const data = await request.json();
        await env.DB.prepare(
          "INSERT INTO messages (room_id, sender, content, type, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(data.room_id, data.sender, data.content, data.type, new Date().toISOString()).run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    // ROTA POST: Enviar arquivo/foto para o Cloudflare R2 e salvar no D1
    if (url.pathname === '/api/upload' && request.method === 'POST') {
      try {
        const formData = await request.formData();
        const file = formData.get('file');
        const sender = formData.get('sender');
        const room_id = formData.get('room_id');

        if (!file) {
          return new Response(JSON.stringify({ error: 'Nenhum ficheiro enviado' }), { status: 400 });
        }

        const fileName = `uploads/${Date.now()}-${file.name}`;
        
        // Salva no Bucket R2
        await env.MEU_BUCKET.put(fileName, file.stream(), {
          httpMetadata: { contentType: file.type }
        });

        // Gera a URL pública do R2 (se configurado domínio customizado ou R2.dev)
        const fileUrl = `https://seu-bucket.suaconta.r2.dev/${fileName}`; 
        // Dica: ajuste "seu-bucket.suaconta.r2.dev" para a URL pública do seu R2

        // Salva a referência da imagem no banco D1
        await env.DB.prepare(
          "INSERT INTO messages (room_id, sender, content, type, created_at) VALUES (?, ?, ?, ?, ?)"
        ).bind(room_id, sender, fileUrl, 'image', new Date().toISOString()).run();

        return new Response(JSON.stringify({ success: true, url: fileUrl }), {
          headers: { 'Content-Type': 'application/json' }
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500 });
      }
    }

    return new Response('Endpoint não encontrado', { status: 404 });
  }
};
