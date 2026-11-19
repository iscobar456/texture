//! OCR (handwriting photo -> LaTeX) through the user's own Anthropic API key.

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::ipc::{InvokeBody, Request};

use crate::{header, user_dir};

/// Models offered in Settings. Anything else is rejected, so the key can't be pointed at an arbitrary model.
const OCR_MODELS: [&str; 3] = ["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"];

const OCR_PROMPT: &str = "\
You are transcribing a photo of handwritten work (a student's homework on paper or a whiteboard) into LaTeX. \
The output is pasted into the body of an existing document that already has amsmath and amssymb loaded.

Output rules:
- Output only the LaTeX body: no preamble, no \\documentclass, no \\begin{document}, no title or \\section unless \
it is written in the photo, and never wrap the answer in Markdown code fences or add any commentary.
- Text is text. Sentences, problem statements and explanations are ordinary paragraphs, not math. Never put \
prose in a math environment or inside \\text{}.
- Put math in $...$ inline. Use a display environment only for equations that are written on their own line: \
\\[ ... \\] for a single one, and align* only for consecutive equations that are visibly aligned or chained \
(for example successive steps of a derivation).
- Reproduce lists and structure: numbered or lettered parts such as (a), (b) become an enumerate with \\item \
(use \\item[(a)] if the labels matter), and bullets become itemize. Separate paragraphs with a blank line.
- Exercise or problem identifiers, such as \"6.12)\", \"Exercise 6.12\", \"Problem 3\" or \"Q4\", go in bold with \\textbf{}, \
for example \\textbf{6.12)} or \\textbf{Exercise 6.12}, starting the paragraph that holds that problem.
- Transcribe faithfully. Keep the writer's wording and notation. Do not solve, correct, complete or reorder anything.
- Leave out crossed-out work. For a diagram or graph, write a one-line comment such as % [diagram: triangle ABC] \
rather than inventing TikZ.
- Mark anything illegible or uncertain with a % UNSURE comment on the line above it, and give your best guess.";

/// Longest custom prompt accepted from Settings (characters).
const OCR_PROMPT_MAX: usize = 4000;

#[tauri::command]
pub fn ocr_default_prompt() -> &'static str {
    OCR_PROMPT
}

/// Models sometimes wrap the answer in ```latex ... ``` despite being told not to; strip one such wrapper.
fn strip_code_fence(text: &str) -> String {
    let t = text.trim();
    if let Some(rest) = t.strip_prefix("```") {
        if let Some(nl) = rest.find('\n') {
            let (lang, body) = rest.split_at(nl);
            if lang.trim().chars().all(|c| c.is_ascii_alphanumeric()) {
                let body = body.trim_start_matches('\n');
                let body = body.trim_end();
                return body.strip_suffix("```").unwrap_or(body).trim().to_string();
            }
        }
    }
    t.to_string()
}

/// Per-account, device-local. Never synced and never sent anywhere except api.anthropic.com.
fn key_file(app: &tauri::AppHandle, user: &str) -> Result<PathBuf, String> {
    Ok(user_dir(app, user)?.join(".api_key"))
}

/// Like `write_atomic`, but the file is owner-only from the moment it exists.
fn write_secret(path: &std::path::Path, data: &str) -> Result<(), String> {
    use std::io::Write;
    let tmp = path.with_file_name(".api_key.tmp");
    let mut opts = fs::OpenOptions::new();
    opts.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        opts.mode(0o600);
    }
    let mut f = opts.open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(data.as_bytes()).map_err(|e| e.to_string())?;
    f.sync_all().map_err(|e| e.to_string())?;
    fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn read_key(app: &tauri::AppHandle, user: &str) -> Result<String, String> {
    fs::read_to_string(key_file(app, user)?)
        .map(|k| k.trim().to_string())
        .ok()
        .filter(|k| !k.is_empty())
        .ok_or_else(|| "No API key set. Add one in Settings → OCR.".to_string())
}

/// Saves the key, or removes it when `key` is empty. The key is never returned to the frontend.
#[tauri::command]
pub fn set_api_key(app: tauri::AppHandle, user: String, key: String) -> Result<(), String> {
    let path = key_file(&app, &user)?;
    let key = key.trim();
    if key.is_empty() {
        let _ = fs::remove_file(path);
        return Ok(());
    }
    if key.len() > 300 || !key.is_ascii() || key.contains(char::is_whitespace) {
        return Err("That doesn't look like an API key.".into());
    }
    write_secret(&path, key)
}

#[tauri::command]
pub fn has_api_key(app: tauri::AppHandle, user: String) -> Result<bool, String> {
    Ok(key_file(&app, &user)?.is_file())
}

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| e.to_string())
}

