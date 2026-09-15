//! Client half of the desktop Host carrier: one supervised Node process, its
//! framed request/response streams, and the request bridge for the webview.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::mpsc::{sync_channel, Receiver, Sender, SyncSender};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};

use crate::host::frame::{
    encode_request_cancel, encode_request_control, encode_request_data, encode_request_end,
    encode_request_start, ResponseDecoder, ResponseEvent, ResponseFrame,
};

/// Upper bound on the Host boot handshake.
const READY_TIMEOUT: Duration = Duration::from_secs(180);
/// Frames queued for the writer before the request path blocks.
const WRITE_QUEUE_DEPTH: usize = 256;
/// Grace period between the shutdown control frame and the forced kill.
const KILL_GRACE: Duration = Duration::from_secs(10);

/// Ready facts reported by one installed Host.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostReady {
    /// Installed dsh version the Host composed.
    pub dsh_version: String,
}


/// Supervised connection to the installed desktop Host.
pub struct HostClient {
    child: Mutex<Child>,
    writes: Mutex<Option<SyncSender<Vec<u8>>>>,
    streams: Arc<Mutex<HashMap<u32, Sender<ResponseFrame>>>>,
    failure: Arc<Mutex<Option<String>>>,
    stopping: Arc<AtomicBool>,
    next_stream_id: AtomicU32,
    next_control_id: AtomicU32,
    /// Installed dsh version the Host composed.
    pub dsh_version: String,
}

