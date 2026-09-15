//! Tauri surface over the Host carrier: the invoke commands the webview's
//! transport hooks call, and the `dsh-app://` handler that serves renderer
//! assets and API responses from the Host over its framed streams.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use serde::Deserialize;
use tauri::ipc::{Channel, InvokeBody, InvokeResponseBody, Request};
use tauri::{AppHandle, Manager, State};

use crate::host::client::HostClient;
use crate::host::frame::{ResponseFrame, PIPE_CHUNK_BYTES};
use crate::supervisor::boot_log;

/// Logs the first renderer request once, which is how a development run proves
/// the invoke carrier reached the Host.
static FIRST_REQUEST: AtomicBool = AtomicBool::new(true);

/// Shell-wide Host carrier; absent until the packaged runtime boots and after a
/// failure, so every command reports unavailability instead of panicking.
#[derive(Default)]
pub struct HostState {
    client: Mutex<Option<Arc<HostClient>>>,
}

impl HostState {
    /// Publish the running Host.
    pub fn install(&self, client: Arc<HostClient>) {
        *self.client.lock().unwrap() = Some(client);
    }

    /// Drop the running Host; the caller owns its teardown.
    pub fn take(&self) -> Option<Arc<HostClient>> {
        self.client.lock().unwrap().take()
    }

    /// The running Host, when one is available.
    pub fn client(&self) -> Option<Arc<HostClient>> {
        self.client.lock().unwrap().clone()
    }
}

/// Arguments of one request the renderer opens.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RequestStart {
    /// Request URL; the Host routes on its path.
    pub url: String,
    /// HTTP method in upper case.
    pub method: String,
    /// Request headers in order.
    pub headers: Vec<(String, String)>,
    /// Whether the renderer sends body frames before the end frame.
    pub has_body: bool,
}

/// The running Host for the invoke commands to use.
fn client(state: &State<'_, HostState>) -> Result<Arc<HostClient>, String> {
    state.client().ok_or_else(|| "the dsh Host is not running".to_string())
}

/**
 * Open one request stream and stream its response frames to the renderer.
 * @param state - shell-wide Host carrier.
 * @param args - request metadata.
 * @param on_frame - channel receiving the response frames.
 * @returns the stream id used by the body, end, and cancel commands.
 */
#[tauri::command]
pub fn dsh_request_start(
    state: State<'_, HostState>,
    args: RequestStart,
    on_frame: Channel<InvokeResponseBody>,
) -> Result<u32, String> {
    let client = client(&state)?;
    if FIRST_REQUEST.swap(false, Ordering::Relaxed) {
        boot_log(&format!("first renderer request: {} {}", args.method, args.url));
    }
    let (stream_id, frames) = client.open(&args.url, &args.method, &args.headers, args.has_body)?;
    let forwarding = Arc::clone(&client);
    std::thread::spawn(move || {
        for frame in frames {
            let outcome = match frame {
                ResponseFrame::Start { status, headers, has_body, .. } => on_frame.send(
                    serde_json::json!({
                        "kind": "start",
                        "status": status,
                        "headers": headers,
                        "hasBody": has_body,
                    })
                    .to_string()
                    .into(),
                ),
                ResponseFrame::Data { data, .. } => on_frame.send(InvokeResponseBody::Raw(data)),
                ResponseFrame::End { .. } => {
                    on_frame.send(serde_json::json!({ "kind": "end" }).to_string().into())
                }
                ResponseFrame::Error { message, .. } => on_frame.send(
                    serde_json::json!({ "kind": "error", "message": message })
                        .to_string()
                        .into(),
                ),
                ResponseFrame::Event(_) | ResponseFrame::ControlResult { .. } => continue,
            };
            if outcome.is_err() {
                // The renderer stopped reading; release the Host's stream too.
                forwarding.cancel(stream_id);
                return;
            }
        }
        forwarding.release(stream_id);
    });
    Ok(stream_id)
}

/**
 * Write one raw request body; the stream id rides the `x-dsh-stream` header so
 * the body stays a single unencoded IPC payload.
 * @param state - shell-wide Host carrier.
 * @param request - the raw body plus the stream header.
 * @returns the transport failure, when the body cannot be delivered.
 */