/// Pulls Anthropic's error message out of a failed response.
async fn api_error(resp: reqwest::Response) -> String {
    let status = resp.status();
    let body: serde_json::Value = resp.json().await.unwrap_or_default();
    let msg = body["error"]["message"].as_str().unwrap_or("request failed");
    match status.as_u16() {
        401 => "The API key was rejected (401). Check it in Settings → OCR.".into(),
        429 => format!("Rate limited or out of credit (429): {msg}"),
        _ => format!("Anthropic API error ({status}): {msg}"),
    }
}

/// Checks the key with a free call (list models), so no tokens are spent.
#[tauri::command]
pub async fn test_api_key(app: tauri::AppHandle, user: String) -> Result<(), String> {
    let key = read_key(&app, &user)?;
    let resp = http()?
        .get("https://api.anthropic.com/v1/models?limit=1")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .send()
        .await
        .map_err(|e| format!("Could not reach Anthropic: {e}"))?;
    if resp.status().is_success() { Ok(()) } else { Err(api_error(resp).await) }
}

#[derive(Serialize)]
pub struct OcrResult {
    latex: String,
    input_tokens: u64,
    output_tokens: u64,
    stop_reason: String,
}

/// Raw body is a JPEG; headers x-user and x-model say whose key and which model.
#[tauri::command]
pub async fn ocr_image(app: tauri::AppHandle, request: Request<'_>) -> Result<OcrResult, String> {
    use base64::Engine;
    // Copy everything out of the request first, so nothing borrowed is held across an await.
    let (user, model) = (header(&request, "x-user")?, header(&request, "x-model")?);
    let InvokeBody::Raw(bytes) = request.body() else {
        return Err("expected raw body".into());
    };
    let image = base64::engine::general_purpose::STANDARD.encode(bytes);
    if !OCR_MODELS.contains(&model.as_str()) {
        return Err(format!("unknown model {model:?}"));
    }
    let key = read_key(&app, &user)?;
    // Optional custom prompt from Settings, base64-encoded because header values can't hold newlines.
    let prompt = match request.headers().get("x-prompt").and_then(|v| v.to_str().ok()) {
        Some(b64) if !b64.is_empty() => {
            let raw = base64::engine::general_purpose::STANDARD.decode(b64).map_err(|e| e.to_string())?;
            let text = String::from_utf8(raw).map_err(|e| e.to_string())?;
            if text.chars().count() > OCR_PROMPT_MAX {
                return Err(format!("The OCR prompt is longer than {OCR_PROMPT_MAX} characters."));
            }
            if text.trim().is_empty() { OCR_PROMPT.to_string() } else { text }
        }
        _ => OCR_PROMPT.to_string(),
    };

    let body = serde_json::json!({
        "model": model,
        "max_tokens": 8192,
        // Transcription needs little reasoning; thinking tokens are billed as output.
        "output_config": { "effort": "low" },
        "messages": [{
            "role": "user",
            "content": [
                { "type": "image", "source": { "type": "base64", "media_type": "image/jpeg", "data": image } },
                { "type": "text", "text": prompt }
            ]
        }]
    });
    let resp = http()?
        .post("https://api.anthropic.com/v1/messages")
        .header("x-api-key", key)
        .header("anthropic-version", "2023-06-01")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("Could not reach Anthropic: {e}"))?;
    if !resp.status().is_success() {
        return Err(api_error(resp).await);
    }
    let j: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;
    let stop_reason = j["stop_reason"].as_str().unwrap_or("").to_string();
    if stop_reason == "refusal" {
        return Err("The model declined to transcribe this image.".into());
    }
    let latex = j["content"]
        .as_array()
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b["type"] == "text")
                .filter_map(|b| b["text"].as_str())
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(OcrResult {
        latex: strip_code_fence(&latex),
        input_tokens: j["usage"]["input_tokens"].as_u64().unwrap_or(0),
        output_tokens: j["usage"]["output_tokens"].as_u64().unwrap_or(0),
        stop_reason,
    })
}

#[cfg(test)]
mod tests {
    use super::strip_code_fence;

    #[test]
    fn strips_fences() {
        assert_eq!(strip_code_fence("```latex\nx = 1\n```"), "x = 1");
        assert_eq!(strip_code_fence("```\nx\ny\n```\n"), "x\ny");
        assert_eq!(strip_code_fence("  plain $x$ text "), "plain $x$ text");
        assert_eq!(strip_code_fence("```latex\nx = 1"), "x = 1");
    }
}
