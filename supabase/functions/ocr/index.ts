// Edge function: downloads a photo as the calling user and asks a vision model for LaTeX.
// Requires secrets: ANTHROPIC_API_KEY. The API key never ships in the apps.
import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const auth = req.headers.get("Authorization") ?? "";
  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_ANON_KEY")!, {
    global: { headers: { Authorization: auth } },
  });
  const { photo_id } = await req.json();
  const { data: photo, error } = await sb.from("photos").select("*").eq("id", photo_id).single();
  if (error) return new Response(error.message, { status: 404 });
  const { data: blob, error: dErr } = await sb.storage.from("photos").download(photo.storage_path);
  if (dErr) return new Response(dErr.message, { status: 500 });

  const b64 = btoa(String.fromCharCode(...new Uint8Array(await blob.arrayBuffer())));
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": Deno.env.get("ANTHROPIC_API_KEY")!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-5-5",
      max_tokens: 4096,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: blob.type || "image/jpeg", data: b64 } },
          { type: "text", text: "Transcribe this handwritten work into LaTeX. Output only the LaTeX body (no preamble), using align* for multi-line math. Mark illegible parts with %UNSURE comments." },
        ],
      }],
    }),
  });
  const j = await r.json();
  const latex = j.content?.[0]?.text ?? "";
  await sb.from("photos").update({ ocr_latex: latex }).eq("id", photo_id);
  return Response.json({ latex });
});
