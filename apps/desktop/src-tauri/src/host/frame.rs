//! Frame codec for the desktop Host carrier.
//!
//! The bytes are interchangeable with `apps/desktop-host/src/wire.ts` and
//! `apps/desktop/src/host-protocol.ts`; `apps/desktop-host/fixtures/wire-vectors.json`
//! is the shared golden copy every implementation is checked against.

use serde_json::Value;

/// Protocol version carried by the readiness event.
pub const PROTOCOL_VERSION: u32 = 3;
/// Maximum raw body bytes carried by one data frame.
pub const PIPE_CHUNK_BYTES: usize = 64 * 1024;
/// Largest JSON payload a control or metadata frame may carry.
const MAX_CONTROL_PAYLOAD_BYTES: usize = 1024 * 1024;

const MAGIC: u32 = 0x4453_4833;
const HEADER_BYTES: usize = 13;

const REQUEST_START: u8 = 1;
const REQUEST_DATA: u8 = 2;
const REQUEST_END: u8 = 3;
const REQUEST_CANCEL: u8 = 4;
const REQUEST_CONTROL: u8 = 5;

const RESPONSE_START: u8 = 1;
const RESPONSE_DATA: u8 = 2;
const RESPONSE_END: u8 = 3;
const RESPONSE_ERROR: u8 = 4;
const RESPONSE_EVENT: u8 = 5;
const RESPONSE_CONTROL_RESULT: u8 = 6;

/// Lifecycle facts published by the Host on the response stream.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResponseEvent {
    /// The composition is active and the Host can serve requests.
    Ready {
        /// Protocol version the Host implements.
        protocol_version: u32,
        /// Installed dsh version the Host composed.
        dsh_version: String,
    },
    /// The Host cannot serve; the message is operator-facing.
    Fatal {
        /// Failure text reported by the Host.
        message: String,
    },
}

/// One decoded response frame.
#[derive(Debug, Clone, PartialEq)]
pub enum ResponseFrame {
    /// Response metadata preceding an optional body.
    Start {
        /// Request stream this response belongs to.
        stream_id: u32,
        /// HTTP status code.
        status: u16,
        /// Response headers in arrival order.
        headers: Vec<(String, String)>,
        /// Whether data frames follow.
        has_body: bool,
    },
    /// One bounded raw response-body chunk.
    Data {
        /// Request stream this chunk belongs to.
        stream_id: u32,
        /// Raw body bytes.
        data: Vec<u8>,
    },
    /// Normal completion of one stream.
    End {
        /// Completed request stream.
        stream_id: u32,
    },
    /// One stream failed; the message is operator-facing.
    Error {
        /// Failed request stream.
        stream_id: u32,
        /// Failure text reported by the Host.
        message: String,
    },
    /// Lifecycle event; it carries no stream.
    Event(ResponseEvent),
    /// Answer to one control command.
    ControlResult {
        /// Control id the command was sent with.
        id: u32,
        /// Whether the command succeeded.
        ok: bool,
        /// Command result payload, when the command returns one.
        value: Option<Value>,
        /// Failure text when `ok` is false.
        message: Option<String>,
    },
}

fn encode_frame(kind: u8, id: u32, payload: &[u8]) -> Vec<u8> {
    let limit = if kind == REQUEST_DATA { PIPE_CHUNK_BYTES } else { MAX_CONTROL_PAYLOAD_BYTES };
    assert!(payload.len() <= limit, "dsh desktop: request frame payload exceeds its limit");
    let mut frame = Vec::with_capacity(HEADER_BYTES + payload.len());
    frame.extend_from_slice(&MAGIC.to_be_bytes());
    frame.push(kind);
    frame.extend_from_slice(&id.to_be_bytes());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(payload);
    frame
}

/// Encode the metadata opening one request stream.
/// @param stream_id - 1-based request id that the response frames repeat.
/// @param url - request URL the Host routes on its path.
/// @param method - HTTP method in upper case.
/// @param headers - request headers in order.
/// @param has_body - whether data frames follow before the end frame.
/// @returns the framed bytes to write to the request stream.
pub fn encode_request_start(
    stream_id: u32,
    url: &str,
    method: &str,
    headers: &[(String, String)],
    has_body: bool,
) -> Vec<u8> {
    let value = serde_json::json!({ "url": url, "method": method, "headers": headers, "hasBody": has_body });
    encode_frame(REQUEST_START, stream_id, value.to_string().as_bytes())
}