impl HostClient {
    /**
     * Spawn the Host and resolve once it reports readiness.
     * @param program - bundled upstream Node.js executable.
     * @param entry - the installed `@deepseek-ai/dsh-desktop-host` entry script.
     * @param runtime_dir - immutable dsh packages carried by the application.
     * @param project_dir - active desktop plugin profile.
     * @param environment - child environment; desktop and package-manager overrides are replaced.
     * @param on_failure - receives the first fatal Host or transport failure.
     * @returns the ready client.
     */
    pub fn start(
        program: &str,
        entry: &std::path::Path,
        runtime_dir: &std::path::Path,
        project_dir: &std::path::Path,
        allow_linked: bool,
        environment: Vec<(String, String)>,
        on_failure: impl Fn(String) + Send + 'static,
    ) -> Result<Self, String> {
        let mut command = Command::new(program);
        command
            .arg(entry)
            .arg(runtime_dir)
            .arg(project_dir)
            .current_dir(project_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if allow_linked {
            command.arg("--allow-linked-profile");
        }
        for (name, value) in environment {
            command.env(name, value);
        }
        let mut child = command.spawn().map_err(|error| format!("failed to spawn the dsh Host: {error}"))?;
        let stdin = child.stdin.take().ok_or("the dsh Host has no request stream")?;
        let stdout = child.stdout.take().ok_or("the dsh Host has no response stream")?;
        let stderr = child.stderr.take().ok_or("the dsh Host has no log stream")?;

        let streams: Arc<Mutex<HashMap<u32, Sender<ResponseFrame>>>> = Arc::new(Mutex::new(HashMap::new()));
        let failure: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let (ready_tx, ready_rx) = mpsc::channel::<Result<HostReady, String>>();
        let (write_tx, write_rx) = sync_channel::<Vec<u8>>(WRITE_QUEUE_DEPTH);

        let ready_state = Arc::new(Mutex::new(None::<Result<HostReady, String>>));
        let stopping = Arc::new(AtomicBool::new(false));
        spawn_reader(
            stdout,
            Arc::clone(&streams),
            Arc::clone(&failure),
            Arc::clone(&ready_state),
            Arc::clone(&stopping),
            ready_tx,
            on_failure,
        );
        spawn_writer(stdin, write_rx)?;
        spawn_logs(stderr);

        match ready_rx.recv_timeout(READY_TIMEOUT) {
            Ok(Ok(ready)) => Ok(Self {
                child: Mutex::new(child),
                writes: Mutex::new(Some(write_tx)),
                streams,
                failure,
                stopping,
                next_stream_id: AtomicU32::new(1),
                next_control_id: AtomicU32::new(1),
                dsh_version: ready.dsh_version,
            }),
            Ok(Err(error)) => {
                let _ = child.kill();
                Err(error)
            }
            Err(_) => {
                let _ = child.kill();
                Err(format!("the dsh Host did not report readiness within {}s", READY_TIMEOUT.as_secs()))
            }
        }
    }

    /// Open one request stream; the caller writes the body and reads the response.
    /// @param url - request URL the Host routes on its path.
    /// @param method - HTTP method in upper case.
    /// @param headers - request headers in order.
    /// @param has_body - whether the caller writes body frames before the end frame.
    /// @returns the stream id paired with its response frames.
    pub fn open(
        &self,
        url: &str,
        method: &str,
        headers: &[(String, String)],
        has_body: bool,
    ) -> Result<(u32, Receiver<ResponseFrame>), String> {
        if let Some(error) = self.failure.lock().unwrap().clone() {
            return Err(error);
        }
        let stream_id = self.next_stream_id.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = mpsc::channel();
        self.streams.lock().unwrap().insert(stream_id, tx);
        self.write(encode_request_start(stream_id, url, method, headers, has_body))?;
        Ok((stream_id, rx))
    }

    /// Write one bounded body chunk for an open stream.
    /// @param stream_id - stream returned by [`HostClient::open`].
    /// @param data - raw bytes; callers split at the frame chunk size.
    /// @returns the transport failure, when the write cannot be queued.
    pub fn write_body(&self, stream_id: u32, data: &[u8]) -> Result<(), String> {
        self.write(encode_request_data(stream_id, data))
    }

    /// Complete the request body of an open stream.
    /// @param stream_id - stream returned by [`HostClient::open`].
    /// @returns the transport failure, when the frame cannot be queued.
    pub fn end_body(&self, stream_id: u32) -> Result<(), String> {
        self.write(encode_request_end(stream_id))
    }

    /// Cancel one request and release its response channel.
    /// @param stream_id - stream to cancel.
    pub fn cancel(&self, stream_id: u32) {
        self.streams.lock().unwrap().remove(&stream_id);
        let _ = self.write(encode_request_cancel(stream_id));
    }

    /// Release one response channel after its last frame arrived.
    /// @param stream_id - stream whose response completed.
    pub fn release(&self, stream_id: u32) {
        self.streams.lock().unwrap().remove(&stream_id);
    }

    /// Ask the Host to stop, then wait for its exit and escalate.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        let control_id = self.next_control_id.fetch_add(1, Ordering::SeqCst);
        let _ = self.write(encode_request_control(control_id, "shutdown"));
        // Closing the parent-owned write end releases a pending read either way.
        *self.writes.lock().unwrap() = None;
        let deadline = Instant::now() + KILL_GRACE;
        if let Ok(mut child) = self.child.lock() {
            while Instant::now() < deadline {
                match child.try_wait() {
                    Ok(Some(_)) => return,
                    Ok(None) => std::thread::sleep(Duration::from_millis(50)),
                    Err(_) => break,
                }
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    fn write(&self, frame: Vec<u8>) -> Result<(), String> {
        self.writes
            .lock()
            .unwrap()
            .as_ref()
            .ok_or("the dsh Host request stream is closed".to_string())?
            .send(frame)
            .map_err(|_| "the dsh Host request stream is closed".to_string())
    }
}

fn spawn_reader(
    mut stdout: ChildStdout,
    streams: Arc<Mutex<HashMap<u32, Sender<ResponseFrame>>>>,
    failure: Arc<Mutex<Option<String>>>,
    ready_state: Arc<Mutex<Option<Result<HostReady, String>>>>,
    stopping: Arc<AtomicBool>,
    ready_tx: Sender<Result<HostReady, String>>,
    on_failure: impl Fn(String) + Send + 'static,
) {
    std::thread::spawn(move || {
        let mut decoder = ResponseDecoder::default();
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = match stdout.read(&mut buffer) {
                Ok(0) => break,
                Ok(read) => read,
                Err(error) => {
                    report(&failure, format!("the dsh Host response stream failed: {error}"));
                    break;
                }
            };
            let frames = match decoder.push(&buffer[..read]) {
                Ok(frames) => frames,
                Err(error) => {
                    report(&failure, error);
                    break;
                }
            };
            for frame in frames {
                match frame {
                    ResponseFrame::Event(ResponseEvent::Ready { dsh_version, .. }) => {
                        let ready = HostReady { dsh_version };
                        *ready_state.lock().unwrap() = Some(Ok(ready.clone()));
                        if ready_tx.send(Ok(ready)).is_err() {
                            // The shell already stopped waiting for readiness.
                        }
                    }
                    ResponseFrame::Event(ResponseEvent::Fatal { message }) => {
                        let error = format!("the dsh Host reported a fatal error: {message}");
                        if ready_state.lock().unwrap().is_none() {
                            *ready_state.lock().unwrap() = Some(Err(error.clone()));
                            let _ = ready_tx.send(Err(error.clone()));
                        }
                        report(&failure, error);
                    }
                    other => {
                        if let Some(stream_id) = stream_of(&other) {
                            let sender = streams.lock().unwrap().get(&stream_id).cloned();
                            if let Some(sender) = sender {
                                let _ = sender.send(other);
                            }
                        }
                    }
                }
            }
        }
        if decoder.finish().is_err() {
            report(&failure, "the dsh Host response stream ended inside a frame".into());
        }
        let before_ready = {
            let mut guard = ready_state.lock().unwrap();
            if guard.is_none() {
                *guard = Some(Err("the dsh Host stopped before readiness".into()));
                true
            } else {
                false
            }
        };
        if before_ready {
            let _ = ready_tx.send(Err("the dsh Host stopped before readiness".into()));
        }
        streams.lock().unwrap().clear();
        // An exit the shell asked for is not a failure.
        if !stopping.load(Ordering::SeqCst) {
            let detail = "the dsh Host stopped".to_string();
            if report(&failure, detail.clone()) {
                on_failure(detail);
            }
        }
    });
}

fn spawn_writer(mut stdin: ChildStdin, writes: Receiver<Vec<u8>>) -> Result<(), String> {
    std::thread::spawn(move || {
        while let Ok(frame) = writes.recv() {
            if stdin.write_all(&frame).is_err() {
                return;
            }
        }
        let _ = stdin.flush();
    });
    Ok(())
}

fn spawn_logs(mut stderr: std::process::ChildStderr) {
    std::thread::spawn(move || {
        let mut buffer = vec![0u8; 16 * 1024];
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) | Err(_) => return,
                Ok(read) => {
                    let _ = std::io::stderr().write_all(&buffer[..read]);
                }
            }
        }
    });
}

fn stream_of(frame: &ResponseFrame) -> Option<u32> {
    match frame {
        ResponseFrame::Start { stream_id, .. }
        | ResponseFrame::Data { stream_id, .. }
        | ResponseFrame::End { stream_id }
        | ResponseFrame::Error { stream_id, .. } => Some(*stream_id),
        ResponseFrame::Event(_) | ResponseFrame::ControlResult { .. } => None,
    }
}

/// Record the first failure and report whether this call recorded it.
fn report(failure: &Arc<Mutex<Option<String>>>, message: String) -> bool {
    let mut guard = failure.lock().unwrap();
    if guard.is_some() {
        return false;
    }
    *guard = Some(message);
    true
}