#[tauri::command]
pub fn dsh_request_body(state: State<'_, HostState>, request: Request<'_>) -> Result<(), String> {
    let client = client(&state)?;
    let stream_id = request
        .headers()
        .get("x-dsh-stream")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.parse::<u32>().ok())
        .ok_or("dsh_request_body requires the x-dsh-stream header")?;
    match request.body() {
        InvokeBody::Raw(bytes) => {
            for chunk in bytes.chunks(PIPE_CHUNK_BYTES) {
                client.write_body(stream_id, chunk)?;
            }
            Ok(())
        }
        InvokeBody::Json(_) => Err("dsh_request_body expects a raw byte body".into()),
    }
}

/**
 * Complete the request body of one stream.
 * @param state - shell-wide Host carrier.
 * @param stream_id - stream returned by the start command.
 * @returns the transport failure, when the frame cannot be queued.
 */
#[tauri::command]
pub fn dsh_request_end(state: State<'_, HostState>, stream_id: u32) -> Result<(), String> {
    client(&state)?.end_body(stream_id)
}

/**
 * Cancel one request and release its response stream.
 * @param state - shell-wide Host carrier.
 * @param stream_id - stream returned by the start command.
 * @returns the transport failure, when the frame cannot be queued.
 */
#[tauri::command]
pub fn dsh_request_cancel(state: State<'_, HostState>, stream_id: u32) -> Result<(), String> {
    client(&state)?.cancel(stream_id);
    Ok(())
}

/**
 * Serve one `dsh-app://` request from the Host with a buffered response body.
 *
 * Renderer assets and API responses arrive on the same carrier; this handler is
 * the only place that materializes a whole body, which is why streams use the
 * invoke commands instead.
 * @param app - shell handle carrying the Host state.
 * @param request - the webview's request.
 * @returns the response the webview renders.
 */
pub fn buffered_fetch(
    app: &AppHandle,
    request: &tauri::http::Request<Vec<u8>>,
) -> tauri::http::Response<Vec<u8>> {
    let Some(client) = app.state::<HostState>().client() else {
        return failure(503, "the dsh Host is not running");
    };
    let method = request.method().as_str().to_uppercase();
    let headers: Vec<(String, String)> = request
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.as_str().to_string(),
                value.to_str().unwrap_or_default().to_string(),
            )
        })
        .collect();
    let has_body = !matches!(method.as_str(), "GET" | "HEAD") && !request.body().is_empty();
    let (stream_id, frames) = match client.open(request.uri().to_string().as_str(), &method, &headers, has_body) {
        Ok(open) => open,
        Err(error) => return failure(503, &error),
    };
    if has_body {
        if let Err(error) = write_all(&client, stream_id, request.body()) {
            client.cancel(stream_id);
            return failure(502, &error);
        }
    }
    let mut status = 200u16;
    let mut response_headers: Vec<(String, String)> = Vec::new();
    let mut body: Vec<u8> = Vec::new();
    let mut started = false;
    for frame in frames {
        match frame {
            ResponseFrame::Start { status: code, headers, .. } => {
                status = code;
                response_headers = headers;
                started = true;
            }
            ResponseFrame::Data { data, .. } => body.extend_from_slice(&data),
            ResponseFrame::End { .. } => {
                client.release(stream_id);
                return respond(status, &response_headers, body);
            }
            ResponseFrame::Error { message, .. } => {
                client.release(stream_id);
                return failure(502, &message);
            }
            ResponseFrame::Event(_) | ResponseFrame::ControlResult { .. } => {}
        }
    }
    if started {
        failure(502, "the dsh Host ended the response without completing it")
    } else {
        failure(502, "the dsh Host did not answer the request")
    }
}

fn write_all(client: &HostClient, stream_id: u32, body: &[u8]) -> Result<(), String> {
    for chunk in body.chunks(PIPE_CHUNK_BYTES) {
        client.write_body(stream_id, chunk)?;
    }
    client.end_body(stream_id)
}

fn respond(
    status: u16,
    headers: &[(String, String)],
    body: Vec<u8>,
) -> tauri::http::Response<Vec<u8>> {
    let mut builder = tauri::http::Response::builder().status(status);
    for (name, value) in headers {
        builder = builder.header(name, value);
    }
    builder
        .body(body)
        .unwrap_or_else(|_| failure(500, "the dsh Host sent an unusable response header"))
}

fn failure(status: u16, message: &str) -> tauri::http::Response<Vec<u8>> {
    tauri::http::Response::builder()
        .status(status)
        .header("content-type", "text/plain; charset=utf-8")
        .body(message.as_bytes().to_vec())
        .expect("a plain text body is a valid response")
}