/// Encode one bounded raw request-body chunk.
/// @param stream_id - request stream the chunk belongs to.
/// @param data - raw body bytes; callers split at [`PIPE_CHUNK_BYTES`].
/// @returns the framed bytes to write to the request stream.
pub fn encode_request_data(stream_id: u32, data: &[u8]) -> Vec<u8> {
    encode_frame(REQUEST_DATA, stream_id, data)
}

/// Encode normal request-body completion.
/// @param stream_id - request stream to complete.
/// @returns the framed bytes to write to the request stream.
pub fn encode_request_end(stream_id: u32) -> Vec<u8> {
    encode_frame(REQUEST_END, stream_id, &[])
}

/// Encode cancellation of one request and its response.
/// @param stream_id - request stream to cancel.
/// @returns the framed bytes to write to the request stream.
pub fn encode_request_cancel(stream_id: u32) -> Vec<u8> {
    encode_frame(REQUEST_CANCEL, stream_id, &[])
}

/// Encode one control command; the id correlates the Host's answer.
/// @param id - 1-based control id.
/// @param command - command name the Host dispatches.
/// @returns the framed bytes to write to the request stream.
pub fn encode_request_control(id: u32, command: &str) -> Vec<u8> {
    let value = serde_json::json!({ "command": command });
    encode_frame(REQUEST_CONTROL, id, value.to_string().as_bytes())
}

/// Incremental decoder for the Host response stream.
#[derive(Default)]
pub struct ResponseDecoder {
    buffer: Vec<u8>,
}

impl ResponseDecoder {
    /**
     * Append bytes and return every complete frame.
     * @param chunk - next bytes read from the response stream.
     * @returns frames in arrival order, or the framing failure.
     */
    pub fn push(&mut self, chunk: &[u8]) -> Result<Vec<ResponseFrame>, String> {
        self.buffer.extend_from_slice(chunk);
        let mut frames = Vec::new();
        loop {
            match self.next()? {
                Some(frame) => frames.push(frame),
                None => return Ok(frames),
            }
        }
    }

    /// Reject a stream that ended inside a frame.
    /// @returns the framing failure, when one is present.
    pub fn finish(&self) -> Result<(), String> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err("dsh desktop: response stream ended inside a frame".into())
        }
    }

    fn next(&mut self) -> Result<Option<ResponseFrame>, String> {
        if self.buffer.len() < HEADER_BYTES {
            return Ok(None);
        }
        let magic = u32::from_be_bytes(self.buffer[0..4].try_into().unwrap());
        if magic != MAGIC {
            return Err("dsh desktop: invalid response frame marker".into());
        }
        let kind = self.buffer[4];
        let id = u32::from_be_bytes(self.buffer[5..9].try_into().unwrap());
        let length = u32::from_be_bytes(self.buffer[9..13].try_into().unwrap()) as usize;
        let limit = if kind == RESPONSE_DATA { PIPE_CHUNK_BYTES } else { MAX_CONTROL_PAYLOAD_BYTES };
        if length > limit {
            return Err(format!("dsh desktop: response frame exceeds the {limit}-byte limit"));
        }
        if self.buffer.len() < HEADER_BYTES + length {
            return Ok(None);
        }
        let payload = self.buffer[HEADER_BYTES..HEADER_BYTES + length].to_vec();
        self.buffer.drain(..HEADER_BYTES + length);
        parse_frame(kind, id, payload, length).map(Some)
    }
}

fn parse_frame(kind: u8, id: u32, payload: Vec<u8>, length: usize) -> Result<ResponseFrame, String> {
    match kind {
        RESPONSE_START => {
            if id == 0 {
                return Err("dsh desktop: response start frame carried the event id".into());
            }
            let value = parse_json(&payload, "start")?;
            let status = value.get("status").and_then(Value::as_u64)
                .ok_or("dsh desktop: invalid response start payload")?;
            let headers = parse_headers(value.get("headers"))?;
            let has_body = value.get("hasBody").and_then(Value::as_bool)
                .ok_or("dsh desktop: invalid response start payload")?;
            if !(100..=599).contains(&status) {
                return Err("dsh desktop: invalid response start payload".into());
            }
            Ok(ResponseFrame::Start { stream_id: id, status: status as u16, headers, has_body })
        }
        RESPONSE_DATA => {
            if id == 0 {
                return Err("dsh desktop: response data frame carried the event id".into());
            }
            Ok(ResponseFrame::Data { stream_id: id, data: payload })
        }
        RESPONSE_END => {
            assert_bare(id, length, "end")?;
            Ok(ResponseFrame::End { stream_id: id })
        }
        RESPONSE_ERROR => {
            if id == 0 {
                return Err("dsh desktop: response error frame carried the event id".into());
            }
            let value = parse_json(&payload, "error")?;
            let message = value.get("message").and_then(Value::as_str)
                .ok_or("dsh desktop: invalid response error payload")?;
            Ok(ResponseFrame::Error { stream_id: id, message: message.to_string() })
        }
        RESPONSE_EVENT => {
            if id != 0 {
                return Err("dsh desktop: response event carried a stream id".into());
            }
            let value = parse_json(&payload, "event")?;
            parse_event(&value).map(ResponseFrame::Event)
        }
        RESPONSE_CONTROL_RESULT => {
            if id == 0 {
                return Err("dsh desktop: response control result carried the event id".into());
            }
            let value = parse_json(&payload, "control result")?;
            let ok = value.get("ok").and_then(Value::as_bool)
                .ok_or("dsh desktop: invalid response control result payload")?;
            Ok(ResponseFrame::ControlResult {
                id,
                ok,
                value: value.get("value").cloned(),
                message: value.get("message").and_then(Value::as_str).map(str::to_string),
            })
        }
        other => Err(format!("dsh desktop: unknown response frame type {other}")),
    }
}

fn assert_bare(id: u32, length: usize, subject: &str) -> Result<(), String> {
    if id == 0 {
        return Err(format!("dsh desktop: response {subject} frame carried the event id"));
    }
    if length != 0 {
        return Err(format!("dsh desktop: response {subject} frame carried a payload"));
    }
    Ok(())
}

fn parse_event(value: &Value) -> Result<ResponseEvent, String> {
    match value.get("event").and_then(Value::as_str) {
        Some("ready") => {
            let protocol_version = value.get("protocolVersion").and_then(Value::as_u64)
                .ok_or("dsh desktop: invalid Host readiness event")?;
            let dsh_version = value.get("dshVersion").and_then(Value::as_str)
                .ok_or("dsh desktop: invalid Host readiness event")?;
            if protocol_version != u64::from(PROTOCOL_VERSION) {
                return Err(format!(
                    "dsh desktop: Host speaks protocol {protocol_version}, this shell speaks {PROTOCOL_VERSION}"
                ));
            }
            Ok(ResponseEvent::Ready { protocol_version: protocol_version as u32, dsh_version: dsh_version.to_string() })
        }
        Some("fatal") => {
            let message = value.get("message").and_then(Value::as_str)
                .ok_or("dsh desktop: invalid Host fatal event")?;
            Ok(ResponseEvent::Fatal { message: message.to_string() })
        }
        other => Err(format!("dsh desktop: unknown Host lifecycle event {other:?}")),
    }
}

fn parse_json(payload: &[u8], subject: &str) -> Result<Value, String> {
    serde_json::from_slice(payload)
        .map_err(|error| format!("dsh desktop: response {subject} payload is not JSON: {error}"))
}

fn parse_headers(value: Option<&Value>) -> Result<Vec<(String, String)>, String> {
    let rows = value.and_then(Value::as_array).ok_or("dsh desktop: invalid response headers")?;
    rows.iter()
        .map(|row| {
            let pair = row.as_array().ok_or("dsh desktop: invalid response header row")?;
            match (pair.first().and_then(Value::as_str), pair.get(1).and_then(Value::as_str)) {
                (Some(name), Some(value)) => Ok((name.to_string(), value.to_string())),
                _ => Err("dsh desktop: invalid response header row".to_string()),
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURE: &str = include_str!("../../tests/fixtures/host-wire-vectors.json");

    fn vectors() -> Vec<Value> {
        let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(fixture["protocolVersion"].as_u64(), Some(u64::from(PROTOCOL_VERSION)));
        fixture["vectors"].as_array().unwrap().clone()
    }

    fn vector(name: &str, direction: &str) -> Value {
        vectors()
            .into_iter()
            .find(|vector| vector["name"].as_str() == Some(name) && vector["direction"].as_str() == Some(direction))
            .expect("fixture vector is present")
    }

    #[test]
    fn encodes_every_request_vector_byte_identically() {
        for vector in vectors().iter().filter(|vector| vector["direction"] == "request") {
            let decoded = &vector["decoded"];
            let bytes = match decoded["type"].as_str().unwrap() {
                "start" => {
                    let headers: Vec<(String, String)> = decoded["headers"].as_array().unwrap().iter()
                        .map(|row| (
                            row[0].as_str().unwrap().to_string(),
                            row[1].as_str().unwrap().to_string(),
                        ))
                        .collect();
                    encode_request_start(
                        7,
                        decoded["url"].as_str().unwrap(),
                        decoded["method"].as_str().unwrap(),
                        &headers,
                        decoded["hasBody"].as_bool().unwrap(),
                    )
                }
                "data" => {
                    let raw = base64_decode(decoded["dataBase64"].as_str().unwrap());
                    encode_request_data(7, &raw)
                }
                "end" => encode_request_end(7),
                "cancel" => encode_request_cancel(7),
                "control" => encode_request_control(decoded["id"].as_u64().unwrap() as u32, decoded["command"].as_str().unwrap()),
                other => panic!("unexpected request vector type {other}"),
            };
            assert_eq!(hex(&bytes), vector["hex"].as_str().unwrap(), "vector {}", vector["name"]);
        }
    }

    #[test]
    fn decodes_every_response_vector() {
        for vector in vectors().iter().filter(|vector| vector["direction"] == "response") {
            let bytes = hex_decode(vector["hex"].as_str().unwrap());
            let mut decoder = ResponseDecoder::default();
            let frames = decoder.push(&bytes).unwrap();
            assert_eq!(frames.len(), 1, "vector {}", vector["name"]);
            decoder.finish().unwrap();
        }
    }

    #[test]
    fn decodes_vectors_delivered_in_odd_chunks() {
        for vector in vectors().iter().filter(|vector| vector["direction"] == "response") {
            let bytes = hex_decode(vector["hex"].as_str().unwrap());
            let mut decoder = ResponseDecoder::default();
            let mut frames = Vec::new();
            for chunk in bytes.chunks(7) {
                frames.extend(decoder.push(chunk).unwrap());
            }
            decoder.finish().unwrap();
            assert_eq!(frames.len(), 1, "vector {}", vector["name"]);
        }
    }

    #[test]
    fn reports_the_readiness_facts_and_rejects_another_protocol() {
        let ready = vector("response.event.ready", "response");
        let bytes = hex_decode(ready["hex"].as_str().unwrap());
        let mut decoder = ResponseDecoder::default();
        assert_eq!(
            decoder.push(&bytes).unwrap(),
            vec![ResponseFrame::Event(ResponseEvent::Ready {
                protocol_version: 3,
                dsh_version: "0.1.5-rc.2".to_string(),
            })],
        );

        let mut decoder = ResponseDecoder::default();
        let incompatible = serde_json::json!({
            "event": "ready", "protocolVersion": 4, "dshVersion": "0.1.5-rc.2",
        });
        let frame = encode_frame(RESPONSE_EVENT, 0, incompatible.to_string().as_bytes());
        assert!(decoder.push(&frame).unwrap_err().contains("this shell speaks 3"));
    }

    #[test]
    fn rejects_a_corrupted_stream() {
        let mut decoder = ResponseDecoder::default();
        assert!(decoder.push(&[0u8; 13]).unwrap_err().contains("invalid response frame marker"));
        let mut decoder = ResponseDecoder::default();
        decoder.push(&[0x44, 0x53, 0x48, 0x33, 1, 0, 0, 0]).unwrap();
        assert!(decoder.finish().is_err());
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|byte| format!("{byte:02x}")).collect()
    }

    fn hex_decode(text: &str) -> Vec<u8> {
        (0..text.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&text[index..index + 2], 16).unwrap())
            .collect()
    }

    fn base64_decode(text: &str) -> Vec<u8> {
        const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut bits = 0u32;
        let mut buffer = 0u32;
        let mut bytes = Vec::new();
        for byte in text.bytes().filter(|byte| *byte != b'=') {
            let value = TABLE.iter().position(|candidate| *candidate == byte).unwrap() as u32;
            buffer = (buffer << 6) | value;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                bytes.push(((buffer >> bits) & 0xff) as u8);
            }
        }
        bytes
    }
}
